import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { accountNames } from '../account-names';
import { millionthsToAnos } from '../amounts';
import { BalanceCardComponent } from '../components/balance-card.component';
import { CopyButtonComponent } from '../components/copy-button.component';
import { ACCOUNT_POLL_MS } from '../constants';
import { AnosApiService } from '../services/anos-api.service';
import { AccountBalance, BalancesService } from '../services/balances.service';
import { ACCOUNT_TYPES, AccountType, BrowserAccountKeys, CreateAccountTransaction, CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { AnosAccountItem, SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';
import { SigningService } from '../services/signing.service';
import { shortId } from '../short-id';

interface Step {
  label: string;
  state: 'todo' | 'doing' | 'done' | 'failed';
}

/** A 400 from the validator that means the creation is already there, which counts as submitted. */
const ALREADY_THERE = /already (exists|pending|in the garlic chain)/;

/**
 * The wallet page (wallet spec 8.2, Wallet): the balance card on top
 * (balance-card.component over balances.service, shared with Home), then a
 * button to the Noted transactions page (2026-11-07); then the accounts
 * from /list-anos-accounts as cards, each named by its type
 * (account-names.ts), with its balance in large type once it is on the
 * ledger, what is available and held while something is held, its state
 * while it is not on the ledger, the id in short form with a copy button
 * (8.5) and Resubmit for a creation that never reached the validator; then
 * Open a new account, the six-step progress list. The balances are read
 * when the page opens, by Refresh and every 5 seconds while an account is
 * not on the ledger yet or any anos are held or pending. A lost account
 * (its keyBlob does not open under the key blob key: the keys went with
 * an old passkey, 2026-11-08) shows the lock-off icon and "Lost with the
 * old passkey" in place of the balance and, when /list-my-break-glass-moves
 * lists a move for it, the move's state under it (balances.service).
 */
@Component({
  selector: 'app-wallet-page',
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatProgressBarModule, CopyButtonComponent, BalanceCardComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().wallet.title }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        @if (listError(); as text) {
          <p class="error">{{ text }}</p>
        }
        <app-balance-card />
        <p><a mat-stroked-button routerLink="/wallet/notes"><mat-icon>sticky_note_2</mat-icon> {{ t().notes.pageTitle }}</a></p>

        <h3>{{ t().wallet.accountsTitle }}</h3>
        <div class="cards">
          @for (account of session.accounts(); track account.accountId) {
            <mat-card appearance="outlined" class="account">
              <a class="main" [routerLink]="['/wallet', account.accountId]">
                <span class="name">
                  <mat-icon>{{ account.accountType === 'vault' ? 'lock' : account.accountType === 'guarded' ? 'shield' : account.accountType === 'assisted' ? 'group' : 'account_balance_wallet' }}</mat-icon>
                  {{ names().get(account.accountId) }}
                </span>
                @if (balances.byAccount()[account.accountId]; as entry) {
                  @if (entry.lost) {
                    <span class="lost"><mat-icon>no_encryption</mat-icon> {{ t().wallet.lost }}</span>
                    @if (moveWords(account.accountId); as words) {
                      <span class="small muted">{{ words }}</span>
                    }
                  } @else if (entry.landed) {
                    <span class="balance">{{ balanceWords(entry) }}</span>
                    @if (heldWords(entry); as held) {
                      <span class="small muted">{{ held }}</span>
                    }
                    @if (entry.partial) {
                      <span class="small muted">{{ t().wallet.partial }}</span>
                    }
                  } @else if (!account.submittedAt) {
                    <span class="muted">{{ t().wallet.notSubmitted }}</span>
                  } @else if (entry.error === 'not landed yet') {
                    <span class="muted">{{ t().wallet.waitingForLedger }}</span>
                  } @else {
                    <span class="error">{{ entry.error }}</span>
                  }
                } @else {
                  <span class="muted">{{ t().common.reading }}</span>
                }
              </a>
              <div class="footer">
                <code>{{ shortId(account.accountId) }}</code>
                <app-copy-button [text]="account.accountId" [label]="t().common.copyAccountId" />
                @if (!account.submittedAt) {
                  <button mat-stroked-button type="button" (click)="resubmit(account)" [disabled]="busy()">{{ t().wallet.resubmit }}</button>
                }
              </div>
            </mat-card>
          } @empty {
            <p class="muted">{{ t().wallet.noAccounts }}</p>
          }
        </div>

        <h3>{{ t().wallet.openTitle }}</h3>
        <div class="row">
          <mat-form-field appearance="outline">
            <mat-label>{{ t().common.type }}</mat-label>
            <mat-select [value]="accountType()" (valueChange)="accountType.set($event)" [disabled]="busy()">
              @for (type of accountTypes; track type) {
                <mat-option [value]="type">{{ t().wallet.typeOption(type) }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button mat-flat-button type="button" (click)="create()" [disabled]="busy()">{{ failedBeforeRegister() ? t().common.retry : t().wallet.createAccount }}</button>
          <button mat-button type="button" (click)="load()" [disabled]="busy()">{{ t().common.refresh }}</button>
        </div>
        @if (steps().length > 0) {
          <mat-list dense>
            @for (step of steps(); track step.label) {
              <mat-list-item>
                <mat-icon matListItemIcon>{{ icon(step.state) }}</mat-icon>
                <span matListItemTitle>{{ step.label }}</span>
              </mat-list-item>
            }
          </mat-list>
        }
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin: 8px 0 16px; }
    .main { display: flex; flex-direction: column; gap: 4px; padding: 16px 16px 8px; color: inherit; text-decoration: none; }
    .name { display: flex; align-items: center; gap: 8px; font-weight: 500; }
    .balance { font-size: 28px; font-weight: 500; line-height: 1.2; margin-top: 4px; }
    .lost { display: flex; align-items: center; gap: 8px; margin-top: 4px; color: var(--mat-sys-on-surface-variant); }
    .small { font-size: 13px; }
    .footer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 0 8px 8px 16px; }
    .footer code { flex: 1; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; }
  `,
})
export class WalletPage {
  protected readonly session = inject(SessionService);
  protected readonly balances = inject(BalancesService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly shares = inject(SharesService);
  private readonly signing = inject(SigningService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly accountTypes = ACCOUNT_TYPES;
  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly shortId = shortId;
  protected readonly accountType = signal<AccountType>('spending');
  protected readonly steps = signal<Step[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly listError = signal<string | null>(null);
  protected readonly failedBeforeRegister = signal(false);

  /** The accounts' names by id, "Spending account 1" and so on (account-names.ts). */
  protected readonly names = computed(() => accountNames(this.session.accounts(), this.t().accountKinds));

  constructor() {
    void this.load();
    // The balances are read again every 5 seconds while an account is not
    // on the ledger yet or any anos are held or pending (balances.service).
    const timer = setInterval(() => {
      if (this.balances.needsPoll() && !this.busy() && !this.balances.busy()) void this.balances.refresh(true);
    }, ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected icon(state: Step['state']): string {
    return { todo: 'radio_button_unchecked', doing: 'pending', done: 'check_circle', failed: 'error' }[state];
  }

  /** A landed account's balance, "125 anos". */
  protected balanceWords(entry: AccountBalance): string {
    return this.t().common.anos(millionthsToAnos(entry.balance ?? 0n));
  }

  /** The line under a lost account's card: the state of its break-glass move (balances.service, moveOf), with the new account's name once moved; null while no move is listed for it. */
  protected moveWords(accountId: string): string | null {
    const move = this.balances.moveOf(accountId);
    if (!move) return null;
    return this.t().wallet.moveState(move.stage, move.signOffs, this.names().get(move.accountIdTo) ?? shortId(move.accountIdTo));
  }

  /** The small line under the balance while something is held: what is available, then the held part named by its kind (one at a time, by the validator's rule). */
  protected heldWords(entry: AccountBalance): string | null {
    if (entry.held <= 0n) return null;
    const words = this.t().wallet;
    const parts: string[] = [];
    if (entry.escrow > 0n) parts.push(words.inEscrow(millionthsToAnos(entry.escrow)));
    if (entry.assisted > 0n) parts.push(words.inAssisted(millionthsToAnos(entry.assisted)));
    if (entry.locked > 0n) parts.push(words.waitingOutLock(millionthsToAnos(entry.locked)));
    if (entry.pending > 0n) parts.push(words.pending(millionthsToAnos(entry.pending)));
    return `${words.available(millionthsToAnos(entry.available))} · ${parts.join(' · ')}`;
  }

  /** The accounts from the masterpod, then the balances of every one. */
  protected async load(): Promise<void> {
    this.listError.set(null);
    const res = await this.masterpod.listAnosAccounts(true);
    if (!res.ok) {
      this.listError.set(`/list-anos-accounts: ${reasonOf(res)}`);
      return;
    }
    this.session.accounts.set(res.body.accounts);
    await this.balances.refresh();
  }

  private setStep(index: number, state: Step['state']): void {
    this.steps.update((steps) => steps.map((step, i) => (i === index ? { ...step, state } : step)));
  }

  /** The six steps of 8.2 Wallet. A failure before step 4 shows Retry (fresh keys); at 5 or 6 the row is unsubmitted and its card shows Resubmit. The key blob goes under the key blob key (2026-11-08), so both keys of the session are asked for first. */
  protected async create(): Promise<void> {
    const keyBlobKey = this.session.getKeyBlobKey();
    if (!this.session.getEncryptionKey()) {
      this.error.set(this.t().common.noKeyInRamSentence);
      return;
    }
    if (!keyBlobKey) {
      this.error.set(this.t().common.noKeyBlobKey);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.failedBeforeRegister.set(false);
    this.steps.set(this.t().wallet.steps.map((label) => ({ label, state: 'todo' })));
    let step = 0;
    try {
      // 1. The keys and the creation signed by the six keys here.
      this.setStep(0, 'doing');
      const secrets = this.crypto.generateAccountSecrets();
      const pairs = this.crypto.pairKeysFromSecrets(secrets);
      const seed = this.crypto.newBreakGlassSeed();
      const breakGlass = await this.crypto.breakGlassKeys(seed);
      const keys: BrowserAccountKeys = { ...pairs, ...breakGlass };
      const walletKeys = await this.signing.publicKeys();
      const unsigned = this.crypto.buildCreateAccountTransaction(keys, walletKeys, this.accountType());
      const keyBlob = this.crypto.toHex(await this.crypto.wrapKeyBlob(secrets, keyBlobKey));
      this.setStep(0, 'done');

      // 2. The break-glass seed to the keyholders, then wiped.
      step = 1;
      this.setStep(1, 'doing');
      await this.shares.deposit(seed, 'breakglasskey');
      seed.fill(0);
      this.setStep(1, 'done');

      // 3. The wallet signatures.
      step = 2;
      this.setStep(2, 'doing');
      const creation = await this.signing.sign(unsigned);
      this.setStep(2, 'done');

      // 4. The masterpod row.
      step = 3;
      this.setStep(3, 'doing');
      const registered = await this.masterpod.createAnosAccount({ accountId: creation.payload.accountId, accountType: this.accountType(), keyBlob, creation });
      if (!registered.ok) throw new Error(`/create-anos-account: ${reasonOf(registered)}`);
      this.setStep(3, 'done');
      await this.load();

      // 5. and 6. The validator, then the mark.
      step = 4;
      await this.submit(creation, 4);
    } catch (err) {
      this.setStep(step, 'failed');
      if (step < 3) this.failedBeforeRegister.set(true);
      this.error.set(err instanceof DepositError ? this.t().wallet.retryFresh(err.message) : err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Resubmit: the stored creation to the validator, then the mark. */
  protected async resubmit(account: AnosAccountItem): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.steps.set(this.t().wallet.steps.map((label, i) => ({ label, state: i < 4 ? 'done' : 'todo' })));
    try {
      await this.submit(account.creation as unknown as CreateAccountTransaction, 4);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async submit(creation: CreateAccountTransaction, firstStep: number): Promise<void> {
    this.setStep(firstStep, 'doing');
    const res = await this.anos.createAccount(creation);
    const alreadyThere = !res.ok && res.status === 400 && ALREADY_THERE.test(reasonOf(res));
    if (!res.ok && !alreadyThere) {
      this.setStep(firstStep, 'failed');
      throw new Error(`/create-account: ${reasonOf(res)}`);
    }
    this.setStep(firstStep, 'done');
    this.setStep(firstStep + 1, 'doing');
    const marked = await this.masterpod.markAnosAccountSubmitted(creation.payload.accountId);
    if (!marked.ok) {
      this.setStep(firstStep + 1, 'failed');
      throw new Error(`/mark-anos-account-submitted: ${reasonOf(marked)}`);
    }
    this.setStep(firstStep + 1, 'done');
    await this.load();
  }
}
