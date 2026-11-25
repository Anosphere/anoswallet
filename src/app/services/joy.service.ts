import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { JOY_MAX_CONVERSATION_BYTES, JOY_MAX_MESSAGES, JOY_MEMORY_MAX_BYTES } from '../constants';
import { IMAGE_CONTENT_TYPES, imageObjectUrl } from '../images';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiError, ApiResponse, reasonOf } from './log.service';
import { JoyMessage, JoySource, JoyStop, MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/** One message of the chat with Joy as the wallet keeps it (wallet spec 4.18): who wrote it, its text and when it was sent (ISO 8601; for an answer of Joy's, when it ended). `end` stands only on an answer of Joy's that did not end as an answer should: `length`, it was cut off where the model reached its limit; `refused`, the safety check of the model's company stopped it; `cut`, the answer failed after a part of it had come. `sources` stands only on an answer of Joy's for which she cited web pages (wallet spec 4.20; 2026-11-24): those pages, as sourcesOf() checked them, never an empty list. `picture` stands only on an answer of Joy's for which a picture was made (wallet spec 4.21; 2026-11-25). */
export interface JoyChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  end?: 'length' | 'refused' | 'cut';
  sources?: JoySource[];
  picture?: JoyPicture;
}

/** A picture that Joy had made for an answer, as the chat keeps it (wallet spec 4.21; 2026-11-25): the id that the wallet made up for it, under which the picture's bytes are kept in the browser's database as an entry of their own, and the description that Joy wrote for it. The bytes themselves are never in the chat's blob. */
export interface JoyPicture {
  id: string;
  description: string;
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
 *
 * Since 2026-11-25 (wallet spec 4.21) Joy can have a picture made. While
 * one is made the page says so (drawing). The picture comes as one line
 * of the answer. The wallet checks that line (pictureOf), shows the
 * picture in the answer, and keeps its bytes in the browser's database
 * as an entry of their own, encrypted with the anoPod encryption key,
 * under an id that the wallet makes up. The chat's blob holds only that
 * id and the description that Joy wrote. When a kept chat is opened its
 * pictures are read and opened again, and New chat takes them out with
 * the chat. No picture is ever sent back: in a later message an answer
 * that had a picture carries a note of the wallet's with Joy's
 * description in front of its words (pictureNote).
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
  /** True while a picture is being made for the answer that is being written (wallet spec 4.21): from a line of the answer that says Joy started on one until the picture comes, the answer's next piece comes, or the answer ends. */
  readonly drawing = signal(false);
  /** The picture of the answer that is being written, once it has come; null before that and while no answer is under way. */
  readonly answerPicture = signal<JoyPicture | null>(null);
  /** The pictures the Joy page can draw, by id: for each one an address of its bytes in this page's memory (an object URL). A picture whose id is not here is no longer kept in this browser. */
  readonly pictureUrls = signal<Record<string, string>>({});
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
  /** The writes to the browser's database, one after the other, so an older chat never lands on a newer one, and a picture is there before the chat that names it. */
  private keeping: Promise<void> = Promise.resolve();
  /** The pictures' bytes and types, by id, for Download: a file is made of them inside the tap. */
  private readonly pictureFiles = new Map<string, { bytes: Uint8Array; type: string }>();

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
   * the chat this browser keeps for the pod and opens it, and the
   * pictures of that chat with it. Every time it reads the memory file
   * from the masterpod, unless an answer is under way: the file may have
   * been changed on another device.
   */
  async open(): Promise<void> {
    const anopodId = this.session.anopodId();
    if (anopodId === null) return;
    if (this.loadedFor !== anopodId) {
      this.reset();
      this.loadedFor = anopodId;
      const login = this.login;
      const kept = await this.openKept(anopodId);
      // The chat's pictures are opened before the chat shows, so that no picture is drawn as gone while its bytes are still being read.
      const pictures = kept === null ? [] : await this.openPictures(anopodId, kept);
      if (login !== this.login) {
        for (const picture of pictures) URL.revokeObjectURL(picture.url);
        return;
      }
      for (const picture of pictures) this.pictureFiles.set(picture.id, { bytes: picture.bytes, type: picture.type });
      this.pictureUrls.set(Object.fromEntries(pictures.map((picture) => [picture.id, picture.url])));
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
      const piece = line as { text?: unknown; searching?: unknown; drawing?: unknown; picture?: unknown; done?: unknown; stop?: unknown; memory?: unknown; sources?: unknown; error?: unknown };
      if (typeof piece.text === 'string') {
        // The next piece of the answer takes the words on a search away, and the words on a picture: Joy's words can follow a picture that she started on and that was not made.
        this.searching.set(false);
        this.drawing.set(false);
        this.answer.update((answer) => (answer ?? '') + piece.text);
      } else if (piece.searching === true) this.searching.set(true);
      else if (piece.drawing === true) this.drawing.set(true);
      else if (piece.done === true) last = { done: true, stop: piece.stop === 'length' || piece.stop === 'refused' ? piece.stop : 'end', memory: typeof piece.memory === 'string' ? piece.memory : null, sources: sourcesOf(piece.sources) };
      else if (typeof piece.error === 'string') last = { error: piece.error };
      else if ('picture' in piece) this.takePicture(anopodId, piece.picture);
    });
    if (login !== this.login) return;

    const written = this.answer() ?? '';
    const ended = last as LastLine | null;
    const picture = this.answerPicture();
    this.answer.set(null);
    this.searching.set(false);
    this.drawing.set(false);
    this.answerPicture.set(null);
    if (ended !== null && 'done' in ended) {
      // An answer that ended. One with no text at all, no picture and no word on why is shown as cut off. The web pages Joy cited are kept with it; an answer that failed has none, since they come in the last line. A picture that came is kept with it, as its id and Joy's description.
      const end = ended.stop !== 'end' ? ended.stop : written.trim() === '' && picture === null ? 'cut' : undefined;
      this.messages.update((list) => [...list, { role: 'assistant', text: written, at: new Date().toISOString(), ...(end ? { end } : {}), ...(ended.sources.length > 0 ? { sources: ended.sources } : {}), ...(picture ? { picture } : {}) }]);
      this.keep();
      // The memory file that Joy changed is stored before the next message can be sent.
      if (ended.memory !== null) {
        this.memorySets += 1;
        this.memory.set(ended.memory);
      }
      if (ended.memory !== null || this.memoryUnsaved) await this.storeMemory(this.memory() ?? '');
      if (login !== this.login) return;
    } else if (res.ok && (written.trim() !== '' || picture !== null)) {
      // The answer failed after a part of it had come: that part stays, and a picture that had come stays with it.
      this.messages.update((list) => [...list, { role: 'assistant', text: written, at: new Date().toISOString(), end: 'cut', ...(picture ? { picture } : {}) }]);
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

  /** New chat: the chat is emptied, here and in the browser's database, and its pictures go with it. Not while an answer is under way. */
  newChat(): void {
    if (this.writing()) return;
    this.messages.set([]);
    this.error.set(null);
    this.forgetPictures();
    this.keep();
  }

  /** True when the chat holds a picture that this page can still draw, and so one that can still be downloaded. The box of New chat says one sentence more then. */
  hasPictures(): boolean {
    const urls = this.pictureUrls();
    return this.messages().some((message) => message.picture !== undefined && urls[message.picture.id] !== undefined);
  }

  /**
   * Download (wallet spec 4.21): hands a picture to the person as a file
   * named joy-, the date and the time. On an iPhone or an iPad it opens
   * the phone's own share sheet, where Apple's "Save Image" puts the
   * picture into Photos. Everywhere else it is a plain download, as the
   * CSV download of the noted transactions is. Tried on 2026-11-25: a
   * plain download on an iPhone lands in the Files app from Safari, and
   * from the Home Screen it saves nothing; on an Android phone the share
   * sheet has nothing that saves. No browser has a call that saves into
   * Photos, so the device is told by the browser's user agent. The file
   * is made here, inside the tap, from bytes that the page holds: a share
   * sheet opens only then. An iPhone whose browser cannot share a file
   * gets the plain download.
   */
  download(id: string): void {
    const kept = this.pictureFiles.get(id);
    if (!kept) return;
    const name = `joy-${fileStamp(new Date())}.${kept.type === 'image/png' ? 'png' : kept.type === 'image/webp' ? 'webp' : 'jpg'}`;
    const file = new File([kept.bytes as BlobPart], name, { type: kept.type });
    if (onIphoneOrIpad() && typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }))) {
      // Closing the sheet rejects the call: that is no failure.
      navigator.share({ files: [file] }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
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

  /**
   * The picture's line of an answer (wallet spec 4.21). The making is
   * over, so the words on it go, and the words on a search with them:
   * what follows a picture is Joy's sentence. The line is checked
   * (pictureOf). A picture that passes gets an id that the wallet makes
   * up, shows in the answer that is being written, and goes into the
   * browser's database as an entry of its own. A line that does not pass
   * is passed over, and so is a second picture in one answer: the
   * masterpod sends one at most.
   */
  private takePicture(anopodId: string, line: unknown): void {
    this.drawing.set(false);
    this.searching.set(false);
    if (this.answerPicture() !== null) return;
    const picture = pictureOf(line);
    if (picture === null) return;
    const url = imageObjectUrl(picture.bytes, picture.type);
    if (url === null) return;
    const id = this.crypto.randomHex(16);
    this.pictureFiles.set(id, { bytes: picture.bytes, type: picture.type });
    this.pictureUrls.update((urls) => ({ ...urls, [id]: url }));
    this.answerPicture.set({ id, description: picture.description });
    this.keepPicture(anopodId, id, picture.type, picture.bytes);
  }

  /** A picture's bytes go into the browser's database as an entry of their own, encrypted with the anoPod encryption key, in the row of the chat's own writes, so the picture is there before the chat that names it. Where the browser refuses the write, the picture stays in the page's memory until a reload, and the page shows a grey line in its place after that. */
  private keepPicture(anopodId: string, id: string, type: string, bytes: Uint8Array): void {
    const key = this.session.getEncryptionKey();
    if (key === null) return;
    this.keeping = this.keeping.then(async () => {
      try {
        await writePicture(pictureKey(anopodId, id), await this.crypto.encrypt(key, packPicture(type, bytes)));
      } catch {
        // Private mode, blocked storage or no room: the tab keeps its copy.
      }
    });
  }

  /** The pictures of a kept chat, each read from the browser's database and opened under the anoPod encryption key: its id, its type, its bytes and an address for the page. A picture whose entry is gone, does not open under this key, or does not name one of the wallet's three picture types is left out: the page shows a grey line in its place. */
  private async openPictures(anopodId: string, messages: JoyChatMessage[]): Promise<{ id: string; type: string; bytes: Uint8Array; url: string }[]> {
    const key = this.session.getEncryptionKey();
    if (key === null) return [];
    const ids = [...new Set(messages.flatMap((message) => (message.picture ? [message.picture.id] : [])))];
    const opened = await Promise.all(
      ids.map(async (id) => {
        try {
          const blob = await readPicture(pictureKey(anopodId, id));
          if (blob === null) return null;
          const picture = unpackPicture(await this.crypto.decrypt(key, blob));
          if (picture === null) return null;
          const url = imageObjectUrl(picture.bytes, picture.type);
          return url === null ? null : { id, ...picture, url };
        } catch {
          return null;
        }
      }),
    );
    return opened.filter((picture) => picture !== null);
  }

  /** Every picture goes out of this page's memory, and its address is given back to the browser. What the browser's database keeps is not touched here. */
  private forgetPictures(): void {
    for (const url of Object.values(this.pictureUrls())) URL.revokeObjectURL(url);
    this.pictureUrls.set({});
    this.pictureFiles.clear();
  }

  /** The chat as it stands goes into the browser's database, encrypted; an empty chat takes the pod's entry out, and the pod's pictures with it. Without the encryption key, and where the browser refuses its database, the chat stays in the page's memory alone. */
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
      // The picture of a kept answer is checked too (wallet spec 4.21): its id is one of the form the wallet makes up, and its description is what goes back to Joy as words. A chat that was kept before the wallet knew of pictures has none, and opens as it is.
      for (const message of kept) {
        if (!('picture' in message)) continue;
        const picture = message.role === 'assistant' ? keptPictureOf(message.picture) : null;
        if (picture !== null) message.picture = picture;
        else delete message.picture;
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
    this.drawing.set(false);
    this.answerPicture.set(null);
    this.forgetPictures();
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

/**
 * The largest picture the wallet takes, in bytes, and the most characters
 * a picture's description may have (wallet spec 4.21). The masterpod
 * sets no ceiling for a picture (its spec, 33.4), so this one is the
 * wallet's: a picture at the masterpod's own settings is about 160 to
 * 220 KB, and a PNG of 1024 by 1024 pixels still fits. The 1,000
 * characters are the masterpod's own number for a description.
 */
const PICTURE_MAX_BYTES = 4 * 1024 * 1024;
const PICTURE_DESCRIPTION_MAX_CHARS = 1000;

/** The form of the id that the wallet makes up for a picture: 16 random bytes as hex. */
const PICTURE_ID = /^[0-9a-f]{32}$/;

/**
 * The picture of one line of /ask-joy's answer, checked (wallet spec
 * 4.21): what the line names as `picture`. The masterpod checks what it
 * sends. The wallet checks it again here, since what passes is kept in
 * the browser, drawn on the Joy page and handed out as a file.
 *
 * A picture is taken when its type is one of the wallet's own three
 * (JPEG, PNG, WebP: images.ts), its description is a text of 1 to
 * PICTURE_DESCRIPTION_MAX_CHARS characters once the spaces around it are
 * taken off, and its data is base64 that opens to at least one byte and
 * at most PICTURE_MAX_BYTES. Anything else gives null, and the line is
 * passed over. The description is kept without the spaces around it.
 */
export function pictureOf(value: unknown): { type: string; bytes: Uint8Array; description: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, data, description } = value as { type?: unknown; data?: unknown; description?: unknown };
  if (typeof type !== 'string' || !IMAGE_CONTENT_TYPES.includes(type)) return null;
  const words = descriptionOf(description);
  if (words === null) return null;
  // Base64 is four characters for three bytes: a text that is longer than the ceiling allows is not opened at all.
  if (typeof data !== 'string' || data.length > Math.ceil(PICTURE_MAX_BYTES / 3) * 4) return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > PICTURE_MAX_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { type, bytes, description: words };
}

/** The picture of a kept answer, as the chat's blob holds it (wallet spec 4.21): an id of the form the wallet makes up, and a description. Null for anything else. */
function keptPictureOf(value: unknown): JoyPicture | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, description } = value as { id?: unknown; description?: unknown };
  if (typeof id !== 'string' || !PICTURE_ID.test(id)) return null;
  const words = descriptionOf(description);
  return words === null ? null : { id, description: words };
}

/** A description as the wallet keeps it: without the spaces around it. Null for a value that is no text, for a text of spaces alone, and for one of more than PICTURE_DESCRIPTION_MAX_CHARS characters, which the masterpod never sends. */
function descriptionOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const words = value.trim();
  return words === '' || words.length > PICTURE_DESCRIPTION_MAX_CHARS ? null : words;
}

/**
 * The note that stands for a picture in what goes back to Joy (wallet
 * spec 4.21): she gets the words of her earlier answers and never a
 * picture, so the wallet puts this line in front of the words of an
 * answer that had one. The masterpod's shared memory file tells her what
 * the line is (its spec, 33.6), and the words here are the ones it names.
 */
export function pictureNote(description: string): string {
  return `[Note from the wallet: a picture stood here. You made it with make_picture from this description: ${description}]`;
}

/** True on an iPhone and on an iPad, told by the browser's user agent as alerts.service tells them: an iPad may call itself a Macintosh, and has a touch screen. */
function onIphoneOrIpad(): boolean {
  const agent = navigator.userAgent;
  return agent.includes('iPhone') || agent.includes('iPad') || (agent.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/** A moment as a part of a file's name, by the person's own clock: 2026-11-25-21-03-07. */
function fileStamp(moment: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())}-${two(moment.getHours())}-${two(moment.getMinutes())}-${two(moment.getSeconds())}`;
}

/** The bytes of a text as UTF-8, which is how the masterpod counts a message and the memory file. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The conversation one message to Joy carries: the chat's newest messages,
 * as many as fit the masterpod's limits, oldest first, and the first of
 * them the member's. A message with no text is left out: an answer that
 * was refused or failed before a word of it came. An answer that had a
 * picture carries the wallet's note of it, an empty line and its words,
 * or the note alone when it has no words (wallet spec 4.21): of each
 * message the role and the text are sent, and never a picture.
 */
function conversationOf(messages: JoyChatMessage[]): JoyMessage[] {
  const sent: JoyMessage[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && sent.length < JOY_MAX_MESSAGES; i -= 1) {
    const { role, text: words, picture } = messages[i];
    const text = picture ? `${pictureNote(picture.description)}${words.trim() === '' ? '' : `\n\n${words}`}` : words;
    if (text.trim() === '') continue;
    bytes += utf8Length(text);
    if (bytes > JOY_MAX_CONVERSATION_BYTES) break;
    sent.unshift({ role, text });
  }
  while (sent.length > 0 && sent[0].role !== 'user') sent.shift();
  return sent;
}

/**
 * The browser's own database of the wallet, and its two places. In the
 * first the chat with Joy is kept: one entry for each pod, under the
 * anoPod's id. In the second, since 2026-11-25 (wallet spec 4.21), the
 * pictures of that chat: one entry for each picture, under pictureKey().
 * The second place came with version 2 of the database. A database of
 * version 1 keeps its first place, and the chats in it, through the
 * change.
 */
const DB_NAME = 'anopod-wallet';
const DB_VERSION = 2;
const STORE = 'joy-chat';
const PICTURES = 'joy-pictures';

/** Opens the database, and makes each of its two places when it is not there: both the first time, the pictures' alone in a browser that has the database of before. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let given = false;
    request.onupgradeneeded = () => {
      for (const place of [STORE, PICTURES]) {
        if (!request.result.objectStoreNames.contains(place)) request.result.createObjectStore(place);
      }
    };
    // A database that opens after the wait for it was given up is closed again at once, so that it holds nothing open.
    request.onsuccess = () => (given ? request.result.close() : resolve(request.result));
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      given = true;
      reject(new Error('the database is blocked'));
    };
  });
}

/** One read or write of one place, in a transaction of its own; resolves with what the request answered once the transaction is done. */
async function inStore<T>(place: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(place, mode);
      const request = run(tx.objectStore(place));
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
  const blob: unknown = await inStore(STORE, 'readonly', (store) => store.get(anopodId));
  return blob instanceof Uint8Array ? blob : null;
}

function writeKept(anopodId: string, blob: Uint8Array): Promise<unknown> {
  return inStore(STORE, 'readwrite', (store) => store.put(blob, anopodId));
}

/** The pod's chat goes out of the database, and every picture of the pod with it, in one transaction: either both are gone or neither. */
async function dropKept(anopodId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, PICTURES], 'readwrite');
      tx.objectStore(STORE).delete(anopodId);
      tx.objectStore(PICTURES).delete(IDBKeyRange.bound(pictureKey(anopodId, ''), `${anopodId}!`, false, true));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** The key of a picture's entry: the anoPod's id, one space, the picture's id. Both ids are hex, so the space parts them, every key of one pod lies between "<the id> " and "<the id>!", and another pod in the same browser has entries of its own. */
function pictureKey(anopodId: string, id: string): string {
  return `${anopodId} ${id}`;
}

/** The blob kept under a picture's key, or null. */
async function readPicture(entry: string): Promise<Uint8Array | null> {
  const blob: unknown = await inStore(PICTURES, 'readonly', (store) => store.get(entry));
  return blob instanceof Uint8Array ? blob : null;
}

function writePicture(entry: string, blob: Uint8Array): Promise<unknown> {
  return inStore(PICTURES, 'readwrite', (store) => store.put(blob, entry));
}

/**
 * A picture as it is encrypted for its entry (wallet spec 4.21): one byte
 * that says how long the type's name is, the type's name in ASCII
 * ("image/jpeg"), and then the picture's own bytes as they came, with no
 * base64 in between. So the type is inside the ciphertext with the
 * picture, and the entry is one blob in which nothing can be read.
 */
function packPicture(type: string, bytes: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const packed = new Uint8Array(1 + name.length + bytes.length);
  packed[0] = name.length;
  packed.set(name, 1);
  packed.set(bytes, 1 + name.length);
  return packed;
}

/** The reverse of packPicture(), for an opened entry: the type's name and the picture's bytes. Null when the bytes do not begin as packPicture() writes them, or hold no picture after the name. The type is not looked at here: imageObjectUrl() takes none but the wallet's three. */
function unpackPicture(packed: Uint8Array): { type: string; bytes: Uint8Array } | null {
  const length = packed[0];
  if (length === undefined || packed.length <= 1 + length) return null;
  return { type: new TextDecoder().decode(packed.subarray(1, 1 + length)), bytes: packed.subarray(1 + length) };
}
