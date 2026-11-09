import { Injectable, inject } from '@angular/core';
import { AnosApiService } from './anos-api.service';
import { CryptoService, PairOne } from './crypto.service';
import { LanguageService } from './language.service';
import { MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/** One of the pod's accounts with guardian votes: the account and its votes, floor(guardian stake / anosPerVote), as /get-account answers them (anossoftware 25.1). */
export interface GuardianAccount {
  accountId: string;
  votes: number;
}

/**
 * The pod's guardian accounts (wallet spec 8.2, Guardians; the plan is
 * forclaude/wallet-guardians-plan-1.md, 3.5 and its decision 8): what the
 * Guardians page, New fund proposal and the proposal page share. read()
 * asks /get-account for each of the session's accounts, every account at
 * once, each signed by pair one opened from the account's keyBlob with the
 * key blob key and dropped, quietly, and answers the accounts whose
 * guardianVotes is at least 1, the one with the most votes first (ties in
 * list order). An account whose keyBlob does not open (lost with an old
 * passkey), that is not on the ledger yet, whose read is refused or whose
 * validator sends no guardianVotes (one without anossoftware 25) is left
 * out, as a non-guardian; with no key blob key in RAM the list is empty.
 * Every account listed proposes and votes on its own with its own weight:
 * the validators count guardian stake per account, never per pod.
 * pairOne(accountId) opens pair one of one of the session's accounts for
 * one signature, as the account page's pairOne() does; the caller drops it.
 */
@Injectable({ providedIn: 'root' })
export class GuardianAccountsService {
  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The accounts with guardian votes, the biggest first. The session's account list is read from the masterpod first when it is empty, as the account page does before it opens a keyBlob. */
  async read(quiet = true): Promise<GuardianAccount[]> {
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!keyBlobKey) return [];
    await this.ensureAccounts();
    const found = await Promise.all(
      this.session.accounts().map(async (item): Promise<GuardianAccount | null> => {
        try {
          const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
          const res = await this.anos.getAccount(pairOne, item.accountId, quiet);
          const votes = res.ok ? (res.body.guardianVotes ?? 0) : 0;
          return votes >= 1 ? { accountId: item.accountId, votes } : null;
        } catch {
          return null;
        }
      }),
    );
    return found.filter((a): a is GuardianAccount => a !== null).sort((a, b) => b.votes - a.votes);
  }

  /** Pair one of one of the session's accounts, opened from its keyBlob for one signature; the caller drops it. Throws with common.notMyAccount for an id that is not the pod's and common.noKeyBlobKey without the key in RAM. */
  async pairOne(accountId: string): Promise<PairOne> {
    await this.ensureAccounts();
    const item = this.session.accounts().find((a) => a.accountId === accountId);
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!item) throw new Error(this.lang.words().common.notMyAccount);
    if (!keyBlobKey) throw new Error(this.lang.words().common.noKeyBlobKey);
    return this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(item.keyBlob), keyBlobKey);
  }

  /** The session's account list from /list-anos-accounts, quietly, when it is empty; a refusal leaves it empty. */
  private async ensureAccounts(): Promise<void> {
    if (this.session.accounts().length > 0) return;
    const res = await this.masterpod.listAnosAccounts(true);
    if (res.ok) this.session.accounts.set(res.body.accounts);
  }
}
