import { Injectable, inject } from '@angular/core';
import { JOY_SILENCE_MS } from '../constants';
import { AttestationPayload, Envelope, EscrowVerdictPayload, FollowUp, HybridPublicKey, SignOffMessage, Signatures, Verdict } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, LinesRead, LogService } from './log.service';
import { CaseStatus, RecoveryPodAnswer } from './recovery.service';
import { AnosAccountItem, NotificationItem, SessionService, StatusAnswer } from './session.service';

export type { NotificationItem } from './session.service';

/** The proxy's path to the masterpod; the signed path stays the masterpod's own (wallet spec 2). */
const BASE = '/api/masterpod';

export interface Profile {
  anopodId: string;
  username: string;
  firstName: string;
  lastName: string;
  vouched: boolean;
  isSeed: boolean;
  isSuperSeed: boolean;
  selfie?: Image | null;
}

/** An image on the wire: the content type and the bytes as base64 (plaintext for a selfie and, since 2026-11-22, for a public room's picture; ciphertext in a bucket). */
export interface Image {
  contentType: string;
  image: string;
}

/** The purposes of /challenge: the two of masterpod spec 5, the three recovery ones of 12.4.2 and addPasskey of masterpod spec 19 (2026-11-18), which takes the id of the anoPod the passkey is added to and lives ten minutes. */
export type ChallengePurpose = 'create' | 'unlock' | 'openCase' | 'unlockCase' | 'recover' | 'addPasskey';

export interface ChallengeAnswer {
  challenge: string;
  anopodId?: string;
  /** openCase only (2026-11-08): the username of the pod the anoPod id names, shown as the account found. */
  username?: string;
  /** openCase only (2026-11-18): the credential ids of the pod's passkeys, hex, the main one first; a masterpod of before sends none. */
  credentialIds?: string[];
  expiresAt: string;
}

/** What /open-recovery-case answers (masterpod 12.4.2). */
export interface OpenRecoveryCaseAnswer {
  caseId: string;
  status: 'open';
  ephemeralExpiresAt: string;
}

/** What /unlock-recovery-pod answers (masterpod 12.4.2). */
export interface UnlockRecoveryPodAnswer {
  caseId: string;
  status: string;
  hybridKey: HybridPublicKey;
  hybridKeyBlob: string;
  ephemeralExpiresAt: string;
}

/** What /recover-with-backup-code answers (masterpod 12.4.2): the recovery passkey is the pod's passkey from here. */
export interface RecoverAnswer {
  anopodId: string;
  username: string;
  recovered: boolean;
}

/** What the rotation's proof signs (masterpod 12.4.5): the RFC 8785 canonical JSON of these four, anopodId the caller's, by the CURRENT backup code keys. */
export interface RotationMessage {
  anopodId: string;
  newBackupCodePublicKey: string;
  newBackupCodePublicKeyPq: string;
  newBlob2: string;
}

/** The body of /rotate-backup-code (masterpod 12.4.5): the new code's blob and keys with the proof by the old code. */
export interface RotateBackupCodeBody {
  newBlob2: string;
  newBackupCodePublicKey: string;
  newBackupCodePublicKeyPq: string;
  proof: Signatures;
}

/**
 * An anos account as /list-anos-accounts answers it since recovery build 3
 * (masterpod 12.4.5): the item with its breakGlassBlob, hex, which the
 * recovery's finish stored until 2026-11-08 and the wallet no longer writes
 * (break-glass plan 1, step 4: the recovered seed signs the move and is
 * wiped); null from now on, kept because the masterpod still answers it.
 * The item without it is session.service's AnosAccountItem, which is what
 * the session keeps.
 */
export interface AnosAccountListItem extends AnosAccountItem {
  breakGlassBlob: string | null;
}

/** One move of a break-glass case (masterpod 14.4.1): the old account whose keys were lost, the new account of the same type, the breakGlassTransfer's id, and when the finish filed it. */
export interface BreakGlassMove {
  accountId: string;
  accountIdTo: string;
  transactionId: string;
  accountType: string;
  createdAt: string;
}

/** One move as the recovery's finish files it (masterpod 14.4.1, /file-break-glass-moves): the old account, the new account of the same type, the breakGlassTransfer's id. */
export type BreakGlassMoveToFile = Pick<BreakGlassMove, 'accountId' | 'accountIdTo' | 'transactionId'>;

/** One event of the person's subset on a break-glass case (masterpod 14.4.1): scheduled (at, meetLink), decided ({}), sent ({}) or dismissed (reason only). */
export interface BreakGlassEvent {
  kind: 'scheduled' | 'decided' | 'sent' | 'dismissed' | string;
  details: Record<string, unknown>;
  createdAt: string;
}

/** A break-glass case as /list-my-break-glass-moves answers it (masterpod 14.4.1): the recovery case's id, a trade case's statuses, the count of attestor pods that signed, the moves in account order and the person's events. */
export interface BreakGlassCaseItem {
  caseId: string;
  status: AttestorCaseStatus;
  signOffs: number;
  moves: BreakGlassMove[];
  events: BreakGlassEvent[];
  createdAt: string;
  updatedAt: string;
}

/** The clear part of a note as /add-noted-transaction takes it (wallet spec 4.6): the ledger's facts and the encrypted private part, hex. */
export interface NoteFields {
  transactionId: string;
  accountId: string;
  otherAccountId: string | null;
  position: number;
  transactedAt: string;
  amount: string;
  sent: boolean;
  noteBlob: string;
}

/** One note as /list-noted-transactions answers it. */
export interface NotedTransactionItem extends NoteFields {
  noteId: string;
  createdAt: string;
  updatedAt: string;
}

/** The date range of /list-noted-transactions: ISO 8601, the start of the first day and the start of the day after the last. */
export interface NoteRange {
  from?: string;
  to?: string;
}

/** One message of a conversation with Joy as /ask-joy takes it (masterpod spec 30; 2026-11-24): who wrote it, the member (`user`) or Joy (`assistant`), and its text. */
export interface JoyMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** How an answer of Joy's ended, as the last line of /ask-joy's answer says it (masterpod spec 30): `end`, an answer that ended by itself; `length`, cut off where the model reached its limit; `refused`, stopped by the safety check of Anthropic, the company whose model writes Joy's answers. */
export type JoyStop = 'end' | 'length' | 'refused';

/** One web page that Joy used for an answer, as the last line of /ask-joy's answer names it (masterpod spec 32; wallet spec 4.20; 2026-11-24): the page's title, which is an empty text when the page gave none, and its address. */
export interface JoySource {
  title: string;
  url: string;
}

/** A picture that Joy had made for an answer, as one line of /ask-joy's answer brings it (masterpod spec 33; wallet spec 4.21; 2026-11-25): the picture's type (image/jpeg, image/png or image/webp), its bytes as base64, and the description that Joy wrote for it, 1 to 1,000 characters. */
export interface JoyPictureLine {
  type: string;
  data: string;
  description: string;
}


export interface CreateAnswer {
  anopodId: string;
  username: string;
  vouched: boolean;
  ephemeralExpiresAt: string;
  success: boolean;
}

export interface UnlockAnswer {
  anopodId: string;
  username: string;
  vouched: boolean;
  setupComplete: boolean;
  blob1: string | null;
  /** An added passkey's copy of the key blob key; null for the main passkey; an older masterpod sends no field. */
  wrappedKeyBlobKey?: string | null;
  chatPrivateKeyBlob: string | null;
  identityBlob: string | null;
  ephemeralExpiresAt: string;
}

/** One added passkey as /list-passkeys lists it and /add-passkey answers it (masterpod spec 19): the ids hex, createdAt ISO 8601. The wallet keys the passkey's name by passkeyId (settings.service). */
export interface AddedPasskeyItem {
  passkeyId: string;
  credentialId: string;
  createdAt: string;
}

/** What /list-passkeys answers (masterpod spec 19): the main passkey, the one on the anoPod's row, by its credential id alone, and the added ones, oldest first. */
export interface PasskeyList {
  main: { credentialId: string };
  added: AddedPasskeyItem[];
}

/** The body of /add-passkey (masterpod spec 19): the challenge of /challenge addPasskey, the WebAuthn JSON of the fresh tap of a passkey the anoPod has, the WebAuthn JSON of the new passkey's registration, and the new passkey's own copies of the encryption key (blob1) and of the key blob key, hex. */
export interface AddPasskeyBody {
  challenge: string;
  assertion: Record<string, unknown>;
  passkey: Record<string, unknown>;
  blob1: string;
  wrappedKeyBlobKey: string;
}

/** One email of a pod's security alerts as /list-alert-settings lists it (masterpod spec 25): emailId hex, the address in plain text, the language its emails are written in, confirmed once the six-digit code was typed back, createdAt ISO 8601, and removesAt, null or the moment the address comes off the list. */
export interface AlertEmailItem { emailId: string; email: string; language: 'en' | 'th'; confirmed: boolean; createdAt: string; removesAt: string | null }
/** One phone of a pod's security alerts as /list-alert-settings lists it (masterpod spec 25): phoneId hex; endpointHash, the SHA-256 of the phone's delivery address, hex, since the address itself is never answered; label, the kind of device (iphone, ipad, android, computer, other); createdAt ISO 8601; removesAt as for an email. */
export interface AlertPhoneItem { phoneId: string; endpointHash: string; label: string; createdAt: string; removesAt: string | null }
/** What /list-alert-settings answers (masterpod spec 25): the two lists, each oldest first; emailOn, false while the masterpod sends no email; pushPublicKey, the public half of the masterpod's key for the phones' delivery services as base64url, null while it sends no notification; the two limits; and removeMinutes, how long an email or a phone that was taken off still gets every alert. */
export interface AlertSettings { emails: AlertEmailItem[]; phones: AlertPhoneItem[]; emailOn: boolean; pushPublicKey: string | null; emailLimit: number; phoneLimit: number; removeMinutes: number }

export interface VouchRequestItem {
  vouchIdNumber: string;
  from: Profile;
  createdAt: string;
}

/** The eight fields of /complete-setup (wallet spec 4.1). */
export interface SetupFields {
  blob1: string;
  blob2: string;
  backupCodePublicKey: string;
  backupCodePublicKeyPq: string;
  chatPublicKey: string;
  chatPublicKeyPq: string;
  chatPrivateKeyBlob: string;
  identityBlob: string;
}

export interface SecurityRecords {
  images: { imageId: string; type: number; contentType: string; image: string; keyId: string; createdAt: string }[];
  info: { infoId: string; type: number; info: string; keyId: string; createdAt: string }[];
}

export interface RoomMember {
  anopodId: string;
  username: string;
  /** The highest message position this member has seen in the room (2026-11-19, masterpod spec 21). Only an entry of a room's `members` carries it: the invited and a listing's owner do not, and a masterpod of before sends none. Since 2026-11-24 (masterpod spec 29) it is as old as the room's entry in the list, which comes anew only when the room's people or facts change; for the conversation that is open, the page's own read of /list-messages keeps it fresh (SeenItem). */
  seenPosition?: number;
}

/** The listing a room is about, as /list-chat-rooms gives it (2026-11-06): the quantity in millionths and the price per anos, decimal strings; the owner by id and username. */
export interface RoomListing {
  listingId: string;
  side: 'buy' | 'sell';
  quantity: string;
  currency: string;
  country: string;
  price: string;
  status: 'open' | 'closed';
  owner: RoomMember;
}

/** The kind of attestor case a chat room is about, as /list-chat-rooms gives it (2026-11-12): an assisted transfer case, an escrow dispute case or a recovery case. */
export type CaseKind = 'trade' | 'dispute' | 'recovery';

export interface RoomItem {
  chatRoomId: string;
  type: 'private' | 'public' | 'marketplace';
  name: string | null;
  /** When the room's picture was last set, null for a room without one (2026-11-22, masterpod spec 27). A masterpod of before sends no such field: a missing one reads as null. */
  pictureAt?: string | null;
  listingId: string | null;
  /** The listing the room is about (an old marketplace room, or a private room made with a listingId), null for the others. */
  listing: RoomListing | null;
  /** The attestor case the room is about (a private room made with a caseId) and its kind, null for the others (2026-11-12). A masterpod of before sends neither field: a missing one reads as null. */
  caseId: string | null;
  caseKind: CaseKind | null;
  creatorAnopodId: string;
  hpkeKey: string;
  members: RoomMember[];
  /** The people invited who have not answered yet, oldest first. */
  invited: RoomMember[];
  /** The room's newest message, null when it has none. Since 2026-11-24 (masterpod spec 31) it is that message as it stands now, never an edit or a delete (LastMessage). */
  lastMessage: LastMessage | null;
  /** The highest position of any row of the room, 0 for a room with none. Since 2026-11-24 (masterpod spec 31) it is above `lastMessage.position` whenever the room's newest row is an edit or a delete. */
  lastPosition: number;
  createdAt: string;
}

export interface InviteItem {
  inviteId: string;
  chatRoomId: string;
  type: string;
  name: string | null;
  /** The listing the room is about, null for a room without one (2026-11-06). */
  listingId: string | null;
  listing: RoomListing | null;
  /** The attestor case the room is about and its kind, null for a room without one (2026-11-12). A masterpod of before sends neither field: a missing one reads as null. */
  caseId: string | null;
  caseKind: CaseKind | null;
  from: Profile;
  createdAt: string;
}

export interface JoinRequestItem {
  joinRequestId: string;
  chatRoomId: string;
  from: Profile;
  createdAt: string;
}

/** The chat list as the wallet keeps it in memory (session.chatRooms): every room this pod is in, the invites to this pod and the join requests on its rooms. Until 2026-11-24 it was also the type of /list-chat-rooms' answer; that is RoomsRead now. */
export interface RoomsAnswer {
  rooms: RoomItem[];
  invites: InviteItem[];
  joinRequests: JoinRequestItem[];
}

/** A room of which only the newest message is new, as /list-chat-rooms sends it to a request with `since` (2026-11-24, masterpod spec 29): three fields, where a room that is sent whole is a RoomItem. */
export interface RoomNews {
  chatRoomId: string;
  lastMessage: LastMessage | null;
  lastPosition: number;
}

/**
 * What /list-chat-rooms answers (2026-11-24, masterpod spec 29; wallet spec
 * 4.17). `seq` is the number to send as the next `since`, and `counts` is how
 * many rooms, invites and join requests this pod has now; a masterpod of
 * before sends neither, and its answer is always the whole list. To a request
 * without `since` the three lists are whole. To a request with `since` they
 * hold only what changed after it: a room whole (a RoomItem) when its people
 * or its facts changed, the three fields (a RoomNews) when only a message
 * came, and the invites and join requests written after it.
 */
export interface RoomsRead {
  seq?: number;
  counts?: { rooms: number; invites: number; joinRequests: number };
  rooms: (RoomItem | RoomNews)[];
  invites: InviteItem[];
  joinRequests: JoinRequestItem[];
}

/** What /list-public-chat-rooms takes (2026-11-22, masterpod spec 26): a search word matched anywhere in the name, how many rooms, and from which row on. */
export interface PublicRoomsQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PublicRoomItem {
  chatRoomId: string;
  name: string;
  /** When the room's picture was last set, null for a room without one (2026-11-22, masterpod spec 27). A masterpod of before sends no such field: a missing one reads as null. */
  pictureAt?: string | null;
  creator: Profile;
  memberCount: number;
  createdAt: string;
}

/**
 * One row of a room as /list-messages hands it out. Until 2026-11-24 every
 * row was a message. Since then (masterpod spec 31; wallet spec 4.19) a
 * row is a message, an edit or a delete: an edit carries a message's new
 * text, a delete carries none, and each names its message in
 * `targetMessageId`. A row comes without its ciphertext, `message` null,
 * once a later row of the room names the same message: a message that
 * was edited or deleted, an edit that a newer edit or a delete followed,
 * and every delete. A masterpod of before sends neither `kind` nor
 * `targetMessageId`, and a missing one reads as null: a message.
 */
export interface MessageItem {
  messageId: string;
  position: number;
  senderAnopodId: string;
  message: string | null;
  createdAt: string;
  kind?: 'edit' | 'delete' | null;
  targetMessageId?: string | null;
}

/**
 * A room's newest message as /list-chat-rooms gives it (2026-11-24,
 * masterpod spec 31; wallet spec 4.19): the message as it stands now,
 * never an edit or a delete. The id, the position, the sender and the time
 * are the message's own, so an edit or a delete moves none of them.
 * `message` is the newest edit's ciphertext for a message that was edited,
 * and null for one that was deleted. `editPosition` is the position of the
 * newest edit, null for a message that was never edited, and it stays what
 * it was when an edited message is deleted. `deleted` is true once a
 * delete names the message; a deleted newest message stays the room's
 * `lastMessage`. A masterpod of before sends neither of the two fields: a
 * missing `editPosition` reads as null and a missing `deleted` as false.
 */
export interface LastMessage {
  messageId: string;
  position: number;
  senderAnopodId: string;
  message: string | null;
  createdAt: string;
  editPosition?: number | null;
  deleted?: boolean;
}

/** The query of /list-messages: the messages after a position, or with `beforePosition` the newest `limit` below it, afterPosition then ignored. With `seenSince` (2026-11-24, masterpod spec 29) the answer also says which members' seen positions changed after that number: 0 asks for every member who has seen anything. */
export interface MessagesQuery {
  afterPosition?: number;
  beforePosition?: number;
  limit?: number;
  seenSince?: number;
}

/** How far one member of a room has read, as /list-messages answers it to a request with `seenSince` (2026-11-24, masterpod spec 29). */
export interface SeenItem {
  anopodId: string;
  seenPosition: number;
}

/** What /list-messages answers. `seen` and `seenSeq` come only to a request with `seenSince` (2026-11-24, masterpod spec 29): the members whose seen position changed after it, and the number to send as the next `seenSince`. A masterpod of before sends neither. */
export interface MessagesAnswer {
  messages: MessageItem[];
  seen?: SeenItem[];
  seenSeq?: number;
}

export interface ChatKeyItem {
  anopodId: string;
  chatPublicKey: string;
  chatPublicKeyPq: string;
}

/** The body of /create-listing: no room key since 2026-11-06, a listing has no room of its own. */
export interface ListingFields {
  side: 'buy' | 'sell';
  quantity: string;
  currency: string;
  country: string;
  price: string;
}

/** The body of /list-listings; `mine` restricts it to the caller's own listings and `status` takes `any` (2026-11-06). */
export interface ListingFilters {
  side?: string;
  currency?: string;
  country?: string;
  status?: 'open' | 'closed' | 'any';
  mine?: boolean;
  sortBy?: string;
  sortDirection?: string;
  limit?: number;
  offset?: number;
}

export interface ListingItem {
  listingId: string;
  /** The old marketplace room of a listing made before 2026-11-06, null since. */
  chatRoomId: string | null;
  owner: Profile;
  side: 'buy' | 'sell';
  quantity: string;
  currency: string;
  country: string;
  price: string;
  status: 'open' | 'closed';
  createdAt: string;
}

/** The body of /create-anos-account (wallet spec 4.4, and 4.11 since 2026-11-20): a new account brings both blobs, keyBlob, the one with both pairs, which the masterpod keeps, and firstKeyBlob, pair one alone, which it hands back to the wallet. */
export interface CreateAnosAccountBody {
  accountId: string;
  accountType: string;
  keyBlob: string;
  /** The account's first key blob, pair one alone (2026-11-20, masterpod spec 22). */
  firstKeyBlob: string;
  creation: { payload: object; signatures: Record<string, string | undefined> };
}

// --- level setup: DAO (masterpod spec 15) -------------------------------------

/** A proposal's status (masterpod 15.5): pending collects support, open takes votes, then accepted or rejected; expired missed its support and is hidden from the lists, its link still answered. */
export type DaoStatus = 'pending' | 'open' | 'accepted' | 'rejected' | 'expired';

/** The three lists of /list-dao-proposals; decided is accepted and rejected together. */
export type DaoListStatus = 'pending' | 'open' | 'decided';

/** The masterpod's dials (masterpod 15.7), answered with every list so the wallet's words carry the numbers: the votes a pod needs to post, the percent of all DAO votes that opens a vote, the percent of the votes cast that passes, the two stages' lengths in minutes. */
export interface DaoSettings {
  proposeMinVotes: number;
  proposalPercent: number;
  passPercent: number;
  pendingMinutes: number;
  voteMinutes: number;
}

/** The body of /list-dao-proposals: the list; a range, ISO 8601, `from` at or after and `to` before, on createdAt for pending and open and on decidedAt for decided; limit 1 to 100 (20); offset 0 or more (0). */
export interface DaoListFilters {
  status: DaoListStatus;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * One proposal as the lists answer it (masterpod 15.4). Weights, totals and
 * sums are votes, whole staked anos, as numbers; the times are ISO 8601, or
 * null until they happen (openedAt and voteClosesAt until the vote opens,
 * decidedAt until it closes or the proposal expires). `for` and `against`
 * are the live sums while open, the stored results once decided, 0 and 0 on
 * expired. `yourWeight` is the caller's votes in the proposal's current
 * snapshot, 0 meaning the pod can neither support nor vote on it.
 */
export interface DaoProposalItem {
  proposalId: string;
  title: string;
  status: DaoStatus;
  /** The username is null when the pod's row is gone. */
  proposer: { anopodId: string; username: string | null };
  createdAt: string;
  pendingUntil: string;
  openedAt: string | null;
  voteClosesAt: string | null;
  decidedAt: string | null;
  snapshotTotal: number;
  needed: number;
  support: number;
  for: number;
  against: number;
  yourWeight: number;
  yourSupport: boolean;
  yourVote: 'for' | 'against' | null;
}

/** What /get-dao-proposal answers: the item with the text. */
export type DaoProposal = DaoProposalItem & { body: string };

/** One row of /list-dao-votes: a support of the pending stage (every vote `for`) or a vote of the official stage; the wallet marks its own row by anopodId. */
export interface DaoVoteItem {
  anopodId: string;
  username: string | null;
  vote: 'for' | 'against';
  weight: number;
  createdAt: string;
}

// --- the moderator level (masterpod 12.4.4) ------------------------------------

/** One row of /list-recovery-cases: the case with its pod's names and the count of distinct approving pods. */
export interface RecoveryCaseItem {
  caseId: string;
  status: CaseStatus;
  lookupId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  contactEmail: string | null;
  /** The contact phone (2026-11-12; masterpod 18). A masterpod of before sends none. */
  contactPhone?: string | null;
  approvals: number;
  createdAt: string;
  updatedAt: string;
}

/** One event as the moderators see it: the acting moderator's username and the details complete (masterpod 12.5). */
export interface CaseEvent {
  eventId: string;
  kind: string;
  anopodId: string | null;
  username: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/** One share the keyholders posted to the case, without its bytes. */
export interface CaseShare {
  keyholderId: number;
  shareType: string;
  keyId: string;
  receivedAt: string;
}

/** The banker packet (masterpod 12.6): what the bankers' GUI takes to deliver the shares. */
export interface BankerPacket {
  lookupId: string;
  url: string;
  hybridKey: HybridPublicKey | null;
}

/** What /get-recovery-case answers. */
export interface RecoveryCaseAnswer {
  case: { caseId: string; status: CaseStatus; lookupId: string; contactEmail: string | null; contactPhone?: string | null; createdAt: string; updatedAt: string };
  profile: Profile | null;
  events: CaseEvent[];
  shares: CaseShare[];
  bankerPacket: BankerPacket;
}

/** A sign-off's verdict. */
export type SignOffVerdict = 'approve' | 'reject';

/** The body of /sign-off-recovery-case: the signed message of masterpod 12.6 with its two signatures. */
export interface SignOffBody extends SignOffMessage {
  signatures: Signatures;
}

/** The preset reasons a case may be dismissed for (masterpod 12.4.4). */
export const DISMISS_REASONS = ['selfieMismatch', 'documentsMismatch', 'unknownLookupId', 'noShow', 'other'] as const;

export type DismissReason = (typeof DISMISS_REASONS)[number];

// --- the attestor level (masterpod 13.4) ------------------------------------------

/** The statuses of a trade or dispute case (masterpod 13.5): two review statuses, two final ones. */
export type AttestorCaseStatus = 'open' | 'inReview' | 'decided' | 'dismissed';

/** One attestor pod as /list-attestors answers it, with its chat public keys (hex; null when the pod has none). */
export interface AttestorItem {
  anopodId: string;
  username: string;
  firstName: string;
  lastName: string;
  chatPublicKey: string | null;
  chatPublicKeyPq: string | null;
}

/** One entry of /list-anos-account-profiles: the account's type and pod with the pod's profile; nulls for an account the masterpod does not know. */
export interface AccountProfileItem {
  accountId: string;
  accountType: string | null;
  anopodId: string | null;
  profile: Profile | null;
}

/** A party's names on a dispute row, null when the pod's row is gone. */
export interface PartyNames {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** One row of /list-attestor-cases' trades. */
export interface TradeCaseItem {
  caseId: string;
  transactionId: string;
  accountId: string;
  status: AttestorCaseStatus;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  openedBy: string | null;
  signOffs: number;
  lookupIdShared: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One row of /list-attestor-cases' disputes. */
export interface DisputeCaseItem {
  caseId: string;
  transactionId: string;
  accountId: string;
  accountIdTo: string;
  status: AttestorCaseStatus;
  seller: PartyNames;
  buyer: PartyNames;
  openedBy: string | null;
  signOffs: number;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttestorCasesAnswer {
  trades: TradeCaseItem[];
  disputes: DisputeCaseItem[];
}

/** What /get-trade-case answers: the row, the sender's profile and every event complete (the events' shape is CaseEvent). */
export interface TradeCaseAnswer {
  case: {
    caseId: string;
    transactionId: string;
    accountId: string;
    anopodId: string;
    openedBy: string;
    lookupId: string | null;
    status: AttestorCaseStatus;
    createdAt: string;
    updatedAt: string;
  };
  profile: Profile | null;
  events: CaseEvent[];
}

/** One evidence row as the attestors see it: the ciphertext and the case-key wrap, null once the case is decided or dismissed. */
export interface DisputeEvidenceItem {
  evidenceId: string;
  anopodId: string;
  username: string | null;
  side: 'seller' | 'buyer';
  contentType: string;
  file: string;
  keyForCase: string | null;
  createdAt: string;
}

/** What /get-dispute-case answers: the row with the case key's public halves, both profiles, the caller's wrapped key, who holds one, the events and every evidence row. */
export interface DisputeCaseAnswer {
  case: {
    caseId: string;
    transactionId: string;
    accountId: string;
    accountIdTo: string;
    anopodId: string;
    anopodIdTo: string;
    disputedBy: string;
    openedBy: string;
    caseKey: HybridPublicKey;
    status: AttestorCaseStatus;
    createdAt: string;
    updatedAt: string;
  };
  seller: Profile | null;
  buyer: Profile | null;
  myKey: string | null;
  keyHolders: string[];
  events: CaseEvent[];
  evidence: DisputeEvidenceItem[];
}

/** The case secret wrapped to one attestor pod's chat key (CryptoService.wrapCaseSecret, hex). */
export interface CaseKeyWrap {
  anopodId: string;
  wrappedKey: string;
}

/** The body of /open-dispute-case: the escrow's ids, the case key's public halves and a wrap for every attestor pod. */
export interface OpenDisputeCaseBody {
  transactionId: string;
  accountId: string;
  accountIdTo: string;
  disputedBy: string;
  caseKey: HybridPublicKey;
  keys: CaseKeyWrap[];
}

/** One answer of a validator to a posted sign-off, as /mark-attestor-case-sent records it. */
export interface SentResult {
  signer: string;
  status: number;
  error?: string;
}

/** The preset reasons a trade or dispute case may be dismissed for (masterpod 13.4.4). */
export const ATTESTOR_DISMISS_REASONS = ['selfieMismatch', 'documentsMismatch', 'noShow', 'withdrawn', 'settled', 'other'] as const;

export type AttestorDismissReason = (typeof ATTESTOR_DISMISS_REASONS)[number];

// --- level attestor, the break-glass cases (masterpod 14.4.2, 2026-11-08) ----------

/** One move as /list-break-glass-cases answers it: a BreakGlassMove without its createdAt. */
export type BreakGlassListedMove = Omit<BreakGlassMove, 'createdAt'>;

/** One row of /list-break-glass-cases (masterpod 14.4.2): a recovery case seen by the attestors, with the recovered pod's names (null when its row is gone), the count of distinct attestor pods that signed and the moves in account order. */
export interface BreakGlassCaseRow {
  caseId: string;
  status: AttestorCaseStatus;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  signOffs: number;
  moves: BreakGlassListedMove[];
  createdAt: string;
  updatedAt: string;
}

/** One moderator approval of the recovery case, as /get-break-glass-case lists them: the approvalSigned recovery events in time order, the moderator's username (null when the pod's row is gone) and the time from the event's details. */
export interface BreakGlassApproval {
  username: string | null;
  signedAt: string | null;
}

/**
 * What /get-break-glass-case answers (masterpod 14.4.2): the case with the
 * recovery case's lookup id, status and approvals, the recovered pod's
 * profile with the public selfie, the moves in account order and every
 * attestor event complete (the events' shape is CaseEvent; an
 * attestationSigned event's details are { attestorId, attestations }, the
 * whole follow-up objects in move order, which the Send step posts).
 */
export interface BreakGlassCaseAnswer {
  case: {
    caseId: string;
    status: AttestorCaseStatus;
    lookupId: string | null;
    recoveryStatus: CaseStatus | null;
    approvals: BreakGlassApproval[];
    createdAt: string;
    updatedAt: string;
  };
  profile: Profile | null;
  moves: BreakGlassMove[];
  events: CaseEvent[];
}

/** One entry of /sign-off-break-glass-case: a move's transaction id and the attestation follow-up on it, signed as the account page signs one. */
export interface BreakGlassAttestation {
  transactionId: string;
  attestation: FollowUp<AttestationPayload>;
}

/** The preset reasons a break-glass case may be dismissed for (masterpod 14.4.2): the trade case's six without settled. */
export const BREAK_GLASS_DISMISS_REASONS = ['selfieMismatch', 'documentsMismatch', 'noShow', 'withdrawn', 'other'] as const;

export type BreakGlassDismissReason = (typeof BREAK_GLASS_DISMISS_REASONS)[number];

// --- the person's side of a case (masterpod 13.4.5) ---------------------------------

export interface MyTradeCase {
  caseId: string;
  transactionId: string;
  accountId: string;
  status: AttestorCaseStatus;
  lookupIdShared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MyDisputeCase {
  caseId: string;
  transactionId: string;
  accountId: string;
  accountIdTo: string;
  side: 'seller' | 'buyer';
  /** The attestors on the case, the one who opened it first (2026-11-12; masterpod 18), for the invite into the marketplace chat of the trade. A masterpod of before sends none: a missing list reads as an empty one. */
  attestors?: RoomMember[];
  status: AttestorCaseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MyCasesAnswer {
  trades: MyTradeCase[];
  disputes: MyDisputeCase[];
}

/** One event of the person's subset (masterpod 13.4.5): the kind, its named details and when; never an attestor's id, name or note. */
export interface MyCaseEvent {
  kind: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/** One of the caller's own evidence rows: the ciphertext and the content key under the pod's encryption key (hex, 60 bytes). */
export interface MyEvidenceItem {
  evidenceId: string;
  contentType: string;
  file: string;
  keyForMe: string;
  createdAt: string;
}

/** What /get-my-case answers, by kind. */
export type MyCaseAnswer =
  | { kind: 'trade'; case: MyTradeCase; events: MyCaseEvent[] }
  | { kind: 'dispute'; case: MyDisputeCase & { caseKey: HybridPublicKey }; events: MyCaseEvent[]; evidence: MyEvidenceItem[] };

/** One new file of /add-dispute-evidence: the ciphertext (base64) with the content key under the pod's encryption key (hex, 60 bytes) and to the case key (hex, 1660 bytes). */
export interface EvidenceFile {
  contentType: string;
  file: string;
  keyForMe: string;
  keyForCase: string;
}

/** A file of the caller's from another case supplied again: its row and the content key wrapped to this case's key. */
export interface ExistingEvidence {
  evidenceId: string;
  keyForCase: string;
}

/**
 * All HTTP calls to the masterpod live here, one method per route (the
 * keyholder test app's api.service.ts, base path /api/masterpod, the two
 * changed routes and the four new ones added, then the recovery routes of
 * masterpod 12.4, the attesting routes of masterpod 13.4, the wallet
 * memory routes of wallet spec 4.6 and 4.7 (2026-11-07), the break-glass
 * routes of masterpod 14.4 and the DAO routes of masterpod 15 (2026-11-08),
 * and after them the two passkey routes of masterpod 19 (2026-11-18) and
 * the report of how far a chat was read, /mark-messages-seen, of masterpod
 * 21 (2026-11-19), and the store of an account's first key blob,
 * /store-first-key-blob, of masterpod 22 (2026-11-20), and the eight
 * routes of a pod's security alerts of masterpod 25 (2026-11-21), and the
 * three routes of Joy, the wallet's AI, of masterpod 30 (2026-11-24); the read
 * of one listing, /get-listing, is of 2026-11-06),
 * so no page builds URLs or envelopes. The session service holds the session and signs.
 */
@Injectable({ providedIn: 'root' })
export class MasterpodApiService {
  private readonly log = inject(LogService);
  private readonly lang = inject(LanguageService);
  private readonly session = inject(SessionService);

  // --- level none ---------------------------------------------------------

  /** A challenge for `purpose`; openCase takes the anoPod id the keyholders named for the lookup id and answers that pod's username (masterpod 12.4.2, 2026-11-08). Since 2026-11-18 (masterpod spec 20) openCase may take the lookup id too: a case already open for it answers 409 case already open, and the answer carries the credential ids of the pod's passkeys. */
  challenge(purpose: ChallengePurpose, anopodId?: string, lookupId?: string): Promise<ApiResponse<ChallengeAnswer>> {
    const body: Record<string, unknown> = { purpose };
    if (anopodId !== undefined) body['anopodId'] = anopodId;
    if (lookupId !== undefined) body['lookupId'] = lookupId;
    return this.post('/challenge', body);
  }

  checkUsername(username: string, quiet = false): Promise<ApiResponse<{ username: string; available: boolean }>> {
    return this.post('/check-username', { username }, quiet);
  }

  createAnopod(envelope: Envelope): Promise<ApiResponse<CreateAnswer>> {
    return this.post('/create-anopod', envelope);
  }

  unlock(envelope: Envelope): Promise<ApiResponse<UnlockAnswer>> {
    return this.post('/unlock', envelope);
  }

  getAnosAccount(accountId: string): Promise<ApiResponse<{ accountId: string; anopodId: string; vouched: boolean }>> {
    return this.post('/get-anos-account', { accountId });
  }

  // --- recovery, the person's side (masterpod 12.4.2 and 12.4.3) ------------

  /** Signed by the ephemeral keys inside, like /create-anopod. */
  openRecoveryCase(envelope: Envelope): Promise<ApiResponse<OpenRecoveryCaseAnswer>> {
    return this.post('/open-recovery-case', envelope);
  }

  /** Signed by the ephemeral keys inside, like /unlock. */
  unlockRecoveryPod(envelope: Envelope): Promise<ApiResponse<UnlockRecoveryPodAnswer>> {
    return this.post('/unlock-recovery-pod', envelope);
  }

  /** Level recovery: the envelope comes from RecoveryService.sign('/get-recovery-pod', {}). */
  getRecoveryPod(envelope: Envelope, quiet = false): Promise<ApiResponse<RecoveryPodAnswer>> {
    return this.post('/get-recovery-pod', envelope, quiet);
  }

  /** The finish: { challenge, caseId, newBlob1 } signed by the backup code keys (CryptoService.backupCodeProof), level none. */
  recoverWithBackupCode(envelope: Envelope): Promise<ApiResponse<RecoverAnswer>> {
    return this.post('/recover-with-backup-code', envelope);
  }

  /** Level recovery: the envelope comes from RecoveryService.sign('/complete-recovery-case', {}). */
  completeRecoveryCase(envelope: Envelope): Promise<ApiResponse<{ caseId: string; status: 'completed' }>> {
    return this.post('/complete-recovery-case', envelope);
  }


  // --- level session ------------------------------------------------------

  checkAnopodStatus(quiet = false): Promise<ApiResponse<StatusAnswer>> {
    return this.signed('/check-anopod-status', {}, quiet);
  }

  getAnopodProfile(anopodId: string, quiet = false): Promise<ApiResponse<Profile>> {
    return this.signed('/get-anopod-profile', { anopodId }, quiet);
  }

  searchUsernames(username: string): Promise<ApiResponse<Profile>> {
    return this.signed('/search-usernames', { username });
  }

  sendVouchRequest(anopodIdTo: string): Promise<ApiResponse<{ vouchIdNumber: string }>> {
    return this.signed('/send-vouch-request', { anopodIdTo });
  }

  listNotifications(unreadOnly = false, quiet = false): Promise<ApiResponse<{ notifications: NotificationItem[] }>> {
    return this.signed('/list-notifications', { unreadOnly }, quiet);
  }

  markNotificationsRead(notificationNumbers: string[]): Promise<ApiResponse<{ marked: number }>> {
    return this.signed('/mark-notifications-read', { notificationNumbers });
  }

  // --- level vouched ------------------------------------------------------

  listVouchRequests(quiet = false): Promise<ApiResponse<{ requests: VouchRequestItem[] }>> {
    return this.signed('/list-vouch-requests', {}, quiet);
  }

  approveVouchRequest(vouchIdNumber: string): Promise<ApiResponse<{ vouchIdNumber: string; vouchedFor: string; nowVouched: boolean; nowSeed: boolean }>> {
    return this.signed('/approve-vouch-request', { vouchIdNumber });
  }

  declineVouchRequest(vouchIdNumber: string): Promise<ApiResponse<{ vouchIdNumber: string }>> {
    return this.signed('/decline-vouch-request', { vouchIdNumber });
  }

  completeSetup(fields: SetupFields): Promise<ApiResponse<{ anopodId: string; setupComplete: boolean }>> {
    return this.signed('/complete-setup', fields);
  }

  addToSecurityBucketOne(keyId: string, images: Image[]): Promise<ApiResponse<{ imageIds: string[] }>> {
    return this.signed('/add-to-security-bucket-one', { keyId, images });
  }

  addToSecurityBucketTwo(keyId: string, images: Image[], info: { info: string }[]): Promise<ApiResponse<{ imageIds: string[]; infoIds: string[] }>> {
    return this.signed('/add-to-security-bucket-two', { keyId, images, info });
  }

  listSecurityRecords(): Promise<ApiResponse<SecurityRecords>> {
    return this.signed('/list-security-records', {});
  }

  // --- level setup: chat --------------------------------------------------

  /** A room; `listingId` makes a private room about that listing (2026-11-06), `caseId` a private room about that attestor case, which only an appointed attestor can make (2026-11-12). */
  createChatRoom(type: 'private' | 'public', name: string | undefined, hpkeKey: string, listingId?: string, caseId?: string): Promise<ApiResponse<{ chatRoomId: string }>> {
    const body: Record<string, unknown> = type === 'public' ? { type, name, hpkeKey } : { type, hpkeKey };
    if (listingId !== undefined) body['listingId'] = listingId;
    if (caseId !== undefined) body['caseId'] = caseId;
    return this.signed('/create-chat-room', body);
  }

  inviteToChatRoom(chatRoomId: string, anopodIdTo: string, hpkeKey: string): Promise<ApiResponse<{ inviteId: string }>> {
    return this.signed('/invite-to-chat-room', { chatRoomId, anopodIdTo, hpkeKey });
  }

  acceptInvite(inviteId: string): Promise<ApiResponse<{ chatRoomId: string }>> {
    return this.signed('/accept-invite', { inviteId });
  }

  declineInvite(inviteId: string): Promise<ApiResponse<{ chatRoomId: string }>> {
    return this.signed('/decline-invite', { inviteId });
  }

  requestToJoin(chatRoomId: string): Promise<ApiResponse<{ joinRequestId: string }>> {
    return this.signed('/request-to-join', { chatRoomId });
  }

  approveJoin(joinRequestId: string, hpkeKey: string): Promise<ApiResponse<{ chatRoomId: string; anopodId: string }>> {
    return this.signed('/approve-join', { joinRequestId, hpkeKey });
  }

  declineJoin(joinRequestId: string): Promise<ApiResponse<{ chatRoomId: string; anopodId: string }>> {
    return this.signed('/decline-join', { joinRequestId });
  }

  leaveChatRoom(chatRoomId: string): Promise<ApiResponse<{ chatRoomId: string }>> {
    return this.signed('/leave-chat-room', { chatRoomId });
  }

  /** The chat list. Without `since` the whole list; with it (2026-11-24, masterpod spec 29) only what changed after that number, the `seq` of the answer the wallet last put into its list. A masterpod of before does not read `since` and answers the whole list. */
  listChatRooms(quiet = false, since?: number): Promise<ApiResponse<RoomsRead>> {
    return this.signed('/list-chat-rooms', since === undefined ? {} : { since }, quiet);
  }

  /** The public rooms, the ones with the most members first; `search` narrows them by name (2026-11-22, masterpod spec 26). A masterpod of before takes no search word and answers the newest first. */
  listPublicChatRooms(query: PublicRoomsQuery = {}, quiet = false): Promise<ApiResponse<{ rooms: PublicRoomItem[] }>> {
    const body: Record<string, unknown> = {};
    if (query.search) body['search'] = query.search;
    if (query.limit !== undefined) body['limit'] = query.limit;
    if (query.offset) body['offset'] = query.offset;
    return this.signed('/list-public-chat-rooms', body, quiet);
  }

  /** Gives a public room its picture, or another in place of the one it has; only the room's creator (2026-11-22, masterpod spec 27). */
  setChatRoomPicture(chatRoomId: string, picture: Image): Promise<ApiResponse<{ chatRoomId: string; pictureAt: string }>> {
    return this.signed('/set-chat-room-picture', { chatRoomId, picture });
  }

  /** A public room's picture (2026-11-22, masterpod spec 27). Quiet unless asked otherwise: the room pictures are read like the faces. */
  getChatRoomPicture(chatRoomId: string, quiet = true): Promise<ApiResponse<{ chatRoomId: string; picture: Image; pictureAt: string }>> {
    return this.signed('/get-chat-room-picture', { chatRoomId }, quiet);
  }

  /** The room's messages after a position (the poll), or with `beforePosition` the newest `limit` below it (opening a room, loading older ones). With `seenSince` in the query (2026-11-24, masterpod spec 29) the answer also carries the members' seen positions that changed after it. Since 2026-11-24 (masterpod spec 31) the answer holds every row of the room, the edits and the deletes among the messages (MessageItem), and the positions and `limit` count every row. Since 2026-11-25 (wallet spec 8.2, Chat) a room that the browser keeps a copy of is opened with the read after a position too: after the copy's highest position, with `limit` 100. Only a room without a copy, and one whose copy was dropped, opens with `beforePosition`. */
  listMessages(chatRoomId: string, query: MessagesQuery, quiet = false): Promise<ApiResponse<MessagesAnswer>> {
    return this.signed('/list-messages', { chatRoomId, ...query }, quiet);
  }

  sendMessage(chatRoomId: string, message: string): Promise<ApiResponse<{ messageId: string; position: number }>> {
    return this.signed('/send-message', { chatRoomId, message });
  }

  /** Gives a message of this pod's own a new text (2026-11-24, masterpod spec 31; wallet spec 4.19): `message` is the new text's ciphertext, as for /send-message. The masterpod writes a new row that names the message and changes none; the answer is that row's id and position. Refused in a chat about a listing, an old marketplace room and a chat about an attestor case (403), for another person's message (403), for a deleted one (409 message deleted) and more than 15 minutes after the message was sent (409 too late to edit). A masterpod of before answers 404. */
  editMessage(chatRoomId: string, messageId: string, message: string): Promise<ApiResponse<{ messageId: string; position: number }>> {
    return this.signed('/edit-message', { chatRoomId, messageId, message });
  }

  /** Deletes a message of this pod's own (2026-11-24, masterpod spec 31; wallet spec 4.19): the masterpod writes a new row that names the message and removes none; the answer is that row's id and position. Refused as /edit-message is, but at any time after the message was sent. A masterpod of before answers 404. */
  deleteMessage(chatRoomId: string, messageId: string): Promise<ApiResponse<{ messageId: string; position: number }>> {
    return this.signed('/delete-message', { chatRoomId, messageId });
  }

  /** Tells the masterpod how far this pod has read in a room (2026-11-19, masterpod spec 21). Always quiet: it is a report, not something the person did. A masterpod of before answers 404. */
  markMessagesSeen(chatRoomId: string, position: number): Promise<ApiResponse<{ chatRoomId: string; seenPosition: number }>> {
    return this.signed('/mark-messages-seen', { chatRoomId, position }, true);
  }

  /** The stickers of the wallet's chat (2026-11-23, masterpod spec 28; wallet spec 4.16): every set in the order of the row of sets, each with its stickers in their order, each sticker with its number and its tags. Text only. Quiet unless asked otherwise: stickers.service reads it once after each login, and it is nothing the person did. What the answer holds is read by readStickerSets (../stickers), which trusts nothing in it. A masterpod of before answers 404. */
  listStickers(quiet = true): Promise<ApiResponse<unknown>> {
    return this.signed('/list-stickers', {}, quiet);
  }

  getChatPublicKeys(anopodIds: string[]): Promise<ApiResponse<{ keys: ChatKeyItem[] }>> {
    return this.signed('/get-chat-public-keys', { anopodIds });
  }

  // --- level setup: marketplace -------------------------------------------

  createListing(fields: ListingFields): Promise<ApiResponse<{ listingId: string; chatRoomId: string | null }>> {
    return this.signed('/create-listing', fields);
  }

  closeListing(listingId: string): Promise<ApiResponse<{ listingId: string; status: string }>> {
    return this.signed('/close-listing', { listingId });
  }

  listListings(filters: ListingFilters): Promise<ApiResponse<{ listings: ListingItem[] }>> {
    return this.signed('/list-listings', filters);
  }

  /** One listing, open or closed, in the list's form (2026-11-06). */
  getListing(listingId: string): Promise<ApiResponse<{ listing: ListingItem }>> {
    return this.signed('/get-listing', { listingId });
  }

  // --- level setup: anos accounts (wallet spec 4.4) -------------------------

  createAnosAccount(body: CreateAnosAccountBody): Promise<ApiResponse<{ accountId: string }>> {
    return this.signed('/create-anos-account', body);
  }

  markAnosAccountSubmitted(accountId: string): Promise<ApiResponse<{ accountId: string; submittedAt: string }>> {
    return this.signed('/mark-anos-account-submitted', { accountId });
  }

  /** firstKeyBlobs: true tells the masterpod that this page can open a first key blob (2026-11-20, masterpod spec 22: the old page guard); an older masterpod ignores it. */
  listAnosAccounts(quiet = false): Promise<ApiResponse<{ accounts: AnosAccountListItem[] }>> {
    return this.signed('/list-anos-accounts', { firstKeyBlobs: true }, quiet);
  }

  /** The first key blob of an account that has none yet (2026-11-20, masterpod spec 22): sent by the login (unlock.ts), quietly. 409 when the account has one already. */
  storeFirstKeyBlob(accountId: string, firstKeyBlob: string): Promise<ApiResponse<{ accountId: string }>> {
    return this.signed('/store-first-key-blob', { accountId, firstKeyBlob }, true);
  }

  // --- level setup: the wallet's memory (wallet spec 4.6) ---------------------

  addNotedTransaction(fields: NoteFields): Promise<ApiResponse<{ noteId: string }>> {
    return this.signed('/add-noted-transaction', fields);
  }

  updateNotedTransaction(noteId: string, noteBlob: string): Promise<ApiResponse<{ noteId: string; updatedAt: string }>> {
    return this.signed('/update-noted-transaction', { noteId, noteBlob });
  }

  removeNotedTransaction(noteId: string): Promise<ApiResponse<{ noteId: string; removed: true }>> {
    return this.signed('/remove-noted-transaction', { noteId });
  }

  listNotedTransactions(range: NoteRange = {}, quiet = false): Promise<ApiResponse<{ notes: NotedTransactionItem[]; more: boolean }>> {
    return this.signed('/list-noted-transactions', range, quiet);
  }

  // --- level setup: the wallet settings (wallet spec 4.7) ---------------------

  getWalletSettings(quiet = false): Promise<ApiResponse<{ settingsBlob: string | null; updatedAt: string | null }>> {
    return this.signed('/get-wallet-settings', {}, quiet);
  }

  setWalletSettings(settingsBlob: string): Promise<ApiResponse<{ updatedAt: string }>> {
    return this.signed('/set-wallet-settings', { settingsBlob });
  }

  // --- level setup: Joy, the wallet's AI (masterpod spec 30; wallet spec 4.18) ---

  /** The member's memory file for Joy as the wallet stored it: a blob under the anoPod encryption key, hex, and when it was last stored; both null before the first store. Quiet unless asked otherwise, since it is nothing the person did. */
  getJoyMemory(quiet = true): Promise<ApiResponse<{ memoryBlob: string | null; updatedAt: string | null }>> {
    return this.signed('/get-joy-memory', {}, quiet);
  }

  /** The memory file's blob, hex, 1 to 32768 bytes, which takes the place of the one before. 400 invalid memoryBlob for a blob of another length. */
  setJoyMemory(memoryBlob: string): Promise<ApiResponse<{ updatedAt: string }>> {
    return this.signed('/set-joy-memory', { memoryBlob });
  }

  /**
   * One message to Joy: the conversation, oldest first, with the member's
   * new message last, and the opened memory file as text. Both travel in
   * the clear inside the signed request: the masterpod hands them to
   * Anthropic's model, which writes the answer.
   *
   * The answer is read while it arrives (LogService.postLines), each line
   * handed to `onLine` as it comes: `{ text }` for a piece of Joy's
   * answer; `{ searching: true }` each time she starts a web search
   * (since 2026-11-24, masterpod spec 32; wallet spec 4.20);
   * `{ drawing: true }` each time she starts on a picture, also when no
   * picture comes of it, and `{ picture }`, a JoyPictureLine, one line
   * with the picture when one was made, one in an answer at most (since
   * 2026-11-25, masterpod spec 33; wallet spec 4.21); then one
   * last line, `{ done: true, stop, memory, sources }` for an answer that
   * ended (`stop` a JoyStop; `memory` the whole memory file after Joy
   * changed it, or null when she did not; `sources` the web pages she
   * cited, each a JoySource, an empty list when she cited none, and no
   * field at all from a masterpod of before), or `{ error }` for an
   * answer that failed: `joy busy`, `joy unavailable` or `joy was cut
   * off`.
   *
   * A refusal comes with its status in place of the lines: 503 joy is
   * off, 429 daily limit reached, 400 conversation too long, 400 memory
   * too long, and the refusals of every route at level setup.
   */
  askJoy(messages: JoyMessage[], memory: string, onLine: (line: unknown) => void): Promise<ApiResponse<LinesRead>> {
    const envelope = this.session.sign('/ask-joy', { messages, memory });
    if (!envelope) return Promise.resolve({ ok: false, status: 0, body: { error: this.lang.words().api.noSession } as unknown as LinesRead });
    return this.log.postLines(BASE + '/ask-joy', envelope, onLine, JOY_SILENCE_MS);
  }

  // --- level setup: the passkeys (masterpod spec 19) --------------------------

  /** The anoPod's passkeys: the main one and the added ones, oldest first. */
  listPasskeys(quiet = false): Promise<ApiResponse<PasskeyList>> {
    return this.signed('/list-passkeys', {}, quiet);
  }

  /** One more passkey on the anoPod; 201 { passkeyId, credentialId, createdAt }. Refusals the Passkeys page reads: 401 unknown or expired challenge (the ten minutes are over, or the challenge was used) and 401 unknown passkey (the fresh tap was not by a passkey of this anoPod). */
  addPasskey(body: AddPasskeyBody): Promise<ApiResponse<AddedPasskeyItem>> {
    return this.signed('/add-passkey', body);
  }

  // --- level setup: the security alerts (masterpod spec 25) ---------------------

  /** The pod's list of emails and phones, each oldest first, and what the Security alerts page needs to know about the masterpod. */
  listAlertSettings(quiet = false): Promise<ApiResponse<AlertSettings>> {
    return this.signed('/list-alert-settings', {}, quiet);
  }

  /** A new address on the list, not confirmed yet, with a six-digit code sent to it, 201; for an address that is on the list and not confirmed yet a new code, 200. `language` is the language every email to the address is written in. Refusals the page has a sentence for: 400 invalid email, 409 email already listed, 403 email limit reached, 429 too many codes today, 429 wait before a new code, 503 email alerts not set up. */
  addAlertEmail(email: string, language: 'en' | 'th'): Promise<ApiResponse<{ emailId: string; email: string; confirmed: false }>> {
    return this.signed('/add-alert-email', { email, language });
  }

  /** The code typed back: the address counts from now on. Refusals the page has a sentence for: 401 wrong code, 400 invalid code, 410 code expired, 410 code used up, 429 too many changes today. */
  confirmAlertEmail(emailId: string, code: string): Promise<ApiResponse<{ emailId: string; confirmed: true }>> {
    return this.signed('/confirm-alert-email', { emailId, code });
  }

  /** "Take off": a confirmed address is set to come off at removesAt and gets every alert until then (removed false); one that was never confirmed goes at once (removed true, removesAt null). 429 too many changes today. */
  removeAlertEmail(emailId: string): Promise<ApiResponse<{ emailId: string; removed: boolean; removesAt: string | null }>> {
    return this.signed('/remove-alert-email', { emailId });
  }

  /** "Keep": an address that was set to come off stays. */
  keepAlertEmail(emailId: string): Promise<ApiResponse<{ emailId: string; removesAt: null }>> {
    return this.signed('/keep-alert-email', { emailId });
  }

  /** This browser on the list, with what it handed over when the person allowed notifications (alerts.service, turnOn): 201, or 200 with the row as it stands when it is on the list already. Refusals the page has a sentence for: 503 phone alerts not set up, 400 push service not supported, 403 phone limit reached, 429 too many changes today. */
  addAlertPhone({ endpoint, p256dh, auth, label }: { endpoint: string; p256dh: string; auth: string; label: string }): Promise<ApiResponse<{ phoneId: string; removesAt: string | null }>> {
    return this.signed('/add-alert-phone', { endpoint, p256dh, auth, label });
  }

  /** "Take off": the phone is set to come off at removesAt and gets every alert until then. 429 too many changes today. */
  removeAlertPhone(phoneId: string): Promise<ApiResponse<{ phoneId: string; removesAt: string | null }>> {
    return this.signed('/remove-alert-phone', { phoneId });
  }

  /** "Keep": a phone that was set to come off stays. */
  keepAlertPhone(phoneId: string): Promise<ApiResponse<{ phoneId: string; removesAt: null }>> {
    return this.signed('/keep-alert-phone', { phoneId });
  }

  // --- level setup: after a recovery (masterpod 12.4.5) and the break-glass moves (masterpod 14.4.1) ---

  /** The new backup code's blob2 and keys, with the proof by the current code (CryptoService.backupCodeProof over the RotationMessage). */
  rotateBackupCode(body: RotateBackupCodeBody): Promise<ApiResponse<{ anopodId: string; rotated: boolean }>> {
    return this.signed('/rotate-backup-code', body);
  }

  /** The caller's break-glass cases, newest first, each with its moves and the events the person may see (masterpod 14.4.1): what a lost account's card reads, and the recovery finish; since 2026-11-12 the Cases page and My recovery case too (wallet spec 13.3). /store-break-glass-blob is no longer called (2026-11-08). */
  listMyBreakGlassMoves(quiet = false): Promise<ApiResponse<{ cases: BreakGlassCaseItem[] }>> {
    return this.signed('/list-my-break-glass-moves', {}, quiet);
  }

  /** The break-glass moves of the recovery finish's Move your money step, filed for the attestors (masterpod 14.4.1): the recovery case's id and 1 to 20 moves. Since 2026-11-10 the finish sends one move per call, as soon as that move is on the validators (recovery finish order plan 1); until then it sent the moves of one run in one call. 201 { caseId, status, moves } with the count now on the case, 409 move already filed when a transaction id was filed before, 409 case not ready while the recovery case is neither delivering nor completed. A second call for the same case adds moves. */
  fileBreakGlassMoves(caseId: string, moves: BreakGlassMoveToFile[]): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus; moves: number }>> {
    return this.signed('/file-break-glass-moves', { caseId, moves });
  }

  // --- level moderator (masterpod 12.4.4) ------------------------------------

  /** The cases in `statuses` (the four in-progress ones when omitted), newest first. */
  listRecoveryCases(statuses?: CaseStatus[], quiet = false): Promise<ApiResponse<{ cases: RecoveryCaseItem[] }>> {
    return this.signed('/list-recovery-cases', statuses === undefined ? {} : { statuses }, quiet);
  }

  getRecoveryCase(caseId: string, quiet = false): Promise<ApiResponse<RecoveryCaseAnswer>> {
    return this.signed('/get-recovery-case', { caseId }, quiet);
  }

  /** The case's pod's rows of one bucket, ciphertext under the bucket keys the keyholders hand out; the masterpod records the view. */
  listCaseSecurityRecords(caseId: string, bucket: 1 | 2): Promise<ApiResponse<SecurityRecords>> {
    return this.signed('/list-case-security-records', { caseId, bucket });
  }

  scheduleRecoveryCase(caseId: string, at: string, meetLink: string): Promise<ApiResponse<{ caseId: string; status: CaseStatus }>> {
    return this.signed('/schedule-recovery-case', { caseId, at, meetLink });
  }

  /** The sign-off: the message signed by pair one of an anos account in the caller's pod (CryptoService.signSignOff). */
  signOffRecoveryCase(body: SignOffBody): Promise<ApiResponse<{ caseId: string; status: CaseStatus; approvals: number }>> {
    return this.signed('/sign-off-recovery-case', body);
  }

  dismissRecoveryCase(caseId: string, reason: DismissReason, note: string): Promise<ApiResponse<{ caseId: string; status: 'dismissed' }>> {
    return this.signed('/dismiss-recovery-case', { caseId, reason, note });
  }

  // --- level attestor, reads (masterpod 13.4.3) ------------------------------

  /** Every attestor pod whose setup is complete, with its chat public keys: what a case key is wrapped for. */
  listAttestors(quiet = false): Promise<ApiResponse<{ attestors: AttestorItem[] }>> {
    return this.signed('/list-attestors', {}, quiet);
  }

  /** The people behind 1 to 200 account ids, one entry per id in the order given. */
  listAnosAccountProfiles(accountIds: string[], quiet = false): Promise<ApiResponse<{ profiles: AccountProfileItem[] }>> {
    return this.signed('/list-anos-account-profiles', { accountIds }, quiet);
  }

  /** The cases of both kinds in `statuses` (open and inReview when omitted: {} is sent), newest first. */
  listAttestorCases(statuses?: AttestorCaseStatus[], quiet = false): Promise<ApiResponse<AttestorCasesAnswer>> {
    return this.signed('/list-attestor-cases', statuses === undefined ? {} : { statuses }, quiet);
  }

  getTradeCase(caseId: string, quiet = false): Promise<ApiResponse<TradeCaseAnswer>> {
    return this.signed('/get-trade-case', { caseId }, quiet);
  }

  getDisputeCase(caseId: string, quiet = false): Promise<ApiResponse<DisputeCaseAnswer>> {
    return this.signed('/get-dispute-case', { caseId }, quiet);
  }

  /** The sender pod's rows of one bucket, ciphertext under the bucket keys the keyholders hand out; the masterpod records the view. */
  listTradeCaseSecurityRecords(caseId: string, bucket: 1 | 2): Promise<ApiResponse<SecurityRecords>> {
    return this.signed('/list-trade-case-security-records', { caseId, bucket });
  }

  // --- level attestor, writes (masterpod 13.4.4) ------------------------------

  /** A case on an assisted trade: the request to the sender for their lookup id. */
  openTradeCase(transactionId: string, accountId: string): Promise<ApiResponse<{ caseId: string; status: 'open' }>> {
    return this.signed('/open-trade-case', { transactionId, accountId });
  }

  /** A case on a disputed escrow, with the case key's public halves and a wrap of its secret for every attestor pod. */
  openDisputeCase(body: OpenDisputeCaseBody): Promise<ApiResponse<{ caseId: string; status: 'open' }>> {
    return this.signed('/open-dispute-case', body);
  }

  scheduleAttestorCase(caseId: string, at: string, meetLink: string): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus }>> {
    return this.signed('/schedule-attestor-case', { caseId, at, meetLink });
  }

  /** The case secret wrapped to an attestor pod appointed after the case was opened. */
  shareCaseKey(caseId: string, anopodId: string, wrappedKey: string): Promise<ApiResponse<{ caseId: string; anopodId: string; shared: true }>> {
    return this.signed('/share-case-key', { caseId, anopodId, wrappedKey });
  }

  /** The attestation follow-up, signed as the account page signs one, verified by the masterpod against the signer's stored creation. */
  signOffTradeCase(caseId: string, attestation: FollowUp<AttestationPayload>): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus; signOffs: number }>> {
    return this.signed('/sign-off-trade-case', { caseId, attestation });
  }

  /** The escrowVerdict follow-up, the same way; decidedVerdict is null until two agreeing verdicts decide the case. */
  signOffDisputeCase(caseId: string, verdict: FollowUp<EscrowVerdictPayload>): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus; signOffs: number; decidedVerdict: Verdict | null }>> {
    return this.signed('/sign-off-dispute-case', { caseId, verdict });
  }

  /** The validators' answers to the posted sign-offs, a failed post included; a later retry writes another event. */
  markAttestorCaseSent(caseId: string, validator: number, results: SentResult[]): Promise<ApiResponse<{ caseId: string; status: 'decided' }>> {
    return this.signed('/mark-attestor-case-sent', { caseId, validator, results });
  }

  dismissAttestorCase(caseId: string, reason: AttestorDismissReason, note: string): Promise<ApiResponse<{ caseId: string; status: 'dismissed' }>> {
    return this.signed('/dismiss-attestor-case', { caseId, reason, note });
  }

  // --- level attestor, the break-glass cases (masterpod 14.4.2, 2026-11-08) ----------

  /** The break-glass cases in `statuses` (open and inReview when omitted: {} is sent), newest first, each with its moves and the count of attestor pods that signed. */
  listBreakGlassCases(statuses?: AttestorCaseStatus[], quiet = false): Promise<ApiResponse<{ cases: BreakGlassCaseRow[] }>> {
    return this.signed('/list-break-glass-cases', statuses === undefined ? {} : { statuses }, quiet);
  }

  /** One case with the recovery case's lookup id and approvals, the person's profile, the moves and the events; 404 unknown case. */
  getBreakGlassCase(caseId: string, quiet = false): Promise<ApiResponse<BreakGlassCaseAnswer>> {
    return this.signed('/get-break-glass-case', { caseId }, quiet);
  }

  /** The recovered pod's rows of one bucket, ciphertext under the bucket keys the keyholders hand out by the recovery case's lookup id; the masterpod records the view. */
  listBreakGlassCaseSecurityRecords(caseId: string, bucket: 1 | 2): Promise<ApiResponse<SecurityRecords>> {
    return this.signed('/list-break-glass-case-security-records', { caseId, bucket });
  }

  /** As /schedule-attestor-case; the person's wallet reads the event from /list-my-break-glass-moves, and the masterpod writes the person one notification, recoveryCaseScheduled (masterpod 14.7, 2026-11-11). */
  scheduleBreakGlassCase(caseId: string, at: string, meetLink: string): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus }>> {
    return this.signed('/schedule-break-glass-case', { caseId, at, meetLink });
  }

  /** One attestation per move of the case, every move exactly once, one attestorId on all, each verified by the masterpod against the signer's stored creation; two distinct pods decide the case. */
  signOffBreakGlassCase(caseId: string, attestations: BreakGlassAttestation[]): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus; signOffs: number }>> {
    return this.signed('/sign-off-break-glass-case', { caseId, attestations });
  }

  /** The validators' answers to the posted attestations, up to two per move (1 to 40 results), a failed post included; a later retry writes another event. */
  markBreakGlassCaseSent(caseId: string, validator: number, results: SentResult[]): Promise<ApiResponse<{ caseId: string; status: 'decided' }>> {
    return this.signed('/mark-break-glass-case-sent', { caseId, validator, results });
  }

  /** Final, with the five reasons; nothing happens on the ledger: the held moves stay until a cancel. */
  dismissBreakGlassCase(caseId: string, reason: BreakGlassDismissReason, note: string): Promise<ApiResponse<{ caseId: string; status: 'dismissed' }>> {
    return this.signed('/dismiss-break-glass-case', { caseId, reason, note });
  }

  // --- level setup: the person's side of a case (masterpod 13.4.5) --------------

  /** The cases where this pod is a party, newest first, trades and disputes apart. */
  listMyCases(quiet = false): Promise<ApiResponse<MyCasesAnswer>> {
    return this.signed('/list-my-cases', {}, quiet);
  }

  getMyCase(caseId: string, quiet = false): Promise<ApiResponse<MyCaseAnswer>> {
    return this.signed('/get-my-case', { caseId }, quiet);
  }

  /** The person's lookup id (hex, 32 bytes) for a trade case of theirs, from the identity blob opened in session. */
  shareLookupId(caseId: string, lookupId: string): Promise<ApiResponse<{ caseId: string; status: AttestorCaseStatus }>> {
    return this.signed('/share-lookup-id', { caseId, lookupId });
  }

  /** New files, and files of the caller's from other cases supplied again under `existing`; at least one over both. */
  addDisputeEvidence(caseId: string, files: EvidenceFile[] = [], existing: ExistingEvidence[] = []): Promise<ApiResponse<{ evidenceIds: string[] }>> {
    const body: Record<string, unknown> = { caseId };
    if (files.length > 0) body['files'] = files;
    if (existing.length > 0) body['existing'] = existing;
    return this.signed('/add-dispute-evidence', body);
  }

  // --- level setup: DAO (masterpod spec 15) ---------------------------------

  /** A proposal, the title and the body trimmed; 201 { proposalId, status }, status open when the proposer's own weight alone reaches the support needed. Refusals: 400 invalid title / invalid body, 503 validators unreachable, 403 not enough DAO votes, 409 a pending proposal is already open. Up to 5 seconds per validator URL while validators are slow or down. */
  createDaoProposal(title: string, body: string): Promise<ApiResponse<{ proposalId: string; status: DaoStatus }>> {
    return this.signed('/create-dao-proposal', { title, body });
  }

  /** The caller's weight in support of a pending proposal; 200 { proposalId, status, support, needed }, status open when the support reached needed. Refusals: 404 unknown proposal, 409 proposal not pending / proposal expired / already supported, 403 no DAO votes in this proposal. */
  supportDaoProposal(proposalId: string): Promise<ApiResponse<{ proposalId: string; status: DaoStatus; support: number; needed: number }>> {
    return this.signed('/support-dao-proposal', { proposalId });
  }

  /** The caller's vote on an open proposal; 200 { proposalId, for, against, yourVote }, the sums after the write. Refusals: 404 unknown proposal, 409 proposal not open / voting closed / already voted, 403 no DAO votes in this proposal. */
  voteDaoProposal(proposalId: string, vote: 'for' | 'against'): Promise<ApiResponse<{ proposalId: string; for: number; against: number; yourVote: 'for' | 'against' }>> {
    return this.signed('/vote-dao-proposal', { proposalId, vote });
  }

  /** One list, newest first, expired proposals never; no more flag: the next page is offset += limit and a short page is the last. The settings ride with every answer. */
  listDaoProposals(filters: DaoListFilters, quiet = false): Promise<ApiResponse<{ proposals: DaoProposalItem[]; settings: DaoSettings }>> {
    return this.signed('/list-dao-proposals', filters, quiet);
  }

  /** One proposal with its text, an expired one too; 404 unknown proposal. */
  getDaoProposal(proposalId: string): Promise<ApiResponse<{ proposal: DaoProposal }>> {
    return this.signed('/get-dao-proposal', { proposalId });
  }

  /** The supports (`pending`) or the votes (`official`) of a proposal, newest first, limit 1 to 200; 404 unknown proposal. */
  listDaoVotes(proposalId: string, stage: 'pending' | 'official', limit = 50, offset = 0): Promise<ApiResponse<{ votes: DaoVoteItem[] }>> {
    return this.signed('/list-dao-votes', { proposalId, stage, limit, offset });
  }

  // --- plumbing -----------------------------------------------------------

  /** A signed call: the envelope for the masterpod's `path`, posted through the proxy. */
  private signed<T>(path: string, body: object, quiet = false): Promise<ApiResponse<T>> {
    const envelope = this.session.sign(path, body);
    if (!envelope) return Promise.resolve({ ok: false, status: 0, body: { error: this.lang.words().api.noSession } as T });
    return this.post<T>(path, envelope, quiet);
  }

  private post<T>(path: string, body: unknown, quiet = false): Promise<ApiResponse<T>> {
    return this.log.post<T>(BASE + path, body, quiet);
  }
}
