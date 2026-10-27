import { Injectable, computed, inject, signal } from '@angular/core';
import { CryptoService, Envelope, HybridKeys, HybridPublicKey, SessionKeys } from './crypto.service';
import { Bytes } from './passkey.service';

/** The statuses of a case (masterpod spec 12.5). */
export type CaseStatus = 'open' | 'inReview' | 'approved' | 'delivering' | 'completed' | 'dismissed';

/** One event of the person's subset, as /get-recovery-pod answers it (masterpod 12.4.3). */
export interface RecoveryEvent {
  kind: 'opened' | 'scheduled' | 'approved' | 'dismissed' | 'recovered' | 'completed' | string;
  details: Record<string, unknown>;
  createdAt: string;
}

/** One share the keyholders posted, as /get-recovery-pod answers it. */
export interface RecoveryShare {
  shareId: string;
  keyholderId: number;
  shareType: 'backupcode' | 'breakglasskey' | string;
  keyId: string;
  share: string;
  receivedAt: string;
}

/** What /get-recovery-pod answers: the person's view of their case. */
export interface RecoveryPodAnswer {
  caseId: string;
  status: CaseStatus;
  username: string | null;
  contactEmail: string;
  lookupId: string;
  hybridKey: HybridPublicKey;
  hybridKeyBlob: string;
  blob2: string | null;
  events: RecoveryEvent[];
  shares: RecoveryShare[];
}

/** The case page refreshes /get-recovery-pod this often while it is open (wallet spec 12.3). */
export const RECOVERY_POLL_MS = 15_000;

/**
 * The recovery session, apart from SessionService (wallet spec 12.4): one
 * browser tab is one recovery case. Everything secret lives here in plain
 * fields, never in a signal and never on the wire, and dies with the tab;
 * what the pages show is in signals. The recovery session keys sign every
 * recovery request (sign(), the 12.4.1 envelope with caseId as the
 * signer). While the finish runs (wallet 12.3) it also holds what Combine
 * rebuilt: the backup code (every rebuilt candidate, the newest key id
 * first; in practice one) and the break-glass seeds.
 */

@Injectable({ providedIn: 'root' })
export class RecoveryService {
  private readonly crypto = inject(CryptoService);

  // --- secrets, never in a signal and never on the wire -------------------
  private sessionKeys: SessionKeys | null = null;
  private prfOutput: Bytes | null = null;
  private kekPrf: Bytes | null = null;
  private hybridKeys: HybridKeys | null = null;
  private backupCodes: Bytes[] = [];
  private breakGlassSeeds: Bytes[] = [];


  // --- what the pages show --------------------------------------------------
  readonly caseId = signal<string | null>(null);
  readonly status = signal<CaseStatus | null>(null);
  readonly username = signal<string | null>(null);
  readonly contactEmail = signal<string | null>(null);
  readonly lookupId = signal<string | null>(null);
  /** The last /get-recovery-pod answer. */
  readonly pod = signal<RecoveryPodAnswer | null>(null);
  readonly hasPrf = signal(false);
  readonly hasHybridKeys = signal(false);
  /** True once Combine rebuilt the backup code in this tab. */
  readonly hasCombined = signal(false);

  readonly hasSession = computed(() => this.caseId() !== null);


  /**
   * Opens the recovery session: the case, its session keys, its status.
   * Everything else starts empty, unless the same case unlocks again in
   * this tab, which keeps what is in RAM and only replaces the keys.
   */
  open(caseId: string, keys: SessionKeys, status: CaseStatus): void {
    if (this.caseId() !== caseId) this.close();
    this.sessionKeys = keys;
    this.caseId.set(caseId);
    this.status.set(status);
  }

  /** Drops everything: a closed tab does the same. */
  close(): void {
    this.sessionKeys = null;
    this.prfOutput = null;
    this.kekPrf = null;
    this.hybridKeys = null;
    this.backupCodes = [];
    this.breakGlassSeeds = [];
    this.caseId.set(null);

    this.status.set(null);
    this.username.set(null);
    this.contactEmail.set(null);
    this.lookupId.set(null);
    this.pod.set(null);
    this.hasPrf.set(false);
    this.hasHybridKeys.set(false);
    this.hasCombined.set(false);
  }


  /**
   * The masterpod's 12.4.1 envelope for `path`: the payload with this case's
   * id, the path, now, a fresh 16-byte nonce and the body, signed by the
   * recovery session keys. Null when no recovery session is open. The path
   * is the backend's path (/get-recovery-pod), not the proxy's.
   */
  sign(path: string, body: object): Envelope | null {
    const caseId = this.caseId();
    if (!this.sessionKeys || caseId === null) return null;
    const payload = { caseId, path, timestamp: new Date().toISOString(), nonce: this.crypto.randomHex(16), body };
    return { payload, signatures: this.crypto.signPayload(this.sessionKeys, payload) };
  }

  /** Keeps a /get-recovery-pod answer and what the pages show from it. */
  applyPod(answer: RecoveryPodAnswer): void {
    this.pod.set(answer);
    this.status.set(answer.status);
    this.username.set(answer.username);
    this.contactEmail.set(answer.contactEmail);
    this.lookupId.set(answer.lookupId);
  }

  // --- the secrets ----------------------------------------------------------

  setPrfOutput(output: Bytes | null): void {
    this.prfOutput = output;
    this.hasPrf.set(output !== null);
  }

  getPrfOutput(): Bytes | null {
    return this.prfOutput;
  }

  setKekPrf(kek: Bytes | null): void {
    this.kekPrf = kek;
  }

  getKekPrf(): Bytes | null {
    return this.kekPrf;
  }

  setHybridKeys(keys: HybridKeys | null): void {
    this.hybridKeys = keys;
    this.hasHybridKeys.set(keys !== null);
  }

  getHybridKeys(): HybridKeys | null {
    return this.hybridKeys;
  }

  /** What Combine rebuilt (wallet 12.3): the backup code candidates, newest key id first, and the break-glass seeds. */
  setCombined(codes: Bytes[], seeds: Bytes[]): void {
    this.backupCodes = codes;
    this.breakGlassSeeds = seeds;
    this.hasCombined.set(codes.length > 0);
  }

  getBackupCodes(): Bytes[] {
    return this.backupCodes;
  }

  getBreakGlassSeeds(): Bytes[] {
    return this.breakGlassSeeds;
  }
}

