import { CryptoService } from './services/crypto.service';
import { reasonOf } from './services/log.service';
import { MasterpodApiService } from './services/masterpod-api.service';
import { PasskeyService } from './services/passkey.service';
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
 * passkey assertion with the PRF salt, /unlock; opens blob1,
 * chatPrivateKeyBlob and identityBlob; then /check-anopod-status. Shared by
 * the landing page and by setup, which unlocks first when the PRF output is
 * not in RAM. Returns the status; throws with the reason on any refusal.
 */
export async function unlockWithPasskey({ api, crypto, passkey, session }: UnlockServices): Promise<StatusAnswer> {
  const challenge = await api.challenge('unlock');
  if (!challenge.ok) throw new Error(`/challenge: ${reasonOf(challenge)}`);
  const { assertion, prfOutput } = await passkey.assert(challenge.body.challenge);
  const keys = crypto.generateSessionKeys();
  const payload = {
    challenge: challenge.body.challenge,
    assertion,
    ephemeralAuthKey: crypto.toHex(keys.ecdsa.publicKey),
    ephemeralAuthKeyPq: crypto.toHex(keys.mldsa.publicKey),
  };
  const res = await api.unlock({ payload, signatures: crypto.signPayload(keys, payload) });
  if (!res.ok) throw new Error(`/unlock: ${reasonOf(res)}`);

  session.open(res.body.anopodId, keys, res.body.username);
  session.setPrfOutput(prfOutput);
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
