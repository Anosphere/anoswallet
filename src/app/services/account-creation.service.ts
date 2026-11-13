import { Injectable, inject } from '@angular/core';
import { ACCOUNT_POLL_MS } from '../constants';
import { AnosApiService } from './anos-api.service';
import { BalancesService } from './balances.service';
import { AccountType, BrowserAccountKeys, CreateAccountTransaction, CryptoService, PairOne } from './crypto.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';
import { SharesService } from './shares.service';
import { SigningService } from './signing.service';

/**
 * A 400 from the validator that means the creation is already there, which
 * counts as submitted. The pattern also matches (2026-11-08) the holding
 * tables' refusals of a transfer, "a transaction for this accountId is
 * already pending | locked | held in assisted_transfers | held in
 * escrow_transfers" and "a fund proposal is already open" (anossoftware
 * *_CONFLICT_REASONS), which the recovery's finish counted as a move
 * already filed until 2026-11-10. It no longer does (recovery finish order
 * plan 1): it asks the validator what it holds for the account and files
 * that (recover-case.page), so only the creations read this pattern now.
 */
export const ALREADY_THERE = /already (exists|pending|locked|held in (assisted|escrow)_transfers|open|in the garlic chain)/;

/** What a step of a creation reports: it started, it finished, it failed. */
export type CreationStepState = 'doing' | 'done' | 'failed';

/** Told once per change of a step's state; `step` is the index into wallet.steps (0 to 5). A caller with no stepper passes nothing. */
export type OnCreationStep = (step: number, state: CreationStepState) => void;

/** What createAccount resolves with: the new account's id, and its pair one for one read or signature, which the caller drops. */
export interface CreatedAccount {
  accountId: string;
  pairOne: PairOne;
}

/** How long createAccount waits for the new account to be on the ledger, asking every ACCOUNT_POLL_MS. */
export const LANDING_WAIT_MS = 90_000;

/**
 * Opening an anos account (wallet spec 8.2, Wallet, and 8.3; 2026-11-08):
 * the six steps the Wallet page ran until then, in one place, so the
 * recovery's finish opens the new accounts the same way (wallet spec 12.3,
 * Move your money). 1. pair one, pair two, the break-glass seed and its
 * keys, the creation signed by the six keys here, the key blob under the
 * session's key blob key; 2. the seed deposited with the keyholders as
 * breakglasskey, then wiped; 3. /api/sign/<n> adds the wallet pair; 4.
 * /create-anos-account; 5. /create-account (a 400 saying the creation is
 * already there counts as submitted); 6. /mark-anos-account-submitted;
 * then a wait of up to 90 seconds, /get-account with the new pair one
 * every 5 seconds, until the account is on the ledger. After steps 4 and
 * 6 the session's account list and the balances are read again, so a card
 * for the new account shows at once. Resolves with the account's id and
 * pair one, or throws the step's error after telling `onStep` the step
 * failed (a DepositError as it is, so the Wallet page can say Retry
 * starts over with fresh keys). The Wallet page's Resubmit runs steps 5
 * and 6 alone through submitCreation.
 */
@Injectable({ providedIn: 'root' })
export class AccountCreationService {
  private readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly balances = inject(BalancesService);
  private readonly crypto = inject(CryptoService);
  private readonly shares = inject(SharesService);
  private readonly signing = inject(SigningService);
  private readonly lang = inject(LanguageService);

  /** The six steps and the wait for the ledger; `onStep` follows the steps. Needs the key blob key in RAM. */
  async createAccount(accountType: AccountType, onStep: OnCreationStep = () => undefined): Promise<CreatedAccount> {
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!keyBlobKey) throw new Error(this.lang.words().common.noKeyBlobKey);
    let step = 0;
    try {
      // 1. The keys and the creation signed by the six keys here.
      onStep(0, 'doing');
      const secrets = this.crypto.generateAccountSecrets();
      const pairs = this.crypto.pairKeysFromSecrets(secrets);
      const seed = this.crypto.newBreakGlassSeed();
      const breakGlass = await this.crypto.breakGlassKeys(seed);
      const keys: BrowserAccountKeys = { ...pairs, ...breakGlass };
      const walletKeys = await this.signing.publicKeys();
      const unsigned = this.crypto.buildCreateAccountTransaction(keys, walletKeys, accountType);
      const keyBlob = this.crypto.toHex(await this.crypto.wrapKeyBlob(secrets, keyBlobKey));
      onStep(0, 'done');

      // 2. The break-glass seed to the keyholders, then wiped.
      step = 1;
      onStep(1, 'doing');
      await this.shares.deposit(seed, 'breakglasskey');
      seed.fill(0);
      onStep(1, 'done');

      // 3. The wallet signatures.
      step = 2;
      onStep(2, 'doing');
      const creation = await this.signing.sign(unsigned);
      onStep(2, 'done');

      // 4. The masterpod row. Its limit on new accounts (403 account limit reached, wallet spec 4.4) is said in the one sentence wallet.accountLimit.
      step = 3;
      onStep(3, 'doing');
      const registered = await this.masterpod.createAnosAccount({ accountId: creation.payload.accountId, accountType, keyBlob, creation });
      if (!registered.ok) {
        const atLimit = registered.status === 403 && /account limit reached/.test(reasonOf(registered));
        throw new Error(atLimit ? this.lang.words().wallet.accountLimit : `/create-anos-account: ${reasonOf(registered)}`);
      }
      onStep(3, 'done');
      await this.reload();

      // 5. and 6. The validator, then the mark (submitCreation tells onStep which of the two failed).
      step = -1;
      await this.submitCreation(creation, onStep);

      // The wait: the account on the ledger.
      const pairOne: PairOne = { key1: pairs.key1, postQuantumKey1: pairs.postQuantumKey1 };
      await this.waitForLedger(creation.payload.accountId, pairOne);
      return { accountId: creation.payload.accountId, pairOne };
    } catch (err) {
      if (step >= 0) onStep(step, 'failed');
      throw err;
    }
  }

  /**
   * Steps 5 and 6: the signed creation to the validator (/create-account; a
   * 400 saying it is already there counts as submitted), then
   * /mark-anos-account-submitted, then the account list and the balances
   * read again. Resubmit on the Wallet page runs this alone with the
   * stored creation. Throws the failing step's error after telling `onStep`.
   */
  async submitCreation(creation: CreateAccountTransaction, onStep: OnCreationStep = () => undefined): Promise<void> {
    onStep(4, 'doing');
    const res = await this.anos.createAccount(creation);
    const alreadyThere = !res.ok && res.status === 400 && ALREADY_THERE.test(reasonOf(res));
    if (!res.ok && !alreadyThere) {
      onStep(4, 'failed');
      throw new Error(`/create-account: ${reasonOf(res)}`);
    }
    onStep(4, 'done');
    onStep(5, 'doing');
    const marked = await this.masterpod.markAnosAccountSubmitted(creation.payload.accountId);
    if (!marked.ok) {
      onStep(5, 'failed');
      throw new Error(`/mark-anos-account-submitted: ${reasonOf(marked)}`);
    }
    onStep(5, 'done');
    await this.reload();
  }

  /** The session's account list from /list-anos-accounts, quiet, then the balances: what the Wallet page did after steps 4 and 6. A refused list is left to the next read. */
  private async reload(): Promise<void> {
    const res = await this.masterpod.listAnosAccounts(true);
    if (res.ok) this.session.accounts.set(res.body.accounts);
    await this.balances.refresh(true);
  }

  /** Every ACCOUNT_POLL_MS, up to LANDING_WAIT_MS: /get-account with the new pair one, quiet, until it answers; any refusal (unknown account while the creation has not landed, or a blip) means not yet. Past the limit, wallet.notOnLedgerYet. */
  private async waitForLedger(accountId: string, pairOne: PairOne): Promise<void> {
    const deadline = Date.now() + LANDING_WAIT_MS;
    for (;;) {
      const res = await this.anos.getAccount(pairOne, accountId, true);
      if (res.ok) return;
      if (Date.now() >= deadline) throw new Error(this.lang.words().wallet.notOnLedgerYet(LANDING_WAIT_MS / 1000));
      await new Promise((resolve) => setTimeout(resolve, ACCOUNT_POLL_MS));
    }
  }
}
