import { Injectable, computed, inject, signal } from '@angular/core';
import type { StickerSet } from '../stickers';
import { ChatKeys, CryptoService, Envelope, HybridPublicKey, SessionKeys } from './crypto.service';
import type { RoomsAnswer } from './masterpod-api.service';
import { Bytes } from './passkey.service';

/** What /check-anopod-status answers, the three counts and, since 2026-11-08, the role included (wallet spec 4.3). */
export interface StatusAnswer {
  anopodId: string;
  vouched: boolean;
  vouchCount: number;
  setupComplete: boolean;
  isSeed: boolean;
  isSuperSeed: boolean;
  bucketOneImages: number;
  bucketTwoImages: number;
  bucketTwoInfos: number;
  /** The pod's live appointment (masterpod spec 16): moderator, attestor, validator or masterPod (the last two since 2026-11-10, masterpod spec 16.7), or null when it holds none; an older masterpod sends no field. */
  role?: 'moderator' | 'attestor' | 'validator' | 'masterPod' | null;
}

/** The two ids of docs/public-ledger-id.md, hex. */
export interface Identity {
  publicLedgerId: string;
  lookupId: string;
}

/** An anos account as the masterpod lists it: the keyBlob ciphertext (under the key blob key since 2026-11-08) and the creation, never open keys. Since 2026-11-20 the keyBlob is the account's first key blob, pair one alone, once the account has one, and the blob with both pairs only until then; firstKeyOnly says which (masterpod spec 22, wallet spec 4.11). */
export interface AnosAccountItem {
  accountId: string;
  accountType: string;
  keyBlob: string;
  /** True when keyBlob is the account's first key blob, pair one alone; false when the account has none yet and keyBlob is the blob with both pairs (2026-11-20, masterpod spec 22). An older masterpod sends no field. */
  firstKeyOnly?: boolean;
  creation: { payload: Record<string, unknown>; signatures: Record<string, string> };
  submittedAt: string | null;
  createdAt: string;
}

/** One notification as /list-notifications answers it. Since 2026-11-25 (wallet spec 4.22; masterpod spec 34) with `seq`, the row's running number on the masterpod: a later notification has a higher one. A masterpod of before sends none. */
export interface NotificationItem {
  notificationNumber: string;
  kind: string;
  referenceId: string;
  read: boolean;
  createdAt: string;
  seq?: number;
}

/** What /list-notifications answers since 2026-11-25 (wallet spec 4.22; masterpod spec 34): the rows, the highest `seq` first, and three numbers of the pod's whole list, whatever the request asked for: `seq`, the highest number among the pod's notifications, 0 when it has none; `count`, how many notifications the pod has; `unread`, how many of them are unread. A masterpod of before sends the rows alone. */
export interface NotificationsAnswer {
  notifications: NotificationItem[];
  seq?: number;
  count?: number;
  unread?: number;
}

/** A keyholder's number and receiving key, as /get-keyholder-public-key answers it. */
export interface KeyholderPublicKey {
  keyholderId: number;
  receivingKey: HybridPublicKey;
}

/**
 * One browser tab is one anoPod (wallet spec 8.3). Everything secret lives
 * here in plain fields, never in a signal and never on the wire, and dies
 * with the tab; what the pages show is in signals. The session keys sign
 * every masterpod and keyholder request (sign()); the next-step rule is
 * nextStep().
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly crypto = inject(CryptoService);

  // --- secrets, never in a signal and never on the wire -------------------
  private sessionKeys: SessionKeys | null = null;
  private prfOutput: Bytes | null = null;
  /** The key blob key (CryptoService.deriveKekKeys), what the account key blobs open under since 2026-11-08; set with the PRF output at every unlock and create. */
  private keyBlobKey: Bytes | null = null;
  private encryptionKey: Bytes | null = null;
  private chatKeys: ChatKeys | null = null;
  private identity: Identity | null = null;

  /** Room keys unwrapped this session, by chat room id. */
  readonly roomKeys = new Map<string, Bytes>();

  /** The keyholders' receiving keys, fetched once per session, by keyholder number. */
  readonly keyholderKeys = new Map<number, KeyholderPublicKey>();

  // --- what the pages show --------------------------------------------------
  readonly anopodId = signal<string | null>(null);
  readonly username = signal('');
  readonly firstName = signal('');
  readonly lastName = signal('');
  readonly status = signal<StatusAnswer | null>(null);
  readonly hasPrf = signal(false);
  readonly hasKeyBlobKey = signal(false);
  readonly hasEncryptionKey = signal(false);
  readonly hasChatKeys = signal(false);
  readonly hasIdentity = signal(false);
  /** The credential id, hex, of the passkey that opened this session; the Passkeys page marks it, and, since 2026-11-19, the passkey check asks the device for this one passkey at every button that ends in something signed with an account's key (passkey-check.ts, wallet spec 8.9); since 2026-11-20 its answer, given for exactly what was built, goes to the signing server with the request (askSigningPasskey). */
  readonly passkeyCredentialId = signal<string | null>(null);
  /** The pod's anos accounts from /list-anos-accounts. */
  readonly accounts = signal<AnosAccountItem[]>([]);
  /** The notifications in memory, newest first, null until the first answer of /list-notifications. Until 2026-11-25 it was that route's latest answer, the newest 100, set anew every 5 seconds. Since then (wallet spec 4.22; the plan is forclaude/notifications-page-plan-1.md) the first read of a login brings the newest 30, the shell's 5-second read brings only the rows that are new, which go on top, and the Notifications page's "Show older" puts older rows at the end. A read that brings no row does not set it anew. */
  readonly notifications = signal<NotificationItem[] | null>(null);
  /** The list's `seq` (2026-11-25, masterpod spec 34): the `seq` of the answer of /list-notifications that was last put into the list, which the next read of what is new sends as `since`, and up to which the Notifications page marks everything read. Null while there is no list, and after an answer that carried no number (a masterpod of before): the next read then asks for the first page. */
  notificationsSeq: number | null = null;
  /** The list's `count` (2026-11-25): how many notifications the pod has in all, by the answer that was last put into the list. "Show older" stands on the Notifications page while the list holds fewer rows. */
  readonly notificationsCount = signal(0);
  /** The list's `unread`: how many of the pod's notifications are unread, all of them and not only the rows in memory. It is the number on the Notifications entry of the menu, on its Home tile and in Home's line. Until 2026-11-25 it was the unread rows among the newest 100, as a list. */
  readonly unread = signal(0);
  /** How many times a first page was put into the list (putNotifications). The Notifications page reads it: with a filter on, it reads that filter's first page again each time. */
  readonly notificationPages = signal(0);
  /** How many answers of /mark-notifications-read have come (putNotificationsRead). An answer of /list-notifications that was asked for before a mark's answer came can carry the rows and the number of before the mark, so it is dropped: whoever asks looks at this count before and after. */
  notificationMarks = 0;
  /** The clock's minute, as a signal (2026-11-25; wallet spec 4.22). A row of the Notifications page words its time by the clock ("Just now", "5 min ago", "3 h ago", "Yesterday"). The page reads this signal, so those words are drawn again each minute and at midnight. The shell's 5-second read of the notifications looks at the clock; it runs for every logged-in pod, before setup is complete too. */
  readonly minute = signal(Math.floor(Date.now() / 60_000));
  /** The chat list in memory (the rooms, the invites to this pod, the join requests on its rooms), null until the first answer of /list-chat-rooms. Until 2026-11-24 it was that route's latest answer, set anew every 5 seconds. Since then (wallet spec 4.17; chat.service.ts) only the first read of a login and the read after a person's own action bring the whole list; the shell's 5-second read and the Chat page's opening bring what is new, which is put into this list, and the open conversation's read writes the members' seen positions into it. It is set anew only when something in it changed. */
  readonly chatRooms = signal<RoomsAnswer | null>(null);
  /** The number of that list (2026-11-24, masterpod spec 29): the `seq` of the answer of /list-chat-rooms that was last put into it, which the next read of what is new sends as `since`. Null while there is no list, and after an answer that carried no number (a masterpod of before): the next read then asks for the whole list. */
  chatRoomsSeq: number | null = null;
  /** The stickers of the wallet's chat as /list-stickers answered them for this login (wallet spec 4.16; 2026-11-23): the sets in the order of their row. Null until that answer has arrived; stickers.service asks for it when a conversation is first opened, once after each login. */
  readonly stickerSets = signal<StickerSet[] | null>(null);
  /** The last message position seen in each room on this device (wallet spec 8.2, Chat), kept in localStorage per pod. */
  readonly seenPositions = signal<Record<string, number>>({});
  /** The rooms whose newest message is by someone else and above the seen position (0 when the room was never opened here). */
  readonly unreadRooms = computed(() => {
    const me = this.anopodId();
    const seen = this.seenPositions();
    return (this.chatRooms()?.rooms ?? []).filter(
      (r) => r.lastMessage !== null && r.lastMessage.senderAnopodId !== me && r.lastMessage.position > (seen[r.chatRoomId] ?? 0),
    );
  });
  readonly unreadRoomCount = computed(() => this.unreadRooms().length);

  readonly hasSession = computed(() => this.anopodId() !== null);
  readonly vouched = computed(() => this.status()?.vouched ?? false);
  readonly setupComplete = computed(() => this.status()?.setupComplete ?? false);
  readonly isSeed = computed(() => (this.status()?.isSeed || this.status()?.isSuperSeed) ?? false);
  /** The pod's appointed role from the status (wallet spec 4.3, 2026-11-08): moderator, attestor, validator or masterPod (the last two since 2026-11-10); null when it holds none; undefined while there is no status, or the masterpod sent no role. */
  readonly role = computed(() => this.status()?.role);

  /**
   * Opens the session: the pod, its session keys, its profile. Everything
   * else starts empty, unless the same pod unlocks again in this tab (setup
   * asking for the PRF output), which keeps what is in RAM and only replaces
   * the session keys.
   */
  open(anopodId: string, keys: SessionKeys, username: string): void {
    if (this.anopodId() !== anopodId) this.close();
    this.sessionKeys = keys;
    this.anopodId.set(anopodId);
    this.username.set(username);
    this.seenPositions.set(readSeen(anopodId));
  }

  /** Drops everything: a closed tab does the same. */
  close(): void {
    this.sessionKeys = null;
    this.prfOutput = null;
    this.keyBlobKey = null;
    this.encryptionKey = null;
    this.chatKeys = null;
    this.identity = null;
    this.roomKeys.clear();
    this.keyholderKeys.clear();
    this.anopodId.set(null);
    this.username.set('');
    this.firstName.set('');
    this.lastName.set('');
    this.status.set(null);
    this.hasPrf.set(false);
    this.hasKeyBlobKey.set(false);
    this.hasEncryptionKey.set(false);
    this.hasChatKeys.set(false);
    this.hasIdentity.set(false);
    this.passkeyCredentialId.set(null);
    this.accounts.set([]);
    this.notifications.set(null);
    this.notificationsSeq = null;
    this.notificationsCount.set(0);
    this.unread.set(0);
    this.chatRooms.set(null);
    this.chatRoomsSeq = null;
    this.stickerSets.set(null);
    this.seenPositions.set({});
  }

  /**
   * The masterpod's section 3 envelope for `path`: the payload with this
   * pod's id, the path, now, a fresh 16-byte nonce and the body, signed by
   * the session keys. Null when no session is open. The path is the
   * backend's path (/complete-setup), not the proxy's.
   */
  sign(path: string, body: object): Envelope | null {
    const anopodId = this.anopodId();
    if (!this.sessionKeys || anopodId === null) return null;
    const payload = { anopodId, path, timestamp: new Date().toISOString(), nonce: this.crypto.randomHex(16), body };
    return { payload, signatures: this.crypto.signPayload(this.sessionKeys, payload) };
  }

  // --- the secrets ----------------------------------------------------------

  setPrfOutput(output: Bytes | null): void {
    this.prfOutput = output;
    this.hasPrf.set(output !== null);
  }

  getPrfOutput(): Bytes | null {
    return this.prfOutput;
  }

  setKeyBlobKey(key: Bytes | null): void {
    this.keyBlobKey = key;
    this.hasKeyBlobKey.set(key !== null);
  }

  getKeyBlobKey(): Bytes | null {
    return this.keyBlobKey;
  }

  setEncryptionKey(key: Bytes | null): void {
    this.encryptionKey = key;
    this.hasEncryptionKey.set(key !== null);
  }

  getEncryptionKey(): Bytes | null {
    return this.encryptionKey;
  }

  setChatKeys(keys: ChatKeys | null): void {
    this.chatKeys = keys;
    this.hasChatKeys.set(keys !== null);
  }

  getChatKeys(): ChatKeys | null {
    return this.chatKeys;
  }

  setIdentity(identity: Identity | null): void {
    this.identity = identity;
    this.hasIdentity.set(identity !== null);
  }

  getIdentity(): Identity | null {
    return this.identity;
  }

  // --- what was seen in chat (wallet spec 8.2, Chat) --------------------------

  /** A newer position seen in the room: kept, and written to this device. */
  markSeen(chatRoomId: string, position: number): void {
    const anopodId = this.anopodId();
    if (anopodId === null || position <= (this.seenPositions()[chatRoomId] ?? 0)) return;
    const next = { ...this.seenPositions(), [chatRoomId]: position };
    this.seenPositions.set(next);
    writeSeen(anopodId, next);
  }

  // --- the notifications in memory (wallet spec 4.22, 2026-11-25) --------------

  /**
   * A first page of /list-notifications becomes the list in memory, and the
   * answer's three numbers the list's. The first read after a login or a
   * page load, by the shell or by the Notifications page, and the shell's
   * read of the first page after it missed a row. An answer without the
   * numbers, from a masterpod of before, is taken as the first page too:
   * the list then has no `seq`, so the next read asks for the first page
   * again, its count is the rows that came, and its unread number the
   * unread rows among them.
   */
  putNotifications(answer: NotificationsAnswer): void {
    const rows = answer.notifications;
    const numbered = typeof answer.seq === 'number' && typeof answer.count === 'number' && typeof answer.unread === 'number';
    this.notifications.set(rows);
    this.notificationsSeq = numbered ? (answer.seq ?? null) : null;
    this.notificationsCount.set(numbered ? (answer.count ?? 0) : rows.length);
    this.unread.set(numbered ? (answer.unread ?? 0) : rows.filter((n) => !n.read).length);
    this.notificationPages.update((n) => n + 1);
  }

  /** What a read with `since` brought: the rows go on top of the list in memory, and the answer's three numbers are the list's. When no row came, the list is not set anew. One thing more: when the masterpod says that nothing is unread, every row in memory is read, whatever it said when the row came, since the answer of a mark can be lost on its way. */
  putNewNotifications(rows: NotificationItem[], seq: number, count: number, unread: number): void {
    const list = this.notifications() ?? [];
    const held = unread === 0 && list.some((n) => !n.read) ? list.map((n) => (n.read ? n : { ...n, read: true })) : list;
    if (rows.length > 0 || held !== list) this.notifications.set([...rows, ...held]);
    this.notificationsSeq = seq;
    this.notificationsCount.set(count);
    this.unread.set(unread);
  }

  /** The masterpod has marked every notification of this pod up to the number `upTo` read (/mark-notifications-read with `upTo`): every row of the list in memory up to that number is read. The unread number is the rows above it that are still unread: none, unless a row arrived while the mark was on its way. */
  putNotificationsRead(upTo: number): void {
    const list = this.notifications();
    if (list === null) return;
    const rows = list.map((n) => (n.read || (n.seq ?? 0) > upTo ? n : { ...n, read: true }));
    this.notifications.set(rows);
    this.unread.set(rows.filter((n) => !n.read).length);
    this.notificationMarks += 1;
  }

  // --- the next-step rule (wallet spec 8.1) ---------------------------------

  /**
   * Where the pod goes next, from the status: vouching until vouched;
   * identity until setup is complete; the recovery selfie while bucket one
   * is empty; the recovery details until bucket two has an image and three
   * texts; otherwise the wallet.
   */
  nextStep(status: StatusAnswer = this.status() ?? emptyStatus()): string {
    if (!status.vouched) return '/vouching';
    if (!status.setupComplete) return '/identity';
    if (status.bucketOneImages === 0) return '/account/recovery/selfie';
    if (status.bucketTwoImages === 0 || status.bucketTwoInfos < 3) return '/account/recovery/details';
    return '/wallet';
  }
}

function emptyStatus(): StatusAnswer {
  return { anopodId: '', vouched: false, vouchCount: 0, setupComplete: false, isSeed: false, isSuperSeed: false, bucketOneImages: 0, bucketTwoImages: 0, bucketTwoInfos: 0 };
}

/** The localStorage key of a pod's seen positions. */
function seenKey(anopodId: string): string {
  return `anopod-wallet.chat-seen.${anopodId}`;
}

/** The seen positions kept on this device for the pod: empty when there are none, or the browser refuses. */
function readSeen(anopodId: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(seenKey(anopodId)) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'number') map[key] = value;
    return map;
  } catch {
    return {};
  }
}

/** Writes the seen positions; a browser that refuses leaves the copy in memory for the tab. */
function writeSeen(anopodId: string, map: Record<string, number>): void {
  try {
    localStorage.setItem(seenKey(anopodId), JSON.stringify(map));
  } catch {
    // Private mode or blocked storage: the tab keeps its copy.
  }
}
