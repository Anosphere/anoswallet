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

/** The first read of the notifications after a login brings this many of the newest rows, and so does a filter's first read and each tap on "Show older" of the Notifications page (wallet spec 4.22; 2026-11-25). */
export const NOTIFICATIONS_PAGE = 30;

/** The update check (wallet spec 8.1; 2026-11-22): how often the wallet asks its own server for the page again, while the page is on the screen, to see whether a newer build is there. It also asks when it starts and each time it comes back to the front. */
export const UPDATE_CHECK_MS = 300_000;

/** How long the wallet's own server has to answer before the update check or a refresh gives up (wallet spec 8.1; 2026-11-22). The page is loaded again only after the server has answered, so a phone with no connection keeps the page it has. */
export const REFRESH_WAIT_MS = 5_000;

/** The profile cache keeps at most this many /get-anopod-profile reads in flight, so a page with many faces gets them a few at a time (wallet spec 8.3). */
export const PROFILE_READS_AT_ONCE = 5;

/** A conversation opens with this many of its newest messages and loads older ones by as many (wallet spec 8.2, Chat). Since 2026-11-25 a room that the browser keeps a copy of does not open that way: its copy is drawn and the rows after it are read (room-copies.service; wallet spec 8.2, Chat). A room without a copy, and one whose copy was dropped, still opens with this many, and older ones still load by as many. */
export const MESSAGES_PAGE = 50;

/** The Members list of a conversation draws this many people at first, and as many more each time the reader comes near its end (wallet spec 8.2, Chat; 2026-11-22). */
export const MEMBERS_PAGE = 50;

/** Find public rooms reads this many rooms at a time, and Show more as many again (wallet spec 8.2, Chat; 2026-11-22). */
export const PUBLIC_ROOMS_PAGE = 50;

/** The search box over the public rooms and the name box of New public room read the masterpod this long after the last key (wallet spec 8.2, Chat; 2026-11-22). */
export const ROOM_SEARCH_DEBOUNCE_MS = 400;

/** New public room shows at most this many rooms whose name holds the typed one (wallet spec 8.2, Chat; 2026-11-22). */
export const LIKE_NAMED_ROOMS = 5;

/** A public room's picture goes out as the middle of the picked picture, a square of at most this many pixels, a JPEG at this factor: the public selfie's numbers (wallet spec 8.2, Chat; 2026-11-22). */
export const ROOM_PICTURE_SIDE = 320;
export const ROOM_PICTURE_JPEG = 0.8;

/** The room picture cache keeps at most this many /get-chat-room-picture reads in flight (wallet spec 8.3; 2026-11-22). */
export const ROOM_PICTURE_READS_AT_ONCE = 5;

/** A room picture read that failed is forgotten this long afterwards, and only then asked again (wallet spec 8.3; 2026-11-22). */
export const ROOM_PICTURE_RETRY_MS = 30_000;

/** The transaction history opens with this many of the newest rows and Show more loads as many (wallet spec 8.2, Transaction history). */
export const HISTORY_PAGE = 20;

/** The pinned listing card reads a chat's messages for their account ids this many at a time, the most /list-messages answers (wallet spec 8.2, Chat, and 8.7). */
export const CARD_MESSAGES_PAGE = 200;

/** The pinned listing card reads an account's transactions since the chat was made this many at a time, the most /list-transactions answers (wallet spec 8.2, Chat). */
export const CARD_TRANSACTIONS_PAGE = 200;

/** The attesting lists, the three attestor case pages, My case and My recovery case refresh this often while open (wallet spec 13.3). Since 2026-11-12 work-badge.service also reads the lists behind the numbers on the Attesting and the Moderation entries this often, in that edition, on every page but the entry's own (wallet spec 8.1, 8.3). */
export const CASES_POLL_MS = 15_000;

/** How long one keyholder has to answer a deposit call, the receiving-key fetch or the share (wallet spec 6), and since 2026-11-08 the owner lookup of a locked-out person (12.3): a stopped VM otherwise holds the deposit for the proxy's two minutes. */
export const KEYHOLDER_DEPOSIT_TIMEOUT_MS = 15_000;

/** How long a validator has to answer a read (wallet spec 8.3; decision 7 of forclaude/wallet-round-robin-plan-1.md): past it the read counts as not answered and is asked again on the next validator. Without a limit a read could be held for the proxy's two minutes before the wallet moves on. Since 2026-11-11 the proxy itself answers 502 after 10 seconds for a validator whose machine cannot be reached (validatorIdleMs in server/config.js); a call that is under way still has the two minutes. A submission has no limit. */
export const VALIDATOR_READ_TIMEOUT_MS = 10_000;

/** How long a signing server has to answer, the public keys or a signature (wallet spec 8.3; decision 18 of forclaude/signing-server-plan-1.md): past it the call counts as not answered and is made again on the other signing server. Without a limit a call could be held for the proxy's two minutes before the wallet moves on. */
export const SIGNING_TIMEOUT_MS = 15_000;

/** The username check while typing. */
export const USERNAME_DEBOUNCE_MS = 400;

/** The confirmation box's own button (Send, Stake, Create anos account, "Yes, cancel the transfer" and, since 2026-11-17, the second button of the escrow trade's five boxes: "Yes, release the anos", "Yes, dispute", "Yes, I have paid", "Something is wrong: dispute" and "Yes, cancel the trade") cannot be pressed for this long after the box opens, so the second click of a double click on the page's button never lands on it (wallet spec 8.9). */
export const CONFIRM_ARM_MS = 500;

/** The activity log keeps the newest calls, polls excepted. */
export const LOG_MAX_ENTRIES = 40;

/** Strings longer than this are cut in the log, so a selfie does not fill the page. */
export const LOG_STRING_MAX = 120;

/** Google's Advanced Protection page, opened in a new tab by the Protect your passkey pane and page (wallet spec 8.2). */
export const ADVANCED_PROTECTION_URL = 'https://landing.google.com/advancedprotection/';

/** Millionths of an anos in one anos: every amount on the wire is millionths as a decimal string. */
export const MILLIONTHS_PER_ANOS = 1_000_000n;

/** A guardian stake goes in whole multiples of this many anos (wallet spec 8.2, Account; 2026-11-12): it is the validators' GUARDIAN_VOTE_ANOS, the anos staked for one guardian vote. */
export const GUARDIAN_STAKE_STEP_ANOS = 1000;

/** What one message to Joy may carry at most (wallet spec 4.18; 2026-11-24): the masterpod's own limits for /ask-joy (its spec, section 30). A conversation is sent as its newest messages, at most this many of them. */
export const JOY_MAX_MESSAGES = 200;

/** The texts of the messages that are sent to Joy have at most this many bytes of UTF-8 together (wallet spec 4.18): the masterpod's limit for /ask-joy. */
export const JOY_MAX_CONVERSATION_BYTES = 120_000;

/** The memory file Joy keeps for a member has at most this many bytes of UTF-8 (wallet spec 4.18): the masterpod's limit. */
export const JOY_MEMORY_MAX_BYTES = 10_240;

/** How long Joy's answer may bring nothing before the wallet gives it up as cut off (wallet spec 4.18). The masterpod sends an empty line every 10 seconds while an answer is under way, so this long with nothing at all means that the connection is dead. */
export const JOY_SILENCE_MS = 60_000;
