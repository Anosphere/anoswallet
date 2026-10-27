import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { ACCOUNT_POLL_MS } from '../constants';
import { AnosApiService } from '../services/anos-api.service';
import { ACCOUNT_TYPES, AccountType, BrowserAccountKeys, CreateAccountTransaction, CryptoService } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { AnosAccountItem, SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';
import { SigningService } from '../services/signing.service';

/** What the ledger says about an account: not landed yet, or its balance. */
interface LedgerState {
  landed: boolean;
  balance: string | null;
  error: string | null;
}

interface Step {
  label: string;
  state: 'todo' | 'doing' | 'done' | 'failed';
}

const STEPS = [
  'Pair one, pair two, the break-glass seed and its keys; the creation signed by the six keys here',
  'Deposit the break-glass seed with the keyholders',
  'The signing server adds the two wallet signatures',
  'Register the account on the masterpod (/create-anos-account)',
  'Submit the creation to the validator (/create-account)',
  'Mark it submitted on the masterpod',
] as const;

/** A 400 from the validator that means the creation is already there, which counts as submitted. */
const ALREADY_THERE = /already (exists|pending|in the garlic chain)/;

/**
 * The wallet page (wallet spec 8.2): "Your anoPod is complete." The accounts
 * from /list-anos-accounts, each with its type, its masterpod state and its
 * ledger state from /get-account; Create anos account as a progress list;
 * Resubmit for an account whose creation never reached the validator.
 */
@Component({
  selector: 'app-wallet-page',
  imports: [FormsModule, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatProgressBarModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Wallet</mat-card-title>
        <mat-card-subtitle>Your anoPod is complete. Your anos accounts live here.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (listError(); as text) {
          <p class="error">{{ text }}</p>
        }
        <mat-list>
          @for (account of session.accounts(); track account.accountId) {
            <mat-list-item lines="3">
              <mat-icon matListItemIcon>{{ account.accountType === 'vault' ? 'lock' : account.accountType === 'guarded' ? 'shield' : account.accountType === 'assisted' ? 'group' : 'account_balance_wallet' }}</mat-icon>
              <a matListItemTitle [routerLink]="['/wallet', account.accountId]"><code>{{ account.accountId }}</code></a>
              <span matListItemLine>{{ account.accountType }} · masterpod: {{ account.submittedAt ? 'submitted ' + account.submittedAt : 'not submitted' }}</span>
              <span matListItemLine>
                @if (ledger()[account.accountId]; as state) {
                  ledger: {{ state.landed ? (state.balance !== null ? millionthsToAnos(state.balance) + ' anos' : 'landed') : (state.error ?? 'not landed yet') }}
                } @else {
                  ledger: checking…
                }
              </span>
              <span matListItemMeta>
                @if (!account.submittedAt) {
                  <button mat-stroked-button type="button" (click)="resubmit(account)" [disabled]="busy()">Resubmit</button>
                }
              </span>
            </mat-list-item>
          } @empty {
            <p class="muted">No anos account yet.</p>
          }
        </mat-list>

        <h3>Create anos account</h3>
        <div class="row">
          <mat-form-field appearance="outline">
            <mat-label>Type</mat-label>
            <mat-select [value]="accountType()" (valueChange)="accountType.set($event)" [disabled]="busy()">
              @for (type of accountTypes; track type) {
                <mat-option [value]="type">{{ type }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button mat-flat-button type="button" (click)="create()" [disabled]="busy()">{{ failedBeforeRegister() ? 'Retry' : 'Create anos account' }}</button>
          <button mat-button type="button" (click)="load()" [disabled]="busy()">Refresh</button>
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
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    code { font-size: 12px; }
  `,
})
export class WalletPage {
  protected readonly session = inject(SessionService);
  private readonly masterpod = inject(MasterpodApiService);
  private readonly anos = inject(AnosApiService);
  private readonly crypto = inject(CryptoService);
  private readonly shares = inject(SharesService);
  private readonly signing = inject(SigningService);

  protected readonly accountTypes = ACCOUNT_TYPES;
  protected readonly millionthsToAnos = millionthsToAnos;
  protected readonly accountType = signal<AccountType>('spending');
  protected readonly ledger = signal<Record<string, LedgerState>>({});
  protected readonly steps = signal<Step[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly listError = signal<string | null>(null);
  protected readonly failedBeforeRegister = signal(false);

  constructor() {
    void this.load();
    // Accounts not yet on the ledger are polled every 5 seconds.
    const timer = setInterval(() => void this.pollLedger(), ACCOUNT_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected icon(state: Step['state']): string {
    return { todo: 'radio_button_unchecked', doing: 'pending', done: 'check_circle', failed: 'error' }[state];
  }

  /** The accounts from the masterpod, then each one's ledger state. */
  protected async load(): Promise<void> {
    this.listError.set(null);
    const res = await this.masterpod.listAnosAccounts(true);
    if (!res.ok) {
      this.listError.set(`/list-anos-accounts: ${reasonOf(res)}`);
      return;
    }
    this.session.accounts.set(res.body.accounts);
    for (const account of res.body.accounts) await this.checkLedger(account, false);
  }

  private async pollLedger(): Promise<void> {
    if (this.busy()) return;
    for (const account of this.session.accounts()) {
      if (!this.ledger()[account.accountId]?.landed) await this.checkLedger(account, true);
    }
  }

  /** /get-account signed by pair one, opened from keyBlob for the signature and dropped. */
  private async checkLedger(account: AnosAccountItem, quiet: boolean): Promise<void> {
    const encryptionKey = this.session.getEncryptionKey();
    if (!encryptionKey) return;
    try {
      const pairOne = await this.crypto.pairOneFromKeyBlob(this.crypto.fromHex(account.keyBlob), encryptionKey);
      const res = await this.anos.getAccount(pairOne, account.accountId, quiet);
      const state: LedgerState = res.ok
        ? { landed: true, balance: res.body.balance, error: null }
        : { landed: false, balance: null, error: res.status === 401 && /unknown account/.test(reasonOf(res)) ? 'not landed yet' : reasonOf(res) };
      this.ledger.update((all) => ({ ...all, [account.accountId]: state }));
    } catch (err) {
      this.ledger.update((all) => ({ ...all, [account.accountId]: { landed: false, balance: null, error: err instanceof Error ? err.message : String(err) } }));
    }
  }

  private setStep(index: number, state: Step['state']): void {
    this.steps.update((steps) => steps.map((step, i) => (i === index ? { ...step, state } : step)));
  }

  /** The six steps of 8.2 Wallet. A failure before step 4 shows Retry (fresh keys); at 5 or 6 the row is unsubmitted and the list shows Resubmit. */
  protected async create(): Promise<void> {
    const encryptionKey = this.session.getEncryptionKey();
    if (!encryptionKey) {
      this.error.set('The encryption key is not in RAM: unlock again.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.failedBeforeRegister.set(false);
    this.steps.set(STEPS.map((label) => ({ label, state: 'todo' })));
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
      const keyBlob = this.crypto.toHex(await this.crypto.wrapKeyBlob(secrets, encryptionKey));
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
      this.error.set(err instanceof DepositError ? `${err.message}. Retry starts over with fresh keys.` : err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Resubmit: the stored creation to the validator, then the mark. */
  protected async resubmit(account: AnosAccountItem): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.steps.set(STEPS.map((label, i) => ({ label, state: i < 4 ? 'done' : 'todo' })));
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
