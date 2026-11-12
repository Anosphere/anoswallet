import { Injectable, inject } from '@angular/core';
import { AttestationPayload, Envelope, EscrowVerdictPayload, FollowUp, HybridPublicKey, SignOffMessage, Signatures, Verdict } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, LogService } from './log.service';
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

/** An image on the wire: the content type and the bytes as base64 (plaintext for a selfie, ciphertext in a bucket). */
export interface Image {
  contentType: string;
  image: string;
}

/** The purposes of /challenge: the two of masterpod spec 5 and the three recovery ones of 12.4.2. */
export type ChallengePurpose = 'create' | 'unlock' | 'openCase' | 'unlockCase' | 'recover';

export interface ChallengeAnswer {
  challenge: string;
  anopodId?: string;
  /** openCase only (2026-11-08): the username of the pod the anoPod id names, shown as the account found. */
  username?: string;
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
  chatPrivateKeyBlob: string | null;
  identityBlob: string | null;
  ephemeralExpiresAt: string;
}

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
  /** The room's newest message, null when it has none. */
  lastMessage: MessageItem | null;
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

export interface RoomsAnswer {
  rooms: RoomItem[];
  invites: InviteItem[];
  joinRequests: JoinRequestItem[];
}

export interface PublicRoomItem {
  chatRoomId: string;
  name: string;
  creator: Profile;
  memberCount: number;
  createdAt: string;
}

export interface MessageItem {
  messageId: string;
  position: number;
  senderAnopodId: string;
  message: string;
  createdAt: string;
}

/** The query of /list-messages: the messages after a position, or with `beforePosition` the newest `limit` below it, afterPosition then ignored. */
export interface MessagesQuery {
  afterPosition?: number;
  beforePosition?: number;
  limit?: number;
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

/** The body of /create-anos-account (wallet spec 4.4). */
export interface CreateAnosAccountBody {
  accountId: string;
  accountType: string;
  keyBlob: string;
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
  contactEmail: string;
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
  case: { caseId: string; status: CaseStatus; lookupId: string; contactEmail: string; createdAt: string; updatedAt: string };
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
 * routes of masterpod 14.4 and the DAO routes of masterpod 15 (2026-11-08)),
 * so no page builds URLs or envelopes. The session service holds the session and signs.
 */
@Injectable({ providedIn: 'root' })
export class MasterpodApiService {
  private readonly log = inject(LogService);
  private readonly lang = inject(LanguageService);
  private readonly session = inject(SessionService);

  // --- level none ---------------------------------------------------------

  /** A challenge for `purpose`; openCase takes the anoPod id the keyholders named for the lookup id and answers that pod's username (masterpod 12.4.2, 2026-11-08). */
  challenge(purpose: ChallengePurpose, anopodId?: string): Promise<ApiResponse<ChallengeAnswer>> {
    return this.post('/challenge', anopodId === undefined ? { purpose } : { purpose, anopodId });
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

  listChatRooms(quiet = false): Promise<ApiResponse<RoomsAnswer>> {
    return this.signed('/list-chat-rooms', {}, quiet);
  }

  listPublicChatRooms(): Promise<ApiResponse<{ rooms: PublicRoomItem[] }>> {
    return this.signed('/list-public-chat-rooms', {});
  }

  /** The room's messages after a position (the poll), or with `beforePosition` the newest `limit` below it (opening a room, loading older ones). */
  listMessages(chatRoomId: string, query: MessagesQuery, quiet = false): Promise<ApiResponse<{ messages: MessageItem[] }>> {
    return this.signed('/list-messages', { chatRoomId, ...query }, quiet);
  }

  sendMessage(chatRoomId: string, message: string): Promise<ApiResponse<{ messageId: string; position: number }>> {
    return this.signed('/send-message', { chatRoomId, message });
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

  listAnosAccounts(quiet = false): Promise<ApiResponse<{ accounts: AnosAccountListItem[] }>> {
    return this.signed('/list-anos-accounts', {}, quiet);
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

  // --- level setup: after a recovery (masterpod 12.4.5) and the break-glass moves (masterpod 14.4.1) ---

  /** The new backup code's blob2 and keys, with the proof by the current code (CryptoService.backupCodeProof over the RotationMessage). */
  rotateBackupCode(body: RotateBackupCodeBody): Promise<ApiResponse<{ anopodId: string; rotated: boolean }>> {
    return this.signed('/rotate-backup-code', body);
  }

  /** The caller's break-glass cases, newest first, each with its moves and the events the person may see (masterpod 14.4.1): what a lost account's card reads. /store-break-glass-blob is no longer called (2026-11-08). */
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

  /** As /schedule-attestor-case; the person's wallet reads the event from /list-my-break-glass-moves, no notification is sent. */
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
