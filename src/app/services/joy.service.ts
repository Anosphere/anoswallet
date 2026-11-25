import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { JOY_MAX_CONVERSATION_BYTES, JOY_MAX_MESSAGES, JOY_MEMORY_MAX_BYTES } from '../constants';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiError, ApiResponse, reasonOf } from './log.service';
import { JoyMessage, JoySource, JoyStop, MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/** One message of the chat with Joy as the wallet keeps it (wallet spec 4.18): who wrote it, its text and when it was sent (ISO 8601; for an answer of Joy's, when it ended). `end` stands only on an answer of Joy's that did not end as an answer should: `length`, it was cut off where the model reached its limit; `refused`, the safety check of the model's company stopped it; `cut`, the answer failed after a part of it had come. `sources` stands only on an answer of Joy's for which she cited web pages (wallet spec 4.20; 2026-11-24): those pages, as sourcesOf() checked them, never an empty list. */
export interface JoyChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  end?: 'length' | 'refused' | 'cut';
  sources?: JoySource[];
}

/** What the chat's blob holds (wallet spec 4.18): version 1 and the messages, oldest first. */
interface JoyChatBlob {
  v: 1;
  messages: JoyChatMessage[];
}

/** What the memory file's blob holds (wallet spec 4.18): version 1 and the file's text. */
interface JoyMemoryBlob {
  v: 1;
  text: string;
}

/** The last line of an answer of /ask-joy (masterpod spec 30 and 32): how an answer ended, the memory file after it and the web pages Joy cited, as sourcesOf() checked them, or the reason an answer failed. */
type LastLine = { done: true; stop: JoyStop; memory: string | null; sources: JoySource[] } | { error: string };

/**
 * Joy, the wallet's AI (wallet spec 4.18 and 8.3; 2026-11-24): the one chat
 * with her that is under way, and the member's memory file.
 *
 * The chat lives here, not in the page, so an answer that is being written
 * goes on while the member looks at another page of the wallet. After the
 * member's own message and after each answer of Joy's the whole chat is
 * encrypted with the anoPod encryption key and put into the browser's own
 * database (IndexedDB) under the anoPod's id, so a reload of the page does
 * not lose it. The masterpod keeps nothing of it. It is in this browser on
 * this device only, and New chat empties it.
 *
 * The memory file is what Joy knows of the member from earlier chats. The
 * masterpod stores it as a blob under the anoPod encryption key, which it
 * cannot open. The wallet reads the blob when a Joy page opens, sends the
 * opened text with every message, and stores the file again when the last
 * line of an answer brings a changed one.
 *
 * A message to Joy carries the newest messages of the chat that fit the
 * masterpod's limits (JOY_MAX_MESSAGES, JOY_MAX_CONVERSATION_BYTES), the
 * first of them the member's. The chat on the screen is not cut.
 *
 * Since 2026-11-24 (wallet spec 4.20) Joy can search the web. While a
 * search runs the page says so (searching). The web pages she cited come
 * in the last line of her answer and are kept with that answer, here and
 * in the kept chat. The wallet checks them when they come and again when
 * a kept chat is opened (sourcesOf), since the Joy page makes its links
 * of them. A message to Joy still carries the role and the text of each
 * message and nothing else: the sources are never sent back.
 */
@Injectable({ providedIn: 'root' })
export class JoyService {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The chat's messages, oldest first: the member's own and Joy's answers that have ended. */
  readonly messages = signal<JoyChatMessage[]>([]);
  /** The answer that is being written, as far as it has come; null while none is under way. */
  readonly answer = signal<string | null>(null);
  /** True from a send until its answer has ended or failed. */
  readonly writing = signal(false);
  /** True while Joy searches the web for the answer that is being written (wallet spec 4.20): from a line of the answer that says so until the answer's next piece comes, or until the answer ends. */
  readonly searching = signal(false);
  /** What the message box holds. It is kept here so that it outlives a visit to another page, and so that a message that was refused can be put back into it. */
  readonly draft = signal('');
  /** The page's red line: why the last message was refused or failed, or why the memory file could not be read or stored. Null when there is nothing to say. */
  readonly error = signal<string | null>(null);
  /** The opened memory file. Null until it has been read in this login; no message is sent before that, since an answer could otherwise put a new file in the place of one the wallet never saw. */
  readonly memory = signal<string | null>(null);
  /** True once the chat that this browser keeps for the pod has been looked for. */
  readonly ready = signal(false);

  /** The pod whose chat and memory file are held here; null while none is. */
  private loadedFor: string | null = null;
  /** Counts the logins this service has seen. An answer that began under an earlier number is dropped. */
  private login = 0;
  /** True when a changed memory file could not be stored: it is stored with the next answer. */
  private memoryUnsaved = false;
  /** True while a send reads the memory file before its message shows, so a second tap sends nothing. */
  private starting = false;
  /** Counts the times the memory file was set from this page, by an answer of Joy's or by the member's own Save. A read of the masterpod's blob that began before such a set is dropped: what it brings is the older file. */
  private memorySets = 0;
  /** The writes to the browser's database, one after the other, so an older chat never lands on a newer one. */
  private keeping: Promise<void> = Promise.resolve();

  constructor() {
    // Another pod in this tab, or none: nothing of the pod before stays here.
    effect(() => {
      const anopodId = this.session.anopodId();
      untracked(() => {
        if (anopodId !== this.loadedFor) this.reset();
      });
    });
  }

  /**
   * Called when a Joy page opens. The first time in a login it looks for
   * the chat this browser keeps for the pod and opens it. Every time it
   * reads the memory file from the masterpod, unless an answer is under
   * way: the file may have been changed on another device.
   */
  async open(): Promise<void> {
    const anopodId = this.session.anopodId();
    if (anopodId === null) return;
    if (this.loadedFor !== anopodId) {
      this.reset();
      this.loadedFor = anopodId;
      const login = this.login;
      const kept = await this.openKept(anopodId);
      if (login !== this.login) return;
      if (kept !== null) this.messages.set(kept);
      this.ready.set(true);
    }
    if (!this.writing()) await this.loadMemory();
  }

  /**
   * The message box's text goes to Joy. The message shows at once and the
   * box empties; the answer shows while it is written. A message that the
   * masterpod refuses, or whose answer fails before any of it came, is
   * taken out of the chat again and its text put back into the box, with
   * the reason in the red line. An answer that fails after a part of it
   * came stays as far as it came, marked as cut off.
   */
  async send(): Promise<void> {
    const text = this.draft().trim();
    const anopodId = this.session.anopodId();
    // Nothing is sent before the chat this browser keeps was looked for: the kept chat would otherwise land on top of the new message.
    if (text === '' || this.writing() || this.starting || !this.ready() || anopodId === null || this.loadedFor !== anopodId) return;
    const words = this.lang.words();
    const login = this.login;
    this.error.set(null);
    if (this.session.getEncryptionKey() === null) {
      this.error.set(words.common.noKeyInRamSentence);
      return;
    }
    if (this.memory() === null) {
      this.starting = true;
      const known = await this.loadMemory();
      this.starting = false;
      if (!known || login !== this.login) return;
    }
    const memory = this.memory() ?? '';
    if (utf8Length(text) > JOY_MAX_CONVERSATION_BYTES) {
      this.error.set(words.joy.messageTooLong);
      return;
    }
    if (utf8Length(memory) > JOY_MEMORY_MAX_BYTES) {
      this.error.set(words.joy.memoryTooLong);
      return;
    }

    const mine: JoyChatMessage = { role: 'user', text, at: new Date().toISOString() };
    this.messages.update((list) => [...list, mine]);
    this.draft.set('');
    this.writing.set(true);
    this.answer.set('');
    this.keep();

    let last: LastLine | null = null;
    const res = await this.api.askJoy(conversationOf(this.messages()), memory, (line) => {
      if (login !== this.login || typeof line !== 'object' || line === null) return;
      const piece = line as { text?: unknown; searching?: unknown; done?: unknown; stop?: unknown; memory?: unknown; sources?: unknown; error?: unknown };
      if (typeof piece.text === 'string') {
        // The next piece of the answer takes the words on a search away.
        this.searching.set(false);
        this.answer.update((answer) => (answer ?? '') + piece.text);
      } else if (piece.searching === true) this.searching.set(true);
      else if (piece.done === true) last = { done: true, stop: piece.stop === 'length' || piece.stop === 'refused' ? piece.stop : 'end', memory: typeof piece.memory === 'string' ? piece.memory : null, sources: sourcesOf(piece.sources) };
      else if (typeof piece.error === 'string') last = { error: piece.error };
    });
    if (login !== this.login) return;

    const written = this.answer() ?? '';
    const ended = last as LastLine | null;
    this.answer.set(null);
    this.searching.set(false);
    if (ended !== null && 'done' in ended) {
      // An answer that ended. One with no text at all and no word on why is shown as cut off. The web pages Joy cited are kept with it; an answer that failed has none, since they come in the last line.
      const end = ended.stop !== 'end' ? ended.stop : written.trim() === '' ? 'cut' : undefined;
      this.messages.update((list) => [...list, { role: 'assistant', text: written, at: new Date().toISOString(), ...(end ? { end } : {}), ...(ended.sources.length > 0 ? { sources: ended.sources } : {}) }]);
      this.keep();
      // The memory file that Joy changed is stored before the next message can be sent.
      if (ended.memory !== null) {
        this.memorySets += 1;
        this.memory.set(ended.memory);
      }
      if (ended.memory !== null || this.memoryUnsaved) await this.storeMemory(this.memory() ?? '');
      if (login !== this.login) return;
    } else if (res.ok && written.trim() !== '') {
      // The answer failed after a part of it had come: that part stays.
      this.messages.update((list) => [...list, { role: 'assistant', text: written, at: new Date().toISOString(), end: 'cut' }]);
      this.keep();
    } else {
      // Nothing was answered: the message goes back into the box.
      this.messages.update((list) => list.filter((message) => message !== mine));
      this.draft.update((draft) => (draft.trim() === '' ? text : `${text}\n${draft}`));
      this.error.set(res.ok ? this.failureWords(ended === null ? 'joy was cut off' : ended.error) : this.refusalWords(res));
      this.keep();
    }
    this.writing.set(false);
  }

  /** New chat: the chat is emptied, here and in the browser's database. Not while an answer is under way. */
  newChat(): void {
    if (this.writing()) return;
    this.messages.set([]);
    this.error.set(null);
    this.keep();
  }

  /**
   * /get-joy-memory, quiet: the blob opened under the anoPod encryption
   * key. No blob yet, or a blob that does not open, is an empty file. A
   * read that is refused or not answered leaves the file as it was and
   * says why in the red line. True when the file is known afterwards.
   */
  async loadMemory(): Promise<boolean> {
    const key = this.session.getEncryptionKey();
    if (key === null) {
      this.error.set(this.lang.words().common.noKeyInRamSentence);
      return false;
    }
    const login = this.login;
    const sets = this.memorySets;
    const res = await this.api.getJoyMemory();
    if (login !== this.login) return false;
    if (!res.ok) {
      this.error.set(`/get-joy-memory: ${reasonOf(res)}`);
      return this.memory() !== null;
    }
    // A file that was set here while the read was on its way, or that is waiting to be stored, is newer than what this answer holds.
    if (sets !== this.memorySets || this.memoryUnsaved) return true;
    let text = '';
    if (res.body.memoryBlob !== null) {
      try {
        const opened = await this.crypto.unwrapJson<JoyMemoryBlob>(this.crypto.fromHex(res.body.memoryBlob), key);
        if (typeof opened?.text === 'string') text = opened.text;
      } catch {
        console.error('/get-joy-memory: the blob does not open under this anoPod encryption key');
      }
    }
    if (login !== this.login) return false;
    if (sets === this.memorySets) this.memory.set(text);
    return true;
  }

  /**
   * The member's own change of the memory file, from its page: the text
   * is stored whole in the place of the file before, an empty text for
   * Delete all. Not while an answer is under way, since its last line may
   * bring a file of Joy's. Null when it was stored, else the reason.
   */
  async saveMemory(text: string): Promise<string | null> {
    if (this.writing()) return this.lang.words().joy.memoryWait;
    if (utf8Length(text) > JOY_MEMORY_MAX_BYTES) return this.lang.words().joy.memoryOver;
    const failure = await this.storeMemory(text, false);
    if (failure === null) {
      this.memorySets += 1;
      this.memory.set(text);
    }
    return failure;
  }

  /** The file's text wrapped under the anoPod encryption key to /set-joy-memory. A refusal is answered as its reason, and with `show` it also stands in the red line and the file is stored again with the next answer. */
  private async storeMemory(text: string, show = true): Promise<string | null> {
    const key = this.session.getEncryptionKey();
    let failure: string | null = null;
    if (key === null) {
      failure = this.lang.words().common.noKeyInRamSentence;
    } else {
      const blob: JoyMemoryBlob = { v: 1, text };
      const res = await this.api.setJoyMemory(this.crypto.toHex(await this.crypto.wrapJson(blob, key)));
      if (!res.ok) failure = `/set-joy-memory: ${reasonOf(res)}`;
    }
    if (show) {
      this.memoryUnsaved = failure !== null;
      if (failure !== null) this.error.set(failure);
    } else if (failure === null) {
      this.memoryUnsaved = false;
    }
    return failure;
  }

  /** The sentence for a refusal of /ask-joy: the four of the masterpod's own checks in the member's words, anything else as the wallet shows every refusal. */
  private refusalWords(res: ApiResponse<unknown>): string {
    const words = this.lang.words().joy;
    const reason = (res.body as Partial<ApiError> | null)?.error;
    if (reason === 'joy is off') return words.off;
    if (reason === 'daily limit reached') return words.dailyLimit(this.nextDay());
    if (reason === 'conversation too long') return words.messageTooLong;
    if (reason === 'memory too long') return words.memoryTooLong;
    return `/ask-joy: ${reasonOf(res)}`;
  }

  /** The sentence for an answer that failed: the three reasons of the answer's last line; an answer that ended with no last line is one that was cut off. */
  private failureWords(reason: string): string {
    const words = this.lang.words().joy;
    if (reason === 'joy busy') return words.busy;
    if (reason === 'joy unavailable') return words.unavailable;
    return words.cutOff;
  }

  /** When the masterpod's day ends, as a time of the member's own clock: the count of messages is for a day of UTC, which in Thailand begins at 07:00. */
  private nextDay(): string {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return next.toLocaleTimeString(this.lang.tag(), { hour: 'numeric', minute: '2-digit' });
  }

  /** The chat as it stands goes into the browser's database, encrypted; an empty chat takes the pod's entry out. Without the encryption key, and where the browser refuses its database, the chat stays in the page's memory alone. */
  private keep(): void {
    const anopodId = this.loadedFor;
    const key = this.session.getEncryptionKey();
    if (anopodId === null || key === null) return;
    const messages = this.messages();
    this.keeping = this.keeping.then(async () => {
      try {
        if (messages.length === 0) {
          await dropKept(anopodId);
          return;
        }
        const blob: JoyChatBlob = { v: 1, messages };
        await writeKept(anopodId, await this.crypto.wrapJson(blob, key));
      } catch {
        // Private mode, blocked storage or no room: the tab keeps its copy.
      }
    });
  }

  /** The chat this browser keeps for the pod, opened; null when there is none, when it does not open under this anoPod encryption key, or when the browser refuses its database. */
  private async openKept(anopodId: string): Promise<JoyChatMessage[] | null> {
    const key = this.session.getEncryptionKey();
    if (key === null) return null;
    try {
      const blob = await readKept(anopodId);
      if (blob === null) return null;
      const chat = await this.crypto.unwrapJson<JoyChatBlob>(blob, key);
      if (chat?.v !== 1 || !Array.isArray(chat.messages)) return null;
      const kept = chat.messages.filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string' && typeof m.at === 'string');
      // The sources of a kept answer are checked again, as they were when they came (wallet spec 4.20): the Joy page makes its links of them. A chat that was kept before the wallet knew of sources has none, and opens as it is.
      for (const message of kept) {
        if (!('sources' in message)) continue;
        const sources = message.role === 'assistant' ? sourcesOf(message.sources) : [];
        if (sources.length > 0) message.sources = sources;
        else delete message.sources;
      }
      return kept;
    } catch {
      return null;
    }
  }

  private reset(): void {
    this.login += 1;
    this.loadedFor = null;
    this.memoryUnsaved = false;
    this.starting = false;
    this.messages.set([]);
    this.answer.set(null);
    this.writing.set(false);
    this.searching.set(false);
    this.draft.set('');
    this.error.set(null);
    this.memory.set(null);
    this.ready.set(false);
  }
}

/** The most web pages that are kept and shown for one answer, and the most characters of a page's title: the masterpod's own two numbers (its spec, 32.3). */
const MAX_SOURCES = 10;
const SOURCE_TITLE_MAX_CHARS = 200;

/**
 * The web pages Joy cited for an answer, as the wallet keeps them (wallet
 * spec 4.20): what the last line of /ask-joy's answer names as `sources`,
 * or what a kept chat holds for an answer. The masterpod checks what it
 * sends. The wallet checks it again here, when it comes and when a kept
 * chat is opened, since a link on the Joy page is made of nothing else.
 *
 * An entry is taken when its title is a text, which may be empty, and its
 * address is a text that begins with https:// or http:// and names a site
 * (siteOf): each address once, and the first MAX_SOURCES of them.
 * Anything else is passed over, and a value that is no list gives an
 * empty list. A title is kept without the spaces around it and cut at
 * SOURCE_TITLE_MAX_CHARS characters; an address is kept as it came.
 */
export function sourcesOf(value: unknown): JoySource[] {
  if (!Array.isArray(value)) return [];
  const sources: JoySource[] = [];
  for (const entry of value) {
    if (sources.length === MAX_SOURCES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { title, url } = entry as { title?: unknown; url?: unknown };
    if (typeof title !== 'string' || typeof url !== 'string' || siteOf(url) === '') continue;
    if (sources.some((source) => source.url === url)) continue;
    sources.push({ title: title.trim().slice(0, SOURCE_TITLE_MAX_CHARS), url });
  }
  return sources;
}

/**
 * The site of a web address, which the Joy page shows beside a source's
 * title: the address's host as the browser reads it, without a leading
 * "www.". Empty for a text that does not begin with https:// or http://,
 * and for one that the browser cannot read as an address with a host.
 */
export function siteOf(url: string): string {
  if (!url.startsWith('https://') && !url.startsWith('http://')) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The bytes of a text as UTF-8, which is how the masterpod counts a message and the memory file. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The conversation one message to Joy carries: the chat's newest messages,
 * as many as fit the masterpod's limits, oldest first, and the first of
 * them the member's. A message with no text is left out: an answer that
 * was refused or failed before a word of it came.
 */
function conversationOf(messages: JoyChatMessage[]): JoyMessage[] {
  const sent: JoyMessage[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && sent.length < JOY_MAX_MESSAGES; i -= 1) {
    const { role, text } = messages[i];
    if (text.trim() === '') continue;
    bytes += utf8Length(text);
    if (bytes > JOY_MAX_CONVERSATION_BYTES) break;
    sent.unshift({ role, text });
  }
  while (sent.length > 0 && sent[0].role !== 'user') sent.shift();
  return sent;
}

/** The browser's own database of the wallet, and the place in it where the chat with Joy is kept: one entry for each pod, under the anoPod's id. */
const DB_NAME = 'anopod-wallet';
const STORE = 'joy-chat';

/** Opens the database, and makes the place for the chats the first time. */
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

/** The blob kept for the pod, or null. */
async function readKept(anopodId: string): Promise<Uint8Array | null> {
  const blob: unknown = await inStore('readonly', (store) => store.get(anopodId));
  return blob instanceof Uint8Array ? blob : null;
}

function writeKept(anopodId: string, blob: Uint8Array): Promise<unknown> {
  return inStore('readwrite', (store) => store.put(blob, anopodId));
}

function dropKept(anopodId: string): Promise<unknown> {
  return inStore('readwrite', (store) => store.delete(anopodId));
}
