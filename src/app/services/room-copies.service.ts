import { Injectable, effect, inject, untracked } from '@angular/core';
import { CryptoService } from './crypto.service';
import { Bytes } from './passkey.service';
import { SessionService } from './session.service';

/** A decrypted text as a copy holds it (2026-11-25): the text, or the fact that it did not open under the room key. The sentence the thread shows in the place of a text that did not open is never kept: the conversation page makes it when it draws the thread, in the language of that moment. */
export type KeptText = { opened: true; text: string } | { opened: false };

/** One message of a room as a copy holds it (2026-11-25): its id, its position, its sender, its time and its own text, already decrypted. `own` is null when the row came without its ciphertext, and when an edit or a delete names the message: the text of before is not kept. */
export interface KeptMessage {
  messageId: string;
  position: number;
  senderAnopodId: string;
  createdAt: string;
  own: KeptText | null;
}

/** The newest row that names a message, as a copy holds it (2026-11-25): a delete, or an edit with its text. */
export type KeptChange = { kind: 'delete'; position: number } | { kind: 'edit'; position: number; text: KeptText };

/**
 * The copy of one room's thread, as the conversation page last had it
 * (2026-11-25; forclaude/chat-rooms-kept-plan-1.md, section 7; wallet spec
 * 8.3). `messages` holds each message once, by its id, oldest first.
 * `changes` holds, for each message that an edit or a delete names, the
 * newest such row; `target` is the id of the message it names. `lowest`
 * and `highest` are the lowest and the highest position the page's reads
 * have covered, 0 and 0 for a room with no row. `highest` is never the
 * position of a message the person has just sent, nor of their own edit
 * or delete: the read that follows brings those rows. `olderLeft` says
 * whether the masterpod has rows below `lowest`.
 *
 * A copy holds nothing that the page works out from a text (the pieces,
 * the sticker, a trade's grey line), no message that is still being sent,
 * and not how far the other members have read.
 */
export interface RoomCopy {
  messages: KeptMessage[];
  changes: { target: string; change: KeptChange }[];
  lowest: number;
  highest: number;
  olderLeft: boolean;
}

/** What the entry of a room holds in the browser's database, before it is encrypted: version 1 and the copy. */
type StoredCopy = { v: 1 } & RoomCopy;

/** The browser's database keeps a room's newest messages, at most this many (2026-11-25; the plan's section 4, point 1). */
const KEPT_MESSAGES = 200;

/** It keeps fewer when the texts of those messages are over this many bytes of UTF-8 together: one message can be 64 KB, and a room of very long messages would make every write slow. */
const KEPT_TEXT_BYTES = 1_000_000;

/**
 * The chat rooms' copies (2026-11-25; forclaude/chat-rooms-kept-plan-1.md;
 * wallet spec 8.2, Chat, and 8.3). For every room a person has opened,
 * the wallet keeps a copy of the room's thread, so that a way back into
 * the room shows its messages at once and the masterpod is asked only
 * for what is new.
 *
 * A copy is in two places. In the page's memory it is everything the
 * conversation page has read of the room, until the page is loaded
 * again, which Lock does too, or until another pod logs in. In the
 * browser's own database (IndexedDB) it is the room's newest
 * KEPT_MESSAGES messages, one entry for each room, encrypted with the
 * anoPod encryption key (wrapJson); no key is stored with it, so it
 * opens only after a passkey login of the same pod. It stays after Lock.
 *
 * The conversation page stays the one place that holds the open room's
 * thread. It hands a copy over each time an answer of the masterpod
 * changed the thread (keep), and takes the room's copy back when the
 * room opens: from memory (held), else from the browser's database
 * (stored). A copy is dropped when the room moved on too far for it
 * (drop, the page's call), when it is ahead of the masterpod (stored),
 * and when the room is not in a whole chat list that arrives (keepOnly,
 * chat.service's call).
 *
 * The database is the rooms' own, with the code that opens it at the end
 * of this file. The chat with Joy is in another database, which nothing
 * here opens.
 */
@Injectable({ providedIn: 'root' })
export class RoomCopiesService {
  private readonly session = inject(SessionService);
  private readonly crypto = inject(CryptoService);

  /** The copies in the page's memory, by the room's id. */
  private readonly copies = new Map<string, RoomCopy>();
  /** The pod whose copies are held here; null while none is. */
  private heldFor: string | null = null;
  /** Counts the pods this service has seen. A read of the browser's database that began under an earlier number is dropped. */
  private login = 0;
  /** The copies that wait to be written to the browser's database, by their entry's key: for each room the newest one, with the key it is encrypted under. */
  private readonly waiting = new Map<string, { copy: RoomCopy; key: Bytes }>();
  /** The writes to the browser's database, one after the other, so an older copy never lands on a newer one. */
  private writing: Promise<void> = Promise.resolve();

  constructor() {
    // Another pod in this tab, or none: nothing of the pod before stays here.
    effect(() => {
      this.session.anopodId();
      untracked(() => this.pod());
    });
  }

  /** The room's copy in the page's memory, or null. */
  held(chatRoomId: string): RoomCopy | null {
    return this.pod() === null ? null : (this.copies.get(chatRoomId) ?? null);
  }

  /**
   * The room's copy from the browser's database, opened: one read and one
   * decryption. Null when there is none, when the entry does not open
   * under this anoPod encryption key or is not a copy, and when the
   * browser refuses its database: the room then opens as it did before
   * there were copies. `lastPosition` is the room's in the chat list. A
   * copy whose highest position is above it is ahead of the masterpod,
   * whose database was put back from a backup: it is dropped, and the
   * answer is null. A copy that is found is in the page's memory from
   * then on.
   */
  async stored(chatRoomId: string, lastPosition: number): Promise<RoomCopy | null> {
    const anopodId = this.pod();
    const key = this.session.getEncryptionKey();
    if (anopodId === null || key === null) return null;
    const login = this.login;
    let copy: RoomCopy | null = null;
    try {
      // A write or a delete that is still on its way lands first.
      await this.writing;
      const blob = await readEntry(entryKey(anopodId, chatRoomId));
      if (blob !== null) copy = copyOf(await this.crypto.unwrapJson<unknown>(blob, key));
    } catch {
      // A browser that refuses its database, or an entry that does not open: no copy.
    }
    if (login !== this.login) return null;
    // A copy that was handed over while this read was on its way is the newer one.
    const held = this.copies.get(chatRoomId);
    if (held) return held;
    if (copy === null) return null;
    if (copy.highest > lastPosition) {
      this.drop(chatRoomId);
      return null;
    }
    this.copies.set(chatRoomId, copy);
    return copy;
  }

  /**
   * The conversation page hands the room's thread over, as it stands. The
   * copy is kept whole in the page's memory, and its newest messages go
   * into the browser's database, encrypted (cut). Nothing is kept for a
   * room that is not in the chat list in memory: an answer that was on its
   * way while the person left the room does not bring a deleted copy back.
   * Without the anoPod encryption key the copy stays in the page's memory
   * alone. When a copy of the room already waits to be written, this one
   * takes its place: only the newest is written.
   */
  keep(chatRoomId: string, copy: RoomCopy): void {
    const anopodId = this.pod();
    if (anopodId === null || !this.session.chatRooms()?.rooms.some((room) => room.chatRoomId === chatRoomId)) return;
    this.copies.set(chatRoomId, copy);
    const key = this.session.getEncryptionKey();
    if (key === null) return;
    const entry = entryKey(anopodId, chatRoomId);
    const queued = this.waiting.has(entry);
    this.waiting.set(entry, { copy, key });
    if (queued) return;
    this.queue(async () => {
      const next = this.waiting.get(entry);
      if (!next) return;
      this.waiting.delete(entry);
      const stored: StoredCopy = { v: 1, ...cut(next.copy) };
      await writeEntry(entry, await this.crypto.wrapJson(stored, next.key));
    });
  }

  /** The room's copy is dropped, in the page's memory and in the browser's database. */
  drop(chatRoomId: string): void {
    const anopodId = this.pod();
    if (anopodId === null) return;
    this.copies.delete(chatRoomId);
    const entry = entryKey(anopodId, chatRoomId);
    this.waiting.delete(entry);
    this.queue(() => deleteEntry(entry));
  }

  /**
   * A whole chat list arrived, and `chatRoomIds` are its rooms: the copy
   * of every other room is deleted, in the page's memory and, for this
   * pod's entries, in the browser's database. That is how a room's copy
   * goes when the person leaves the room, on this phone or on another.
   * Another pod's entries in the same browser are not touched. The look
   * into the browser's database makes that database when it is not there
   * yet, so a browser has it, empty, from a login's first chat list on.
   */
  keepOnly(chatRoomIds: ReadonlySet<string>): void {
    const anopodId = this.pod();
    if (anopodId === null) return;
    for (const chatRoomId of [...this.copies.keys()]) {
      if (!chatRoomIds.has(chatRoomId)) this.copies.delete(chatRoomId);
    }
    const start = entryKey(anopodId, '');
    for (const entry of [...this.waiting.keys()]) {
      if (entry.startsWith(start) && !chatRoomIds.has(entry.slice(start.length))) this.waiting.delete(entry);
    }
    this.queue(async () => {
      for (const entry of await entriesOf(anopodId)) {
        if (!chatRoomIds.has(entry.slice(start.length))) await deleteEntry(entry);
      }
    });
  }

  /** The pod of the session, or null. When it is another than the one whose copies are held here, the memory is emptied first: nothing of the pod before stays. */
  private pod(): string | null {
    const anopodId = this.session.anopodId();
    if (anopodId !== this.heldFor) {
      this.copies.clear();
      this.heldFor = anopodId;
      this.login += 1;
    }
    return anopodId;
  }

  /** One more write to the browser's database, after the ones before it. A write that fails is passed over: private mode, blocked storage or no room, and the copy then stays in the page's memory alone. */
  private queue(write: () => Promise<unknown>): void {
    this.writing = this.writing.then(async () => {
      try {
        await write();
      } catch {
        // The tab keeps its copy.
      }
    });
  }
}

/**
 * The copy as the browser's database keeps it (2026-11-25; the plan's
 * section 7): the newest KEPT_MESSAGES messages, and fewer when their
 * texts together are over KEPT_TEXT_BYTES bytes of UTF-8. A message's
 * texts are its own and that of the edit kept for it. The newest message
 * is always kept. A copy that is within both numbers is kept as it is.
 * One that is cut gets the position of its oldest kept message as its
 * lowest position, and older messages are then left on the masterpod. Of
 * the edits and the deletes it keeps those whose own position is above
 * that lowest position, also when the message one names is not kept:
 * that message comes without its ciphertext with a later read of older
 * rows, and is drawn by this row. The copy in the page's memory is never
 * cut.
 */
function cut(copy: RoomCopy): RoomCopy {
  const edits = new Map<string, KeptText>();
  for (const { target, change } of copy.changes) {
    if (change.kind === 'edit') edits.set(target, change.text);
  }
  let first = copy.messages.length;
  let bytes = 0;
  while (first > 0 && copy.messages.length - first < KEPT_MESSAGES) {
    const message = copy.messages[first - 1];
    const next = bytes + bytesOf(message.own) + bytesOf(edits.get(message.messageId) ?? null);
    if (next > KEPT_TEXT_BYTES && first < copy.messages.length) break;
    bytes = next;
    first -= 1;
  }
  if (first === 0) return copy;
  const lowest = copy.messages[first].position;
  return { messages: copy.messages.slice(first), changes: copy.changes.filter(({ change }) => change.position > lowest), lowest, highest: copy.highest, olderLeft: true };
}

/** The bytes of a kept text as UTF-8; 0 for none and for one that did not open. */
function bytesOf(text: KeptText | null): number {
  return text !== null && text.opened ? new TextEncoder().encode(text.text).length : 0;
}

/**
 * The copy that an opened entry of the browser's database holds, or null
 * when the entry is not one: another version, or a part that has not the
 * form this file writes. Nothing of such an entry is used. The page draws
 * a thread from what this answers, so every part is checked and nothing
 * else is taken over.
 */
function copyOf(value: unknown): RoomCopy | null {
  if (typeof value !== 'object' || value === null) return null;
  const { v, messages, changes, lowest, highest, olderLeft } = value as Record<string, unknown>;
  if (v !== 1 || !Array.isArray(messages) || !Array.isArray(changes) || !isPosition(lowest) || !isPosition(highest) || typeof olderLeft !== 'boolean') return null;
  const copy: RoomCopy = { messages: [], changes: [], lowest, highest, olderLeft };
  for (const entry of messages) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { messageId, position, senderAnopodId, createdAt, own } = entry as Record<string, unknown>;
    const text = own === null ? null : textOf(own);
    if (typeof messageId !== 'string' || !isPosition(position) || typeof senderAnopodId !== 'string' || typeof createdAt !== 'string' || text === undefined) return null;
    copy.messages.push({ messageId, position, senderAnopodId, createdAt, own: text });
  }
  for (const entry of changes) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { target, change } = entry as Record<string, unknown>;
    if (typeof target !== 'string' || typeof change !== 'object' || change === null) return null;
    const { kind, position, text } = change as Record<string, unknown>;
    if (!isPosition(position)) return null;
    if (kind === 'delete') {
      copy.changes.push({ target, change: { kind, position } });
    } else {
      const edited = textOf(text);
      if (kind !== 'edit' || edited === undefined) return null;
      copy.changes.push({ target, change: { kind, position, text: edited } });
    }
  }
  return copy;
}

/** A kept text out of an opened entry; undefined when the value is not one. */
function textOf(value: unknown): KeptText | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { opened, text } = value as Record<string, unknown>;
  if (opened === false) return { opened };
  return opened === true && typeof text === 'string' ? { opened, text } : undefined;
}

/** True for a position as the masterpod counts them: a whole number, 0 or above. */
function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The browser's database of the chat rooms, and the place in it where their copies are kept: one entry for each room. It is the rooms' own. The chat with Joy is kept in another database, which nothing in this file opens. */
const DB_NAME = 'anopod-wallet-chat';
const STORE = 'chat-messages';

/** The key of a room's entry: the anoPod's id, one space, the room's id. Both ids are hex, so the space parts them, and another pod in the same browser has entries of its own. */
function entryKey(anopodId: string, chatRoomId: string): string {
  return `${anopodId} ${chatRoomId}`;
}

/** Opens the database, and makes the place for the copies the first time. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the database is blocked'));
  });
}

/** One read or write of the place, in a transaction of its own; resolves with what the request answered once the transaction is done. */
async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The blob kept under an entry's key, or null. */
async function readEntry(entry: string): Promise<Uint8Array | null> {
  const blob: unknown = await inStore('readonly', (store) => store.get(entry));
  return blob instanceof Uint8Array ? blob : null;
}

function writeEntry(entry: string, blob: Uint8Array): Promise<unknown> {
  return inStore('readwrite', (store) => store.put(blob, entry));
}

function deleteEntry(entry: string): Promise<unknown> {
  return inStore('readwrite', (store) => store.delete(entry));
}

/** The keys of the entries that are the pod's: every key that begins with the anoPod's id and one space. */
async function entriesOf(anopodId: string): Promise<string[]> {
  const keys = await inStore('readonly', (store) => store.getAllKeys(IDBKeyRange.bound(entryKey(anopodId, ''), `${anopodId}!`, false, true)));
  return keys.filter((key): key is string => typeof key === 'string');
}
