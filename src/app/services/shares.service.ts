import { Injectable, inject } from '@angular/core';
import { ConfigService } from './config.service';
import { CryptoService } from './crypto.service';
import { KeyholderApiService, ShareType } from './keyholder-api.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { KeyholderPublicKey, SessionService } from './session.service';

/** What a deposit left behind: the key id every share and the masterpod row carry. */
export interface Deposit {
  keyId: string;
}

/** A keyholder refused or did not answer: the step stops and Retry starts it again with a fresh secret. The sentence comes from the dictionary (shares.refused). */
export class DepositError extends Error {
  constructor(readonly keyholder: number, message: string) {
    super(message);
  }
}

/**
 * The deposit rule of wallet spec section 6, one function: the secret is
 * split into as many shares as /api/config says keyholders, threshold
 * shareThreshold; share n goes to keyholder n through /receive-share, the
 * receiving key fetched once per session, in order 1 to n; every keyholder
 * must answer 201 before the masterpod step that follows. One failure
 * throws a DepositError naming the keyholder; the shares already stored are
 * orphans under a keyId nothing names.
 */
@Injectable({ providedIn: 'root' })
export class SharesService {
  private readonly config = inject(ConfigService);
  private readonly crypto = inject(CryptoService);
  private readonly keyholders = inject(KeyholderApiService);
  private readonly lang = inject(LanguageService);
  private readonly session = inject(SessionService);

  /** Deposits `secret` as `shareType` on every keyholder; returns the fresh keyId. */
  async deposit(secret: Uint8Array, shareType: ShareType): Promise<Deposit> {
    const identity = this.session.getIdentity();
    if (!identity) throw new Error(this.lang.words().shares.noIdentity);
    const { keyholders, shareThreshold } = await this.config.load();
    const keyId = this.crypto.newKeyId();
    const aad = this.crypto.shareAad(identity.lookupId, shareType, keyId);
    const shares = await this.crypto.splitSecret(secret, keyholders, shareThreshold);

    for (let n = 1; n <= keyholders; n++) {
      const key = await this.receivingKey(n);
      const share = await this.crypto.encryptToHybrid(key.receivingKey, shares[n - 1], aad);
      const res = await this.keyholders.receiveShare(n, {
        lookupId: identity.lookupId,
        publicLedgerId: identity.publicLedgerId,
        shareType,
        keyId,
        share: this.crypto.toHex(share),
      });
      if (!res.ok || res.status !== 201) throw new DepositError(n, this.lang.words().shares.refused(n, reasonOf(res)));
    }
    return { keyId };
  }

  /** Keyholder n's receiving key, fetched the first time it is needed in this session. */
  private async receivingKey(n: number): Promise<KeyholderPublicKey> {
    const cached = this.session.keyholderKeys.get(n);
    if (cached) return cached;
    const res = await this.keyholders.getPublicKey(n);
    if (!res.ok) {
      const words = this.lang.words().shares;
      throw new DepositError(n, words.refused(n, words.keyNotFetched(reasonOf(res))));
    }
    this.session.keyholderKeys.set(n, res.body);
    return res.body;
  }
}
