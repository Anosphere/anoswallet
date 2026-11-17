import { Injectable, inject } from '@angular/core';
import { Accepted, AnosApiService } from './anos-api.service';
import { ConfigService } from './config.service';
import { CryptoService, EscrowSignatureType } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, reasonOf } from './log.service';
import { MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';
import { SigningService } from './signing.service';

/** The three things a party can do with a held trade, each the follow-up it sends. */
export type EscrowAction = 'release' | 'cancel' | 'dispute';

const FOLLOW_UPS: Record<EscrowAction, EscrowSignatureType> = { release: 'escrowSuccess', cancel: 'escrowCancel', dispute: 'escrowDispute' };

/**
 * A release, a cancel or a dispute of an escrow trade (wallet spec 8.2,
 * Escrow trade, and 8.3; 2026-11-17,
 * forclaude/wallet-trade-guide-plan-1.md): the follow-up is built, signed
 * and posted by one piece of code, whichever page sends it. It came out of
 * the escrow trade page, which sends through it; the Release of the pinned
 * card of a marketplace chat (pinned-listing.component.ts) sends through
 * it too. The service asks nothing
 * and shows nothing: the page asks in the confirmation box first and shows
 * what came back.
 */
@Injectable({ providedIn: 'root' })
export class EscrowActionsService {
  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);
  private readonly config = inject(ConfigService);
  private readonly lang = inject(LanguageService);
  private readonly t = this.lang.words;

  /**
   * Sends the follow-up of `action` for the trade `transactionId`, as the
   * account `accountId`, one of this pod's. Pair one is opened from the
   * account's keyBlob for this one signature, as the escrow trade page's
   * pairOne() opens it: the session's accounts, /list-anos-accounts when
   * the account is not among them, the key blob key. Then the
   * escrowSuccess, escrowCancel or escrowDispute follow-up is built with
   * pair one, /api/sign/<n> adds the wallet pair and /escrow-signature takes
   * it. Resolves to the answer of /escrow-signature and decides nothing
   * about it; throws when the account is not this pod's, when the key blob
   * key is not in RAM, when the keyBlob does not open and when the signing
   * servers do not sign.
   */
  async send(action: EscrowAction, accountId: string, transactionId: string): Promise<ApiResponse<Accepted>> {
    let item = this.session.accounts().find((a) => a.accountId === accountId);
    if (!item) {
      const res = await this.masterpod.listAnosAccounts(true);
      if (res.ok) this.session.accounts.set(res.body.accounts);
      item = this.session.accounts().find((a) => a.accountId === accountId);
    }
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!item) throw new Error(this.t().common.notMyAccount);
    if (!keyBlobKey) throw new Error(this.t().common.noKeyBlobKey);
    const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
    const signed = await this.signing.sign(this.crypto.buildFollowUp(pairOne, { type: FOLLOW_UPS[action], transactionId, accountId }), accountId);
    return this.anos.escrowSignature(signed);
  }

  /** The validator's refusal in plain words where the reason is a known one. */
  plainReason(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    const words = this.t().escrow;
    if (/not approved yet/.test(reason)) return words.notAllAccepted;
    if (/success signature is already present/.test(reason)) return words.alreadyReleased;
    if (/cancel signature is already present/.test(reason)) return words.alreadyCancelled;
    if (/dispute signature is already present/.test(reason)) return words.alreadyDisputed;
    if (/not the seller|not the buyer|neither the seller/.test(reason)) return words.cannotSign;
    if (/cannot be cancelled yet/.test(reason) && typeof this.config.config()?.lockOffsetMinutes === 'number') return words.cancelNotYet(this.t().minutes(this.config.config()!.lockOffsetMinutes!));
    return `/escrow-signature: ${reason}`;
  }
}
