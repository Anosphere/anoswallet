import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { CASES_POLL_MS } from '../constants';
import { AssistedTransferItem, DisputedEscrowItem } from './anos-api.service';
import { AttestingService } from './attesting.service';
import { ConfigService } from './config.service';
import { MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/** The ids this device has seen on the two pages, as localStorage keeps them: oldest first, the newest at the end. */
export interface WorkSeen {
  attesting: string[];
  moderation: string[];
}

/** Each list of seen ids is cut to its newest this many. */
const SEEN_MAX = 500;

/** The two statuses a case is counted in: open or in review. */
const OPEN_STATUSES: ('open' | 'inReview')[] = ['open', 'inReview'];

/** The case ids of the cases that are open or in review. */
export function openCaseIds(cases: { caseId: string; status: string }[]): string[] {
  const open: string[] = OPEN_STATUSES;
  return cases.filter((c) => open.includes(c.status)).map((c) => c.caseId);
}

/**
 * The ids of the things on the Attesting page (decision 25 of
 * forclaude/wallet-case-chats-plan-1.md), one rule for the timer here and
 * for the page's own load: the transaction id of every assisted transfer
 * the validators hold, the transaction id of every disputed escrow they
 * hold, and the case id of every recovery case that is open or in review.
 */
export function attestingWorkIds(trades: AssistedTransferItem[], disputes: DisputedEscrowItem[], recoveries: { caseId: string; status: string }[]): string[] {
  return [...transactionIds(trades, disputes), ...openCaseIds(recoveries)];
}

/**
 * The numbers on the Attesting and the Moderation entries of the menu
 * (wallet spec 8.1 and 8.3; 2026-11-12, decisions 15 and 25 of
 * forclaude/wallet-case-chats-plan-1.md): the things on each page that this
 * device has not seen yet, as the Chat entry counts its unread rooms.
 *
 * A thing on the Attesting page is a row of its three lists: an assisted
 * transfer the validators hold, a disputed escrow the validators hold, a
 * recovery case that is open or in review. A thing on the Moderation page is
 * a recovery case that is open or in review. The service keeps the ids of
 * each page's things and the ids seen on this device; a page's count is how
 * many of its ids are not seen.
 *
 * The lists are read every 15 seconds (CASES_POLL_MS) and once as soon as a
 * session with setup complete is there, each in its own edition only and not
 * while the address is on that page, which reads its lists itself: a page's
 * load hands its ids over (seeAttesting, seeModeration), and they are all
 * seen then, so the number clears when the page is opened. A read that fails
 * leaves its part of the ids as it was and shows nothing.
 *
 * The seen ids are kept in localStorage per pod, under
 * anopod-wallet.work-seen.<anopodId>: read when a pod opens, emptied here
 * when the session closes. They are ids and nothing secret.
 */
@Injectable({ providedIn: 'root' })
export class WorkBadgeService {
  private readonly session = inject(SessionService);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);
  private readonly attesting = inject(AttestingService);
  private readonly masterpod = inject(MasterpodApiService);

  /** The ids of the things on the Attesting page, as last read by the timer here or handed over by the page. */
  readonly attestingIds = signal<string[]>([]);
  /** The ids of the things on the Moderation page, the same way. */
  readonly moderationIds = signal<string[]>([]);
  /** The ids seen on this device, per page. */
  readonly seen = signal<WorkSeen>(emptySeen());

  /** How many of the page's ids are not seen: the number on its menu entry. */
  readonly attestingCount = computed(() => unseen(this.attestingIds(), this.seen().attesting));
  readonly moderationCount = computed(() => unseen(this.moderationIds(), this.seen().moderation));

  /** The recovery cases' part of attestingIds, kept apart so a read of the lists or of the cases that fails leaves its own part as it was. */
  private recoveryIds: string[] = [];
  /** True while a read runs, so the timer never starts a second one beside it. */
  private reading = false;

  constructor() {
    // The seen ids follow the session: read when a pod opens, emptied when the session closes. The ids of the pages start empty with every pod.
    effect(() => {
      const anopodId = this.session.anopodId();
      untracked(() => {
        this.attestingIds.set([]);
        this.moderationIds.set([]);
        this.recoveryIds = [];
        this.seen.set(anopodId === null ? emptySeen() : readSeen(anopodId));
      });
    });
    // One read as soon as a session with setup complete is there, for every pod that opens; then one every CASES_POLL_MS.
    effect(() => {
      if (this.session.anopodId() !== null && this.session.setupComplete()) untracked(() => void this.read());
    });
    const timer = setInterval(() => void this.read(), CASES_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** The Attesting page's own load hands over the ids it read: they become the page's ids and are all marked seen. */
  seeAttesting(ids: string[]): void {
    // What is no transaction of the validators' two lists is a recovery case.
    const transactions = new Set(transactionIds(this.attesting.trades(), this.attesting.disputes()));
    this.recoveryIds = ids.filter((id) => !transactions.has(id));
    this.attestingIds.set(ids);
    this.markSeen('attesting', ids);
  }

  /** The Moderation page's own load hands over the ids it read: they become the page's ids and are all marked seen. */
  seeModeration(ids: string[]): void {
    this.moderationIds.set(ids);
    this.markSeen('moderation', ids);
  }

  /** One read of the edition's lists, quiet: nothing without a session whose setup is complete, nothing while the address is on the page itself, and nothing shown when it fails. */
  private async read(): Promise<void> {
    if (this.reading || !this.session.hasSession() || !this.session.setupComplete()) return;
    this.reading = true;
    try {
      if (this.config.attestorEdition() && !this.router.url.startsWith('/attesting')) await this.readAttesting();
      if (this.config.moderatorEdition() && !this.router.url.startsWith('/moderation')) await this.readModeration();
    } catch {
      // The ids stay as they were.
    } finally {
      this.reading = false;
    }
  }

  /**
   * The attestor edition: the staked account as the Attesting page picks it
   * (AttestingService.loadAccounts) and, with one picked, the validators'
   * two lists (loadLists) and the recovery cases that are open or in review
   * (/list-break-glass-cases), each in its own try. The lists are kept by
   * AttestingService, which leaves them as they were when its read fails;
   * the recovery cases are kept here.
   */
  private async readAttesting(): Promise<void> {
    const anopodId = this.session.anopodId();
    await this.attesting.loadAccounts();
    if (this.attesting.accountId() === '') return;
    let recoveryIds: string[] | null = null;
    try {
      await this.attesting.loadLists(true);
    } catch {
      // The two lists stay as they were.
    }
    try {
      const res = await this.masterpod.listBreakGlassCases(OPEN_STATUSES, true);
      if (res.ok) recoveryIds = res.body.cases.map((c) => c.caseId);
    } catch {
      // The recovery cases stay as they were.
    }
    if (this.session.anopodId() !== anopodId) return;
    if (recoveryIds !== null) this.recoveryIds = recoveryIds;
    this.attestingIds.set([...transactionIds(this.attesting.trades(), this.attesting.disputes()), ...this.recoveryIds]);
  }

  /** The moderator edition: the recovery cases that are open or in review (/list-recovery-cases). */
  private async readModeration(): Promise<void> {
    const anopodId = this.session.anopodId();
    const res = await this.masterpod.listRecoveryCases(OPEN_STATUSES, true);
    if (!res.ok || this.session.anopodId() !== anopodId) return;
    this.moderationIds.set(res.body.cases.map((c) => c.caseId));
  }

  /** The ids join the page's seen list as its newest, the list is cut to its newest SEEN_MAX and written to this device; nothing when the list would not change. */
  private markSeen(page: keyof WorkSeen, ids: string[]): void {
    const anopodId = this.session.anopodId();
    if (anopodId === null) return;
    const handed = new Set(ids);
    const before = this.seen()[page];
    const next = [...before.filter((id) => !handed.has(id)), ...handed].slice(-SEEN_MAX);
    if (next.length === before.length && next.every((id, i) => id === before[i])) return;
    const seen = { ...this.seen(), [page]: next };
    this.seen.set(seen);
    writeSeen(anopodId, seen);
  }
}

/** The transaction ids of the validators' two lists: every assisted transfer (the list carries the break-glass moves too, which are not counted) and every disputed escrow. */
function transactionIds(trades: AssistedTransferItem[], disputes: DisputedEscrowItem[]): string[] {
  return [...trades.filter((trade) => trade.type === 'assistedAnosTransfer').map((trade) => trade.transactionId), ...disputes.map((escrow) => escrow.transactionId)];
}

/** How many of the ids are not among the seen ones. */
function unseen(ids: string[], seen: string[]): number {
  const known = new Set(seen);
  return ids.filter((id) => !known.has(id)).length;
}

function emptySeen(): WorkSeen {
  return { attesting: [], moderation: [] };
}

/** The localStorage key of a pod's seen ids. */
function seenKey(anopodId: string): string {
  return `anopod-wallet.work-seen.${anopodId}`;
}

/** The seen ids kept on this device for the pod: empty when there are none, or the browser refuses. */
function readSeen(anopodId: string): WorkSeen {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(seenKey(anopodId)) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return emptySeen();
    const kept = parsed as Partial<Record<keyof WorkSeen, unknown>>;
    return { attesting: idsOf(kept.attesting), moderation: idsOf(kept.moderation) };
  } catch {
    return emptySeen();
  }
}

/** A stored list as ids: the strings of it, its newest SEEN_MAX; empty for anything that is no list. */
function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-SEEN_MAX) : [];
}

/** Writes the seen ids; a browser that refuses leaves the copy in memory for the tab. */
function writeSeen(anopodId: string, seen: WorkSeen): void {
  try {
    localStorage.setItem(seenKey(anopodId), JSON.stringify(seen));
  } catch {
    // Private mode or blocked storage: the tab keeps its copy.
  }
}
