/**
 * The three messages the pinned card posts into a marketplace chat (wallet
 * spec 8.2, Chat, and 8.7; 2026-11-19,
 * forclaude/wallet-chat-and-passkey-plan-1.md), known by their words, so
 * that the conversation and the chat list can draw them for the chat's two
 * traders as short grey lines: the buyer's account ("Send my account"), and
 * the news of the chat's trade, started or released. The three sentences
 * come from the dictionaries (wallet spec 8.8), in every language of the
 * wallet, so this file holds no words of its own.
 */
import { en, type Words } from './i18n/en';
import { th } from './i18n/th';

/** What a message of a marketplace chat is when the pinned card posted it: the buyer's account ("Send my account"), or the news of the chat's trade, started or released. */
export type TradeMessageKind = 'account' | 'trade';

/** Every language the wallet can post in. A new language joins this list. */
const DICTIONARIES: Words[] = [en, th];

const ACCOUNT_ID = '[0-9a-f]{64}';
const AMOUNT = '[0-9]+(?:\\.[0-9]{1,6})?';

/** A dictionary sentence as a pattern for a whole message: its fixed words as they are, and, where a value stood, that value's pattern. `values` holds each placeholder the sentence was made with and the pattern that takes its place. */
function patternOf(sentence: string, values: [string, string][]): RegExp {
  let source = sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [placeholder, pattern] of values) source = source.replace(placeholder, pattern);
  return new RegExp(`^${source}$`, 'i');
}

const ACCOUNT_PATTERNS = DICTIONARIES.map((words) => patternOf(words.pinned.shareMessage('\u0001'), [['\u0001', ACCOUNT_ID]]));

const TRADE_PATTERNS = DICTIONARIES.flatMap((words) =>
  [words.pinned.startedMessage, words.pinned.releasedMessage].map((make) =>
    patternOf(make('\u0001', '\u0002', '\u0003', '\u0004'), [
      ['\u0001', AMOUNT],
      ['\u0002', ACCOUNT_ID],
      ['\u0003', ACCOUNT_ID],
      ['\u0004', ACCOUNT_ID],
    ]),
  ),
);

/**
 * What a decrypted message is when it has the words of one of the three
 * messages the pinned card posts, in any language of the wallet; null for
 * every other text. The match is on the whole text. A person can type the
 * same words by hand, so the answer says how a message is drawn and
 * nothing about a trade.
 */
export function tradeMessageKind(text: string): TradeMessageKind | null {
  const whole = text.trim();
  if (ACCOUNT_PATTERNS.some((pattern) => pattern.test(whole))) return 'account';
  if (TRADE_PATTERNS.some((pattern) => pattern.test(whole))) return 'trade';
  return null;
}
