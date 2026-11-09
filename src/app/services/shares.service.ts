import { Injectable, inject } from '@angular/core';
import { KEYHOLDER_DEPOSIT_TIMEOUT_MS } from '../constants';
import { ConfigService } from './config.service';
import { CryptoService } from './crypto.service';
import { KeyholderApiService, OwnerAnswer, ShareType } from './keyholder-api.service';
import { LanguageService } from './language.service';
import { ApiError, ApiResponse, reasonOf } from './log.service';
import { KeyholderPublicKey, SessionService } from './session.service';

/** What a deposit left behind: the key id every share and the masterpod row carry. */
export interface Deposit {
  keyId: string;
}

/** Fewer keyholders stored the share than the floor needs: the step stops and Retry starts it again with a fresh secret. The sentence comes from the dictionary (shares.floorNotReached). */
export class DepositError extends Error {
  constructor(
    readonly stored: number,
    readonly needed: number,
    /** The numbers of the keyholders that refused, did not answer in time, or whose receiving key could not be fetched. */
    readonly failed: number[],
    message: string,
  ) {
    super(message);
  }
}

/** What the owner lookup came to: the anoPod id the first keyholder to answer 200 named, or not found with how many keyholders said so (zero: none could be reached). */
export type OwnerLookup = { found: true; anopodId: string } | { found: false; answered: number };

/** One keyholder's part of a deposit: `reason` is null when it answered 201. */
interface Outcome {
  n: number;
  reason: string | null;
}

/**
 * The two things the wallet does with the keyholders as a set: the deposit
 * of a secret and, since 2026-11-08, the owner lookup of a locked-out
 * person (findOwner, below the deposit).
 *
 * The deposit rule of wallet spec section 6, one function: the secret is
 * split into as many shares as /api/config says keyholders, threshold
 * shareThreshold; share n goes to keyholder n through /receive-share, the
 * receiving key fetched once per session, every keyholder at once, each
 * call with a time limit of KEYHOLDER_DEPOSIT_TIMEOUT_MS. The deposit goes
 * through when at least the floor stored it: depositFloorPercent of the
 * keyholders, rounded up, never below shareThreshold (every keyholder when
 * the proxy sends no percent). A keyholder that is down misses that share
 * for good; the secret still rebuilds from any shareThreshold of the
 * others. Below the floor a DepositError names the counts and the first
 * failure; the shares already stored are orphans under a keyId nothing
 * names.
 */
@Injectable({ providedIn: 'root' })
export class SharesService {
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);
  private readonly keyholders = inject(KeyholderApiService);
  private readonly lang = inject(LanguageService);
  private readonly session = inject(SessionService);

  /** Deposits `secret` as `shareType` on the keyholders; returns the fresh keyId once at least the floor stored a share. */
  async deposit(secret: Uint8Array, shareType: ShareType): Promise<Deposit> {
    const identity = this.session.getIdentity();
    if (!identity) throw new Error(this.lang.words().shares.noIdentity);
    const { keyholders, shareThreshold, depositFloorPercent } = await this.config.load();
    const floor = depositFloorPercent === undefined ? keyholders : Math.ceil((keyholders * depositFloorPercent) / 100);
    const needed = Math.max(floor, shareThreshold);
    const keyId = this.crypto.newKeyId();
    const aad = this.crypto.shareAad(identity.lookupId, shareType, keyId);
    const shares = await this.crypto.splitSecret(secret, keyholders, shareThreshold);
    const body = { lookupId: identity.lookupId, publicLedgerId: identity.publicLedgerId, shareType, keyId };

    // Share n to keyholder n: its receiving key, the share encrypted to it,
    // /receive-share. Nothing in here throws: a refusal, no answer in time
    // or a key that could not be fetched is that keyholder's reason.
    const send = async (n: number, share: (typeof shares)[number]): Promise<Outcome> => {
      try {
        const key = await this.receivingKey(n);
        const encrypted = await this.crypto.encryptToHybrid(key.receivingKey, share, aad);
        const res = await this.keyholders.receiveShare(n, { ...body, share: this.crypto.toHex(encrypted) }, KEYHOLDER_DEPOSIT_TIMEOUT_MS);
        return { n, reason: res.ok && res.status === 201 ? null : reasonOf(res) };
      } catch (err) {
        return { n, reason: err instanceof Error ? err.message : String(err) };
      }
    };

    const outcomes = await Promise.all(shares.map((share, i) => send(i + 1, share)));
    const failed = outcomes.filter((o) => o.reason !== null);
    const stored = keyholders - failed.length;
    if (stored < needed) {
      const first = failed[0];
      const message = this.lang.words().shares.floorNotReached(stored, keyholders, needed, first.n, first.reason ?? '');
      throw new DepositError(stored, needed, failed.map((o) => o.n), message);
    }
    return { keyId };
  }

  /**
   * The owner lookup of a locked-out person (wallet spec 12.3; keyholder
   * spec section 15, /get-owner): every keyholder of /api/config is asked
   * at once, each with KEYHOLDER_DEPOSIT_TIMEOUT_MS. Found when any answers
   * 200, the first in keyholder order winning; a 404 whose reason is
   * "unknown lookup id" is a keyholder that said not found; anything else
   * (no answer in time, 502, a doorman without the route answering 404 Not
   * Found) is a keyholder that did not answer. With no 200, `answered` is
   * how many said not found: zero means the keyholders could not be reached.
   */
  async findOwner(lookupId: string): Promise<OwnerLookup> {
    const { keyholders } = await this.config.load();
    const results = await Promise.all(
      Array.from({ length: keyholders }, (_, i) => this.keyholders.getOwner(i + 1, lookupId, KEYHOLDER_DEPOSIT_TIMEOUT_MS)),
    );
    const hit = results.find((res) => res.ok && res.status === 200);
    if (hit) return { found: true, anopodId: hit.body.anopodId };
    const saidNotFound = (res: ApiResponse<OwnerAnswer>) => res.status === 404 && (res.body as unknown as Partial<ApiError> | null)?.error === 'unknown lookup id';
    return { found: false, answered: results.filter(saidNotFound).length };
  }

  /** Keyholder n's receiving key, fetched the first time it is needed in this session, within the deposit's time limit. */
  private async receivingKey(n: number): Promise<KeyholderPublicKey> {
    const cached = this.session.keyholderKeys.get(n);
    if (cached) return cached;
    const res = await this.keyholders.getPublicKey(n, KEYHOLDER_DEPOSIT_TIMEOUT_MS);
    if (!res.ok) throw new Error(this.lang.words().shares.keyNotFetched(reasonOf(res)));
    this.session.keyholderKeys.set(n, res.body);
    return res.body;
  }
}
