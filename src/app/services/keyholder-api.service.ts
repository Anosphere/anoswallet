import { Injectable, inject } from '@angular/core';
import { Envelope } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, LogService } from './log.service';
import { KeyholderPublicKey, SessionService } from './session.service';

/** The four secrets a share can be of, as the keyholder names them. breakglasskey is new with the wallet (spec section 6). */
export type ShareType = 'securitybucket1' | 'securitybucket2' | 'breakglasskey' | 'backupcode';

/** The body of /receive-share (keyholder spec 5.2); `share` is the share encrypted to the receiving key, hex. */
export interface ReceiveShareBody {
  lookupId: string;
  publicLedgerId: string;
  shareType: ShareType;
  keyId: string;
  share: string;
}

export interface ReceiveShareAnswer {
  shareId: string;
  keyholderId: number;
}

/** One share a keyholder hands a moderator (keyholder spec 5.3 and 5.4): the 33-byte share encrypted to the one-time response key, hex. */
export interface BucketKeyShare {
  shareId: string;
  keyId: string;
  createdAt: string;
  share: string;
}

/** What /get-security-bucket-one-key and /get-security-bucket-two-key answer: every share of the type for the lookup id, newest first. */
export interface BucketKeyAnswer {
  lookupId: string;
  shareType: ShareType;
  keyholderId: number;
  shares: BucketKeyShare[];
}

/** What /get-owner answers (keyholder spec 15.1): the anoPod that deposited for the lookup id, in full. A keyholder that knows no such lookup id answers 404 unknown lookup id. */
export interface OwnerAnswer {
  lookupId: string;
  anopodId: string;
  keyholderId: number;
}

/**
 * The HTTP calls to the keyholders (the keyholder test app's, base path
 * /api/keyholder/<n>), one method per route, each taking the keyholder's
 * number since there are five. Two routes are level none, a plain body:
 * /get-keyholder-public-key and, since 2026-11-08, /get-owner, the owner
 * lookup a locked-out person's wallet makes (keyholder spec section 15).
 * A pod-level request is the masterpod's envelope with `path` the
 * keyholder route, signed by the session keys; a moderator-level request
 * is the account envelope (keyholder spec 3.2), signed by pair one of the
 * moderator's staked anos account, which the caller builds with
 * CryptoService.signAccountEnvelope.
 */
@Injectable({ providedIn: 'root' })
export class KeyholderApiService {
  private readonly log = inject(LogService);
  private readonly lang = inject(LanguageService);
  private readonly session = inject(SessionService);

  /** POST /get-keyholder-public-key (level none) on keyholder n. `timeoutMs` caps the wait (a deposit passes KEYHOLDER_DEPOSIT_TIMEOUT_MS). */
  getPublicKey(n: number, timeoutMs?: number): Promise<ApiResponse<KeyholderPublicKey>> {
    return this.log.post(`/api/keyholder/${n}/get-keyholder-public-key`, {}, false, timeoutMs);
  }

  /** POST /get-owner (level none) on keyholder n: which anoPod deposited for `lookupId`. Quiet, since 404 unknown lookup id is the ordinary answer of a keyholder that does not know the id; `timeoutMs` caps the wait (the lookup passes KEYHOLDER_DEPOSIT_TIMEOUT_MS). */
  getOwner(n: number, lookupId: string, timeoutMs?: number): Promise<ApiResponse<OwnerAnswer>> {
    return this.log.post(`/api/keyholder/${n}/get-owner`, { lookupId }, true, timeoutMs);
  }

  /** POST /receive-share (level pod) on keyholder n: the envelope signed by the pod's session keys with a fresh nonce. `timeoutMs` caps the wait. */
  receiveShare(n: number, body: ReceiveShareBody, timeoutMs?: number): Promise<ApiResponse<ReceiveShareAnswer>> {
    const envelope = this.session.sign('/receive-share', body);
    if (!envelope) {
      return Promise.resolve({ ok: false, status: 0, body: { error: this.lang.words().api.noSession } as unknown as ReceiveShareAnswer });
    }
    return this.log.post(`/api/keyholder/${n}/receive-share`, envelope, false, timeoutMs);
  }

  /** POST /get-security-bucket-one-key (level moderator) on keyholder n: the account envelope with body { lookupId, responseKey }. */
  getSecurityBucketOneKey(n: number, envelope: Envelope): Promise<ApiResponse<BucketKeyAnswer>> {
    return this.log.post(`/api/keyholder/${n}/get-security-bucket-one-key`, envelope);
  }

  /** POST /get-security-bucket-two-key (level moderator) on keyholder n, the same way. */
  getSecurityBucketTwoKey(n: number, envelope: Envelope): Promise<ApiResponse<BucketKeyAnswer>> {
    return this.log.post(`/api/keyholder/${n}/get-security-bucket-two-key`, envelope);
  }
}
