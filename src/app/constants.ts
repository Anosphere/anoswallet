/**
 * The wallet's local constants (wallet spec sections 7 and 8).
 */

/**
 * Time locks on a guarded and on a vault account, in minutes: the
 * validators' GUARDED_LOCK_MINUTES and VAULT_LOCK_MINUTES (1 and 2 locally;
 * a week and a month in production), and LOCK_OFFSET_MINUTES (1 locally, 10
 * in production), added so a transfer that takes a while to reach a
 * validator is still at least the lock ahead. The wallet dates a guarded or
 * vault transfer lock + offset ahead.
 */
export const GUARDED_LOCK_MINUTES = 1;
export const VAULT_LOCK_MINUTES = 2;
export const LOCK_OFFSET_MINUTES = 1;

/** The PRF salt label: SHA-256 of it is the 32-byte prf.eval.first at every passkey ceremony. Public; it only labels the key. */
export const PRF_SALT_LABEL = 'masterpod/prf-salt/v1';

/** The polls: notifications (and the status with them), chat messages, an account waiting for the ledger. */
export const NOTIFICATIONS_POLL_MS = 5_000;
export const MESSAGES_POLL_MS = 3_000;
export const ACCOUNT_POLL_MS = 5_000;

/** A conversation opens with this many of its newest messages and loads older ones by as many (wallet spec 8.2, Chat). */
export const MESSAGES_PAGE = 50;

/** The attesting lists, the two attestor case pages and My case refresh this often while open (wallet spec 13.3). */
export const CASES_POLL_MS = 15_000;

/** The username check while typing. */
export const USERNAME_DEBOUNCE_MS = 400;

/** The activity log keeps the newest calls, polls excepted. */
export const LOG_MAX_ENTRIES = 40;

/** Strings longer than this are cut in the log, so a selfie does not fill the page. */
export const LOG_STRING_MAX = 120;

/** Millionths of an anos in one anos: every amount on the wire is millionths as a decimal string. */
export const MILLIONTHS_PER_ANOS = 1_000_000n;
