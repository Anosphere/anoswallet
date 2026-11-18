import { CryptoService } from './services/crypto.service';
import { reasonOf } from './services/log.service';
import { MasterpodApiService } from './services/masterpod-api.service';
import { Bytes, PasskeyService } from './services/passkey.service';
import { SessionService, StatusAnswer } from './services/session.service';

/** The services an unlock needs; a page injects them and hands them over. */
export interface UnlockServices {
  api: MasterpodApiService;
  crypto: CryptoService;
  passkey: PasskeyService;
  session: SessionService;
}

/**
 * The unlock flow (wallet spec 8.2, Landing): /challenge (unlock), the
 * passkey assertion with the PRF salt, /unlock; the key blob key from the
 * PRF output (2026-11-08, wallet spec 7); opens blob1, chatPrivateKeyBlob
 * and identityBlob; then /check-anopod-status. Shared by
 * the landing page and by setup, which unlocks first when the PRF output is
 * not in RAM. Returns the status; throws with the reason on any refusal.
 * Since 2026-11-18 (masterpod spec 19) any passkey of the anoPod unlocks
 * it, the main one or an added one. The payload says addedPasskeys: true
 * (the old page guard: the masterpod refuses an added passkey without it,
 * and an older masterpod ignores the field), and the credential id of the
 * passkey that signed is kept in the session. The key blob key is the
 * anoPod's one key either way: the main passkey makes it from its PRF
 * output, as before; for an added passkey the masterpod answers that
 * passkey's own copy, wrappedKeyBlobKey, which opens under a key from its
 * PRF output (deriveKekKeysWrap). A copy that does not open throws, and no
 * key is made in its place.
 */
export async function unlockWithPasskey({ api, crypto, passkey, session }: UnlockServices): Promise<StatusAnswer> {
  const challenge = await api.challenge('unlock');
  if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
  const { assertion, prfOutput, rawId } = await passkey.assert(challenge.body.challenge);
  const keys = crypto.generateSessionKeys();
  const payload = {
    challenge: challenge.body.challenge,
    assertion,
    ephemeralAuthKey: crypto.toHex(keys.ecdsa.publicKey),
    ephemeralAuthKeyPq: crypto.toHex(keys.mldsa.publicKey),
    addedPasskeys: true,
  };
  const res = await api.unlock({ payload, signatures: crypto.signPayload(keys, payload) });
  if (!res.ok) throw new Error(`/unlock: ${reasonOf(res)}`);

  session.open(res.body.anopodId, keys, res.body.username);
  session.passkeyCredentialId.set(crypto.toHex(rawId));
  session.setPrfOutput(prfOutput);
  let keyBlobKey: Bytes;
  if (res.body.wrappedKeyBlobKey) {
    try {
      keyBlobKey = await crypto.decrypt(await crypto.deriveKekKeysWrap(prfOutput), crypto.fromHex(res.body.wrappedKeyBlobKey));
    } catch {
      throw new Error('/unlock: this passkey\'s copy of the key blob key does not open');
    }
  } else {
    keyBlobKey = await crypto.deriveKekKeys(prfOutput);
  }
  session.setKeyBlobKey(keyBlobKey);
  if (res.body.setupComplete && res.body.blob1) {
    const kek = await crypto.deriveKekPrf(prfOutput);
    const encryptionKey = await crypto.decrypt(kek, crypto.fromHex(res.body.blob1));
    session.setEncryptionKey(encryptionKey);
    if (res.body.chatPrivateKeyBlob) {
      session.setChatKeys(await crypto.unwrapChatPrivateKey(crypto.fromHex(res.body.chatPrivateKeyBlob), encryptionKey));
    }
    if (res.body.identityBlob) {
      session.setIdentity(await crypto.unwrapIdentity(crypto.fromHex(res.body.identityBlob), encryptionKey));
    }
  }
  const profile = await api.getAnopodProfile(res.body.anopodId, true);
  if (profile.ok) {
    session.firstName.set(profile.body.firstName);
    session.lastName.set(profile.body.lastName);
  }
  const status = await api.checkAnopodStatus();
  if (!status.ok) throw new Error(`/check-anopod-status: ${reasonOf(status)}`);
  session.status.set(status.body);
  return status.body;
}
