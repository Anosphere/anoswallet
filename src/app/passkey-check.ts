/**
 * The passkey check before the wallet signs with an account's key (wallet
 * spec 8.9; 2026-11-19, forclaude/wallet-chat-and-passkey-plan-1.md): one
 * function, as unlock.ts is, and since 2026-11-20 a second one beside it
 * (forclaude/second-key-and-signing-passkey-plan-1.md). A button that
 * ends in something signed with an account's key asks the device for the
 * passkey that opened the session, and goes on only when that passkey
 * answers.
 * checkSessionPasskey is the check of 2026-11-19. Two callers are left to
 * it: the confirmation box (confirm-dialog.component.ts) calls it from
 * its second button in the box before a new anos account, and a
 * moderator's Sign calls it as the first thing its click does. There it
 * is a lock on the button, checked by the wallet itself and not by a
 * server.
 * askSigningPasskey is for every other button, since 2026-11-20: the
 * thing is built first, the passkey answers for the exact thing that was
 * built, and a signing server has the masterpod check the answer before
 * it signs. The boxes that ask for the passkey run it from their second
 * button, inside the step the page gives them (`approve`): the Send box
 * and the cancel of a locked transfer on the account page, Release,
 * Dispute and Cancel of an escrow trade, and the Start box of "Put the
 * anos in escrow" in the chat's card. The buttons that sign without a box
 * call it once the thing is built: the cancel of an assisted transfer, a
 * guardian's fund proposal and vote, and the attestors' three sign-offs.
 * The sentences of both come from the dictionary (wallet spec 8.8, the
 * group passkeyCheck).
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
 * the wallet's own, a lock on a button. Since 2026-11-20 two callers are
 * left: the box before a new anos account (the confirmation box's second
 * button) and a moderator's Sign. Every other button asks with
 * askSigningPasskey below.
 */
export async function checkSessionPasskey(services: PasskeyCheckServices, words: Words): Promise<void> {
  await askSessionPasskey(services, words, services.crypto.randomHex(32));
}

/** What goes to a signing server with everything it signs but a creation (2026-11-20, wallet spec 3): the passkey's answer, the WebAuthn JSON without its PRF results as PasskeyService hands it back, and the fingerprints the answer was given for. */
export interface SigningPasskey {
  assertion: Record<string, unknown>;
  covers: string[];
}

/**
 * The passkey answer for the signing servers (2026-11-20, wallet spec 3
 * and 8.9; forclaude/second-key-and-signing-passkey-plan-1.md). `payloads`
 * are the payloads of what one click has just built and signed with pair
 * one: one transfer, proposal or follow-up, or the several attestations
 * of "Sign all attestations". The device is asked for the passkey that
 * opened this session, once, and the challenge it answers is worked out
 * from the fingerprints of those payloads (CryptoService.signingChallenge),
 * so the answer is good for exactly these and for nothing else. The
 * wallet's own check of the answer is the one of checkSessionPasskey, and
 * so are the sentences it throws. Resolves with what SigningService.sign
 * sends along with each of them. A signing server has the masterpod check
 * the answer before it signs.
 */
export async function askSigningPasskey(services: PasskeyCheckServices, words: Words, payloads: object[]): Promise<SigningPasskey> {
  const covers = payloads.map((payload) => services.crypto.fingerprint(payload));
  const answer = await askSessionPasskey(services, words, services.crypto.signingChallenge(covers));
  return { assertion: answer.assertion, covers };
}

/** The one ask of both functions above: the passkey that opened the session, that one alone, by its credential id, with `challengeHex` as the challenge; the wallet's own check of the answer, that the credential id and the PRF output are the ones the session kept at Log in; and the dictionary's sentence thrown when it does not pass. Resolves with the answer. */
async function askSessionPasskey({ crypto, passkey, session }: PasskeyCheckServices, words: Words, challengeHex: string): Promise<Assertion> {
  const credentialId = session.passkeyCredentialId();
  const known = session.getPrfOutput();
  if (credentialId === null || known === null) throw new Error(words.passkeyCheck.noSession);
  let answer: Assertion;
  try {
    answer = await passkey.assert(challengeHex, { id: crypto.fromHex(credentialId), transports: [] });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') throw new Error(words.passkeyCheck.notFinished);
    throw new Error(words.passkeyCheck.failed(err instanceof Error ? err.message : String(err)));
  }
  if (crypto.toHex(answer.rawId) !== credentialId || crypto.toHex(answer.prfOutput) !== crypto.toHex(known)) {
    throw new Error(words.passkeyCheck.otherPasskey);
  }
  return answer;
}
