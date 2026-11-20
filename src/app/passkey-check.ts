/**
 * The passkey check before the wallet signs with an account's key (wallet
 * spec 8.9; 2026-11-19, forclaude/wallet-chat-and-passkey-plan-1.md): one
 * function, as unlock.ts is. A button that ends in something signed with
 * an account's key first asks the device for the passkey that opened the
 * session, and goes on only when that passkey answers. The confirmation
 * box (confirm-dialog.component.ts) calls it from its second button, in
 * the boxes that ask for it, the Start box of "Put the anos in escrow"
 * in the chat's card among them. The buttons that sign without a box
 * call it as the first thing their click does: the cancel of an assisted
 * transfer, a guardian's fund proposal and vote, the attestors' three
 * sign-offs and a moderator's Sign. It is a lock on the button, checked
 * by the wallet itself and not by a server. Its sentences come from the
 * dictionary (wallet spec 8.8, the group passkeyCheck).
 */
import type { Words } from './i18n/en';
import { CryptoService } from './services/crypto.service';
import { Assertion, PasskeyService } from './services/passkey.service';
import { SessionService } from './services/session.service';

/** The services the passkey check needs; a component injects them and hands them over, as for unlock.ts. */
export interface PasskeyCheckServices {
  crypto: CryptoService;
  passkey: PasskeyService;
  session: SessionService;
}

/**
 * The passkey check before the wallet signs with an account's key (wallet
 * spec 8.9). The device is asked for the passkey that opened this session,
 * that one alone, by its credential id, with a fresh random challenge. It
 * resolves when that passkey answered: the credential id and the PRF
 * output are the ones the session kept at Log in. Otherwise it throws an
 * Error with the dictionary's sentence: the person closed the device's
 * passkey sheet or it ran out of time (notFinished), anything else the
 * device or the browser said (failed), another passkey answered
 * (otherPasskey), or the session holds no credential id or no PRF output
 * (noSession). Nothing goes to a server and nothing is kept: the check is
 * the wallet's own, a lock on a button. It must be called straight from
 * the click that asks for it, before any other wait: Safari opens the
 * passkey sheet only for a tap.
 */
export async function checkSessionPasskey({ crypto, passkey, session }: PasskeyCheckServices, words: Words): Promise<void> {
  const credentialId = session.passkeyCredentialId();
  const known = session.getPrfOutput();
  if (credentialId === null || known === null) throw new Error(words.passkeyCheck.noSession);
  let answer: Assertion;
  try {
    answer = await passkey.assert(crypto.randomHex(32), { id: crypto.fromHex(credentialId), transports: [] });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') throw new Error(words.passkeyCheck.notFinished);
    throw new Error(words.passkeyCheck.failed(err instanceof Error ? err.message : String(err)));
  }
  if (crypto.toHex(answer.rawId) !== credentialId || crypto.toHex(answer.prfOutput) !== crypto.toHex(known)) {
    throw new Error(words.passkeyCheck.otherPasskey);
  }
}
