import { Injectable, inject } from '@angular/core';
import { SignedObject, WalletPublicKeys } from './crypto.service';
import { LogService, reasonOf } from './log.service';
import { SessionService } from './session.service';

/**
 * The signing server through the proxy (wallet spec 3 and 7): the wallet
 * pair's public keys, fetched once per session, and /api/sign, which adds
 * the two wallet signatures to a creation, a transfer, a proposal or a
 * follow-up the browser signed with its own keys.
 */
@Injectable({ providedIn: 'root' })
export class SigningService {
  private readonly log = inject(LogService);
  private readonly session = inject(SessionService);

  /** GET /api/sign/public-keys, once per session. */
  async publicKeys(): Promise<WalletPublicKeys> {
    const cached = this.session.walletKeys();
    if (cached) return cached;
    const res = await this.log.get<WalletPublicKeys>('/api/sign/public-keys');
    if (!res.ok) throw new Error(`the signing server's public keys: ${reasonOf(res)}`);
    this.session.walletKeys.set(res.body);
    return res.body;
  }

  /** POST /api/sign: the transaction back with signatures.walletKey and signatures.walletPostQuantumKey set. */
  async sign<T extends SignedObject>(transaction: T): Promise<T> {
    const res = await this.log.post<{ transaction: T }>('/api/sign', { transaction });
    if (!res.ok) throw new Error(`the signing server: ${reasonOf(res)}`);
    return res.body.transaction;
  }
}
