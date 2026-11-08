import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatKeys, CryptoService, Envelope, HybridPublicKey, SessionKeys, WalletPublicKeys } from './crypto.service';
import type { RoomsAnswer } from './masterpod-api.service';
import { Bytes } from './passkey.service';

/** What /check-anopod-status answers, the three counts included (wallet spec 4.3). */
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
}

/** The two ids of docs/public-ledger-id.md, hex. */
export interface Identity {
  publicLedgerId: string;
  lookupId: string;
}

/** An anos account as the masterpod lists it: the keyBlob ciphertext (under the key blob key since 2026-11-08) and the creation, never open keys. */
export interface AnosAccountItem {
  accountId: string;
  accountType: string;
  keyBlob: string;
  creation: { payload: Record<string, unknown>; signatures: Record<string, string> };
  submittedAt: string | null;
  createdAt: string;
}

/** One notification as /list-notifications answers it. */
export interface NotificationItem {
  notificationNumber: string;
  kind: string;
  referenceId: string;
  read: boolean;
  createdAt: string;
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
  /** The wallet pair's public keys, fetched once per session from /api/sign/public-keys. */
  readonly walletKeys = signal<WalletPublicKeys | null>(null);
  /** The pod's anos accounts from /list-anos-accounts. */
  readonly accounts = signal<AnosAccountItem[]>([]);
  /** The notifications, newest first, refreshed by the shell's 5-second poll. */
  readonly notifications = signal<NotificationItem[]>([]);
  readonly unread = computed(() => this.notifications().filter((n) => !n.read));
  /** The latest /list-chat-rooms answer (the rooms, the invites to this pod, the join requests on its rooms): the shell's poll once setup is complete, and the chat pages. */
  readonly chatRooms = signal<RoomsAnswer | null>(null);
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
    this.walletKeys.set(null);
    this.accounts.set([]);
    this.notifications.set([]);
    this.chatRooms.set(null);
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
