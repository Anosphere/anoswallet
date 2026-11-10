/**
 * The wallet's local constants (wallet spec sections 7 and 8).
 */

/** The PRF salt label: SHA-256 of it is the 32-byte prf.eval.first at every passkey ceremony. Public; it only labels the key. */
export const PRF_SALT_LABEL = 'masterpod/prf-salt/v1';

/** The polls: notifications (and the status with them), chat messages, an account waiting for the ledger, the seed's Vouch requests page (it re-reads its list this often while open). */
export const NOTIFICATIONS_POLL_MS = 5_000;
export const MESSAGES_POLL_MS = 3_000;
export const ACCOUNT_POLL_MS = 5_000;
export const VOUCH_REQUESTS_POLL_MS = 5_000;

/** The profile cache keeps at most this many /get-anopod-profile reads in flight, so a page with many faces gets them a few at a time (wallet spec 8.3). */
export const PROFILE_READS_AT_ONCE = 5;

/** A conversation opens with this many of its newest messages and loads older ones by as many (wallet spec 8.2, Chat). */
export const MESSAGES_PAGE = 50;

/** The transaction history opens with this many of the newest rows and Show more loads as many (wallet spec 8.2, Transaction history). */
export const HISTORY_PAGE = 20;

/** The pinned listing card reads a chat's messages for their account ids this many at a time, the most /list-messages answers (wallet spec 8.2, Chat, and 8.7). */
export const CARD_MESSAGES_PAGE = 200;

/** The pinned listing card reads an account's transactions since the chat was made this many at a time, the most /list-transactions answers (wallet spec 8.2, Chat). */
export const CARD_TRANSACTIONS_PAGE = 200;

/** The attesting lists, the two attestor case pages and My case refresh this often while open (wallet spec 13.3). */
export const CASES_POLL_MS = 15_000;

/** How long one keyholder has to answer a deposit call, the receiving-key fetch or the share (wallet spec 6), and since 2026-11-08 the owner lookup of a locked-out person (12.3): a stopped VM otherwise holds the deposit for the proxy's two minutes. */
export const KEYHOLDER_DEPOSIT_TIMEOUT_MS = 15_000;

/** The username check while typing. */
export const USERNAME_DEBOUNCE_MS = 400;

/** The confirmation box's own button (Send, Create anos account) cannot be pressed for this long after the box opens, so the second click of a double click on the page's button never lands on it (wallet spec 8.9). */
export const CONFIRM_ARM_MS = 500;

/** The activity log keeps the newest calls, polls excepted. */
export const LOG_MAX_ENTRIES = 40;

/** Strings longer than this are cut in the log, so a selfie does not fill the page. */
export const LOG_STRING_MAX = 120;

/** Google's Advanced Protection page, opened in a new tab by the Protect your passkey pane and page (wallet spec 8.2). */
export const ADVANCED_PROTECTION_URL = 'https://landing.google.com/advancedprotection/';

/** Millionths of an anos in one anos: every amount on the wire is millionths as a decimal string. */
export const MILLIONTHS_PER_ANOS = 1_000_000n;
