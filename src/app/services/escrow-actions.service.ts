import { Injectable, inject } from '@angular/core';
import { Accepted, AnosApiService } from './anos-api.service';
import { ConfigService } from './config.service';
import { SigningPasskey, askSigningPasskey } from '../passkey-check';
import { CryptoService, EscrowSignaturePayload, EscrowSignatureType, FollowUp } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse, reasonOf } from './log.service';
import { MasterpodApiService } from './masterpod-api.service';
import { PasskeyService } from './passkey.service';
import { SessionService } from './session.service';
import { SigningService } from './signing.service';

/** The three things a party can do with a held trade, each the follow-up it sends. */
export type EscrowAction = 'release' | 'cancel' | 'dispute';

const FOLLOW_UPS: Record<EscrowAction, EscrowSignatureType> = { release: 'escrowSuccess', cancel: 'escrowCancel', dispute: 'escrowDispute' };

/** A release, a cancel or a dispute that the person has approved with the passkey and that waits to be sent (2026-11-20): the account it is sent as, the follow-up signed by pair one, and the passkey's answer for it. approve() makes it and send() sends it. */
export interface ApprovedEscrowAction {
  accountId: string;
  followUp: FollowUp<EscrowSignaturePayload>;
  passkey: SigningPasskey;
}

/**
 * A release, a cancel or a dispute of an escrow trade (wallet spec 8.2,
 * Escrow trade, and 8.3; 2026-11-17,
 * forclaude/wallet-trade-guide-plan-1.md): the follow-up is built, signed
 * and posted by one piece of code, whichever page sends it. It came out of
 * the escrow trade page, which sends through it; the Release of the pinned
 * card of a marketplace chat (pinned-listing.component.ts) sends through
 * it too. Since 2026-11-20
 * (forclaude/second-key-and-signing-passkey-plan-1.md) it works in two
 * steps. approve(), which the Yes of the page's confirmation box runs,
 * builds the follow-up and asks the device for the passkey, for exactly
 * that follow-up (askSigningPasskey in passkey-check.ts). send(), which
 * the page runs after the box, has it signed and posts it. The service
 * opens no box
 * and shows nothing: the page asks in the confirmation box and shows
 * what came back.
 */
@Injectable({ providedIn: 'root' })
export class EscrowActionsService {
  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly signing = inject(SigningService);
  private readonly passkey = inject(PasskeyService);
  private readonly config = inject(ConfigService);
  private readonly lang = inject(LanguageService);
  private readonly t = this.lang.words;

  /**
   * Builds the follow-up of `action` for the trade `transactionId`, as the
   * account `accountId`, one of this pod's, and asks the passkey for it
   * (2026-11-20; until then one method, send, did this without the passkey
   * and also had the follow-up signed and posted). Pair one is opened from the
   * account's keyBlob for this one signature, as the escrow trade page's
   * pairOne() opens it: the session's accounts, /list-anos-accounts when
   * the account is not among them, the key blob key. Then the
   * escrowSuccess, escrowCancel or escrowDispute follow-up is built with
   * pair one, and the device is asked for the passkey that opened the
   * session, for exactly that follow-up (askSigningPasskey in
   * passkey-check.ts). Resolves with what send() takes: the account, the
   * follow-up and the passkey's answer for it. Throws when the account is
   * not this pod's, when the key blob
   * key is not in RAM, when the keyBlob does not open and when the passkey
   * step does not pass. The Yes of a confirmation box runs it (`approve`,
   * wallet spec 8.9), so what it throws shows in that box, in red.
   */
  async approve(action: EscrowAction, accountId: string, transactionId: string): Promise<ApprovedEscrowAction> {
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
    const followUp = this.crypto.buildFollowUp<EscrowSignaturePayload>(pairOne, { type: FOLLOW_UPS[action], transactionId, accountId });
    const passkey = await askSigningPasskey({ crypto: this.crypto, passkey: this.passkey, session: this.session }, this.t(), [followUp.payload]);
    return { accountId, followUp, passkey };
  }

  /** Sends what approve() made (2026-11-20): /api/sign/<n> adds the wallet pair, with the passkey's answer sent along, and /escrow-signature takes the follow-up. Resolves to the answer of /escrow-signature and decides nothing about it; throws when the signing servers do not sign. */
  async send(approved: ApprovedEscrowAction): Promise<ApiResponse<Accepted>> {
    const signed = await this.signing.sign(approved.followUp, approved.accountId, approved.passkey);
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
