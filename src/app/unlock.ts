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
 * the landing page, by setup, which unlocks first when the PRF output is
 * not in RAM, by the finish of a recovery (Get back in) and, since
 * 2026-11-18, by the walk-through in front of the locked-out stepper
 * (find-passkey.component.ts). Returns the status; throws with the reason
 * on any refusal.
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
 * Since 2026-11-20 (masterpod spec 22; wallet spec 4.11) a login of a
 * vouched anoPod whose setup is complete ends by storing the first key
 * blob of each anos account that has none yet (storeFirstKeyBlobs, below).
 * Nothing there stops the login or changes what is returned.
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
  if (status.body.vouched && status.body.setupComplete) await storeFirstKeyBlobs({ api, crypto, passkey, session });
  return status.body;
}

/**
 * The first key blobs (2026-11-20, masterpod spec 22; wallet spec 4.11).
 * Until 2026-11-20 an account had one blob at the masterpod, with pair one
 * and pair two in it, and every login got it. Now the masterpod hands the
 * wallet a blob with pair one alone, the first key blob, and keeps the
 * blob with both pairs to itself. An account made before has no first key
 * blob yet, and this makes it, at the login: for each account the
 * masterpod lists with firstKeyOnly false, the blob with both pairs is
 * opened, pair one's two secrets are wrapped again alone, and the new
 * blob is checked before it is sent: it must open to the two public keys
 * the account's creation names as key1 and postQuantumKey1. Then
 * /store-first-key-blob. The masterpod writes it once and never touches
 * the blob with both pairs. After a store the list is read again, so the
 * session keeps first key blobs only. An account whose blob does not open
 * (a lost account), one whose check fails and one the masterpod refuses
 * are left as they are, for the next login. Nothing here stops a login:
 * every failure is passed over.
 */
async function storeFirstKeyBlobs({ api, crypto, session }: UnlockServices): Promise<void> {
  const keyBlobKey = session.getKeyBlobKey();
  if (!keyBlobKey) return;
  try {
    const listed = await api.listAnosAccounts(true);
    if (!listed.ok) return;
    let stored = false;
    for (const account of listed.body.accounts) {
      if (account.firstKeyOnly !== false) continue;
      try {
        const secrets = await crypto.unwrapKeyBlob(crypto.fromHex(account.keyBlob), keyBlobKey);
        const blob = await crypto.wrapFirstKeyBlob(secrets, keyBlobKey);
        const pairOne = await crypto.pairOneFromKeyBlob(blob, keyBlobKey);
        const named = account.creation.payload['publicKeys'] as Record<string, unknown> | undefined;
        if (crypto.toHex(pairOne.key1.publicKey) !== named?.['key1'] || crypto.toHex(pairOne.postQuantumKey1.publicKey) !== named?.['postQuantumKey1']) continue;
        const res = await api.storeFirstKeyBlob(account.accountId, crypto.toHex(blob));
        if (res.ok || res.status === 409) stored = true;
      } catch {
        // A blob that does not open, or anything else: this account is left for the next login.
      }
    }
    if (!stored) {
      session.accounts.set(listed.body.accounts);
      return;
    }
    const again = await api.listAnosAccounts(true);
    if (again.ok) session.accounts.set(again.body.accounts);
  } catch {
    // Nothing here stops a login.
  }
}
