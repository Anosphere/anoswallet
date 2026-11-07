import { Injectable, computed, inject, signal } from '@angular/core';
import { historyWords } from '../history-words';
import { TransactionItem } from './anos-api.service';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { MasterpodApiService, NoteFields, NoteRange, NotedTransactionItem } from './masterpod-api.service';
import { Bytes } from './passkey.service';
import { AnosAccountItem, SessionService } from './session.service';

/** The kinds of a note (wallet spec 8.2, Transaction history): the three radio kinds, the four of the drop-down, and other with a typed tag. */
export const NOTE_KINDS = ['bought', 'sold', 'income', 'toStake', 'fromStake', 'toOwn', 'fromOwn', 'other'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** The three radio kinds, which need the money and the currency. */
export const MONEY_KINDS: NoteKind[] = ['bought', 'sold', 'income'];
/** The drop-down's kinds. */
export const OTHER_KINDS: NoteKind[] = ['toStake', 'fromStake', 'toOwn', 'fromOwn', 'other'];

/** The private part of a note, what noteBlob holds (wallet spec 7): money a decimal string or null, currency three letters or null, memo and tag empty when none. */
export interface NoteDetails {
  v: 1;
  kind: NoteKind;
  money: string | null;
  currency: string | null;
  memo: string;
  tag: string;
}

/** A note as the pages use it: the clear part from the masterpod and the private part opened on the phone, null when the blob did not open. */
export interface Note {
  noteId: string;
  transactionId: string;
  accountId: string;
  otherAccountId: string | null;
  position: number;
  transactedAt: string;
  amount: string;
  sent: boolean;
  createdAt: string;
  updatedAt: string;
  details: NoteDetails | null;
}

/**
 * What the notes pages share (wallet spec 8.2, Transaction history, and
 * 8.3; 2026-11-07, section 11): the last list read from the masterpod
 * (/list-noted-transactions) with its blobs opened on the phone under the
 * encryption key, by transaction; the three writes, add, update and
 * remove, each wrapping the private part under the encryption key before
 * it leaves the phone; the kind a history row presets, the currency a new
 * note starts with, and the ledger facts of a row for a new note.
 */
@Injectable({ providedIn: 'root' })
export class NotesService {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The last read, null until one. */
  readonly notes = signal<Note[] | null>(null);
  /** True when the last read hit the masterpod's cap and older notes exist. */
  readonly more = signal(false);
  /** The notes by transaction id. */
  readonly byTransaction = computed(() => new Map((this.notes() ?? []).map((n) => [n.transactionId, n])));

  /**
   * /list-noted-transactions with the range; each blob opened under the
   * encryption key into details, null when it does not open. A refusal
   * throws "/list-noted-transactions: <reason>"; without the encryption key
   * it throws before the call.
   */
  async load(range: NoteRange = {}, quiet = true): Promise<void> {
    const key = this.encryptionKey();
    const res = await this.api.listNotedTransactions(range, quiet);
    if (!res.ok) throw new Error(`/list-noted-transactions: ${reasonOf(res)}`);
    const notes = await Promise.all(res.body.notes.map((item) => this.open(item, key)));
    this.notes.set(notes);
    this.more.set(res.body.more);
  }

  /** A new note: the private part wrapped, /add-noted-transaction, the note appended to the list. A refusal throws. */
  async add(clear: Omit<NoteFields, 'noteBlob'>, details: NoteDetails): Promise<Note> {
    const noteBlob = await this.wrap(details);
    const res = await this.api.addNotedTransaction({ ...clear, noteBlob });
    if (!res.ok) throw new Error(`/add-noted-transaction: ${reasonOf(res)}`);
    const now = new Date().toISOString();
    const note: Note = { ...clear, noteId: res.body.noteId, createdAt: now, updatedAt: now, details };
    this.notes.update((list) => [...(list ?? []), note]);
    return note;
  }

  /** The note's private part replaced: the new blob, /update-noted-transaction, the note replaced in the list with the answer's updatedAt. A refusal throws. */
  async update(note: Note, details: NoteDetails): Promise<Note> {
    const noteBlob = await this.wrap(details);
    const res = await this.api.updateNotedTransaction(note.noteId, noteBlob);
    if (!res.ok) throw new Error(`/update-noted-transaction: ${reasonOf(res)}`);
    const updated: Note = { ...note, updatedAt: res.body.updatedAt, details };
    this.notes.update((list) => (list ?? []).map((n) => (n.noteId === note.noteId ? updated : n)));
    return updated;
  }

  /** /remove-noted-transaction; the note dropped from the list. A refusal throws. */
  async remove(note: Note): Promise<void> {
    const res = await this.api.removeNotedTransaction(note.noteId);
    if (!res.ok) throw new Error(`/remove-noted-transaction: ${reasonOf(res)}`);
    this.notes.update((list) => (list ?? []).filter((n) => n.noteId !== note.noteId));
  }

  /**
   * The kind a history row presets (decision 3 of the plan): a stake,
   * toStake; a payout received from the fund, income, and one seen by its
   * proposer, other; a creation or a proposal, other; a transfer between
   * two of the pod's own accounts, toOwn on the sender's history and
   * fromOwn on the receiver's; otherwise sold when the anos left this
   * account, else bought.
   */
  presetKind(t: TransactionItem, accountId: string, accounts: AnosAccountItem[]): NoteKind {
    switch (t.type) {
      case 'transferToFund':
        return 'toStake';
      case 'transferFromFund':
        return t.accountIdTo === accountId ? 'income' : 'other';
      case 'accountCreation':
      case 'fundProposal':
        return 'other';
      default: {
        const mine = new Set(accounts.map((a) => a.accountId));
        const sent = t.accountId === accountId;
        if (t.accountId !== null && t.accountIdTo !== null && mine.has(t.accountId) && mine.has(t.accountIdTo)) return sent ? 'toOwn' : 'fromOwn';
        return sent ? 'sold' : 'bought';
      }
    }
  }

  /** The currency a new note starts with: the newest note's (the one made last) that has one, else `remembered` (the marketplace's), else null. */
  startingCurrency(remembered: string | null): string | null {
    const newest = [...(this.notes() ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((n) => n.details?.currency);
    return newest?.details?.currency ?? remembered ?? null;
  }

  /** The ledger facts of a row for a new note: sent when the history words' sign is minus, the other side as the history page computes it. */
  clearOf(t: TransactionItem, accountId: string): Omit<NoteFields, 'noteBlob'> {
    const words = historyWords(t, accountId, this.lang.words().historyWords);
    return {
      transactionId: t.transactionId,
      accountId,
      otherAccountId: t.accountId === accountId ? t.accountIdTo : t.accountId,
      position: t.position,
      transactedAt: t.createdAt,
      amount: t.amount,
      sent: words.sign === '-',
    };
  }

  /** The session's encryption key, or a thrown "unlock again". */
  private encryptionKey(): Bytes {
    const key = this.session.getEncryptionKey();
    if (!key) throw new Error(this.lang.words().common.noKeyInRam);
    return key;
  }

  /** The private part as noteBlob, hex: wrapJson under the encryption key. */
  private async wrap(details: NoteDetails): Promise<string> {
    return this.crypto.toHex(await this.crypto.wrapJson(details, this.encryptionKey()));
  }

  /** A listed note with its blob opened; details null when the blob does not open under this key. */
  private async open(item: NotedTransactionItem, key: Bytes): Promise<Note> {
    const { noteBlob, ...clear } = item;
    let details: NoteDetails | null;
    try {
      details = await this.crypto.unwrapJson<NoteDetails>(this.crypto.fromHex(noteBlob), key);
    } catch {
      details = null;
    }
    return { ...clear, details };
  }
}
