import { Component, WritableSignal, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { ActivatedRoute, Router } from '@angular/router';
import { CameraComponent, Photo } from '../components/camera.component';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { reasonOf } from '../services/log.service';
import { Image, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService, StatusAnswer } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';

/** An image waiting to be sent, with its preview. */
export interface PendingImage {
  photo: Photo;
  url: string;
}

/** Photos per list per visit: the selfies, and the ID plus anything-else photos together. */
const MAX_IMAGES = 5;

/** The two steps a visit can start at. */
const SELFIE = 0;
const ID = 1;

/**
 * The account recovery walkthrough (wallet spec 8.2): one page for what used
 * to be the two security bucket pages. Seven steps in a vertical stepper:
 * selfie, ID, email, phone, friend or family, bank account (optional),
 * anything else (optional), then a done view. The selfie goes to bucket one
 * on its own when Next is pressed (a fresh key, the deposits under
 * securitybucket1, /add-to-security-bucket-one). Everything else is gathered
 * and sent once at Finish, as bucket two always was (securitybucket2,
 * /add-to-security-bucket-two): the ID and extra photos, and one info line
 * each for phone, email, contact and bank, then every extra line.
 *
 * /account/recovery/selfie opens at the selfie, /account/recovery/details at
 * the ID (route data `start`); the two old /security addresses forward
 * there. On a first visit, until the details are on file (an
 * image and three infos, the next-step rule's line), the ID, email, phone
 * and contact are required; after that every step is optional and Finish
 * needs at least one new thing, or reads Done.
 */
@Component({
  selector: 'app-account-recovery-page',
  imports: [
    FormsModule,
    MatStepperModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    CameraComponent,
  ],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.accountRecovery }}</mat-card-title>
        <mat-card-subtitle>{{ t().recovery.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (done()) {
          <p>{{ t().recovery.doneOnFile(onFile()) }}</p>
          <p>{{ t().recovery.addMore }}</p>
          <button mat-flat-button type="button" (click)="toWallet()">{{ t().recovery.goToWallet }}</button>
        } @else {
          <p class="muted">{{ t().recovery.encrypted }}</p>
          <mat-stepper linear orientation="vertical" [selectedIndex]="startIndex" #stepper>
            <mat-step [completed]="selfieDone()" [label]="t().common.selfieStep">
              @if (selfieDone() && selfies().length === 0) {
                <p>{{ t().recovery.selfieOnFile }}</p>
              } @else {
                <p>{{ t().recovery.takeSelfie }}</p>
              }
              <button mat-button type="button" (click)="why.set(!why())">{{ t().recovery.whyButton }}</button>
              @if (why()) {
                <p class="muted">{{ t().recovery.why }}</p>
              }
              @if (stepper.selectedIndex === 0) {
                @if (selfies().length < max) {
                  <app-camera quality="high" facing="user" (photo)="tookSelfie($event)" />
                } @else {
                  <p class="muted">{{ t().recovery.fiveLimit }}</p>
                }
              }
              <div class="thumbs">
                @for (image of selfies(); track image.url) {
                  <div class="thumb">
                    <img [src]="image.url" [alt]="t().common.selfie" />
                    <button mat-icon-button type="button" (click)="removeSelfie($index)" [attr.aria-label]="t().common.remove"><mat-icon>close</mat-icon></button>
                  </div>
                }
              </div>
              @if (busy()) {
                <mat-progress-bar mode="indeterminate"></mat-progress-bar>
                <p>{{ step() }}</p>
              }
              @if (error(); as text) {
                <p class="error">{{ text }}</p>
              }
              <div class="row">
                <button mat-flat-button type="button" (click)="sendSelfie(stepper)" [disabled]="busy() || (selfies().length === 0 && !selfieDone())">
                  {{ failed() ? t().common.retry : t().common.next }}
                </button>
              </div>
            </mat-step>

            <mat-step [completed]="idDone()" [label]="t().recovery.stepId">
              <p class="muted">{{ t().recovery.moreHelps }}</p>
              <p>{{ t().recovery.idText }}</p>
              @if (stepper.selectedIndex === 1) {
                @if (images().length < max) {
                  <app-camera quality="normal" facing="environment" (photo)="took($event)" />
                } @else {
                  <p class="muted">{{ t().recovery.fiveLimit }}</p>
                }
              }
              <div class="thumbs">
                @for (image of images(); track image.url) {
                  <div class="thumb">
                    <img [src]="image.url" [alt]="t().recovery.photo" />
                    <button mat-icon-button type="button" (click)="remove($index)" [attr.aria-label]="t().common.remove"><mat-icon>close</mat-icon></button>
                  </div>
                }
              </div>
              <div class="row">
                <button mat-flat-button type="button" matStepperNext [disabled]="!idDone()">{{ t().common.next }}</button>
              </div>
            </mat-step>

            <mat-step [completed]="emailDone()" [label]="t().recovery.email">
              <p>{{ t().recovery.emailText }}</p>
              <mat-form-field appearance="outline">
                <mat-label>{{ t().recovery.email }}</mat-label>
                <input matInput [ngModel]="email()" (ngModelChange)="email.set($event)" autocomplete="email" />
              </mat-form-field>
              <div class="row">
                <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
                <button mat-flat-button type="button" matStepperNext [disabled]="!emailDone()">{{ t().common.next }}</button>
              </div>
            </mat-step>

            <mat-step [completed]="phoneDone()" [label]="t().recovery.stepPhone">
              <p>{{ t().recovery.phoneText }}</p>
              <mat-form-field appearance="outline">
                <mat-label>{{ t().recovery.phoneLabel }}</mat-label>
                <input matInput [ngModel]="phone()" (ngModelChange)="phone.set($event)" autocomplete="tel" />
              </mat-form-field>
              <div class="row">
                <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
                <button mat-flat-button type="button" matStepperNext [disabled]="!phoneDone()">{{ t().common.next }}</button>
              </div>
            </mat-step>

            <mat-step [completed]="contactDone()" [label]="t().recovery.stepContact">
              <p>{{ t().recovery.contactText }}</p>
              <div class="fields">
                <mat-form-field appearance="outline">
                  <mat-label>{{ t().recovery.theirName }}</mat-label>
                  <input matInput [ngModel]="contactName()" (ngModelChange)="contactName.set($event)" />
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>{{ t().recovery.theirPhone }}</mat-label>
                  <input matInput [ngModel]="contactPhone()" (ngModelChange)="contactPhone.set($event)" />
                </mat-form-field>
              </div>
              <div class="row">
                <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
                <button mat-flat-button type="button" matStepperNext [disabled]="!contactDone()">{{ t().common.next }}</button>
                @if (!contactDone() && !contactEmpty()) {
                  <span class="muted">{{ t().recovery.bothNameAndNumber }}</span>
                }
              </div>
            </mat-step>

            <mat-step optional [label]="t().recovery.stepBank">
              <p>{{ t().recovery.bankText }}</p>
              <p class="muted">{{ t().recovery.bankEncrypted }}</p>
              <div class="fields">
                <mat-form-field appearance="outline">
                  <mat-label>{{ t().recovery.bank }}</mat-label>
                  <input matInput [ngModel]="bankName()" (ngModelChange)="bankName.set($event)" />
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>{{ t().recovery.nameOnAccount }}</mat-label>
                  <input matInput [ngModel]="accountName()" (ngModelChange)="accountName.set($event)" autocomplete="name" />
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>{{ t().recovery.accountNumber }}</mat-label>
                  <input matInput [ngModel]="accountNumber()" (ngModelChange)="accountNumber.set($event)" />
                </mat-form-field>
              </div>
              <div class="row">
                <button mat-button type="button" matStepperPrevious>{{ t().common.back }}</button>
                <button mat-button type="button" matStepperNext (click)="skipBank()">{{ t().recovery.skip }}</button>
                <button mat-flat-button type="button" matStepperNext [disabled]="!bankDone()">{{ t().common.next }}</button>
                @if (!bankDone() && !bankEmpty()) {
                  <span class="muted">{{ t().recovery.allThreeOrSkip }}</span>
                }
              </div>
            </mat-step>

            <mat-step optional [label]="t().recovery.stepExtra">
              <p>{{ t().recovery.extraText }}</p>
              <p class="muted">{{ t().recovery.moreHelps }}</p>
              @if (stepper.selectedIndex === 6) {
                @if (images().length < max) {
                  <app-camera quality="normal" facing="environment" (photo)="took($event)" />
                } @else {
                  <p class="muted">{{ t().recovery.fiveLimit }}</p>
                }
              }
              <div class="thumbs">
                @for (image of images(); track image.url) {
                  <div class="thumb">
                    <img [src]="image.url" [alt]="t().recovery.photo" />
                    <button mat-icon-button type="button" (click)="remove($index)" [attr.aria-label]="t().common.remove"><mat-icon>close</mat-icon></button>
                  </div>
                }
              </div>
              <mat-form-field appearance="outline" class="wide">
                <mat-label>{{ t().recovery.extraLabel }}</mat-label>
                <textarea matInput rows="3" [ngModel]="extra()" (ngModelChange)="extra.set($event)"></textarea>
              </mat-form-field>
              @if (busy()) {
                <mat-progress-bar mode="indeterminate"></mat-progress-bar>
                <p>{{ step() }}</p>
              }
              @if (error(); as text) {
                <p class="error">{{ text }}</p>
              }
              <div class="row">
                <button mat-button type="button" matStepperPrevious [disabled]="busy()">{{ t().common.back }}</button>
                <button mat-flat-button type="button" (click)="finish()" [disabled]="busy() || !canFinish()">{{ finishLabel() }}</button>
                @if (!canFinish()) {
                  <span class="muted">{{ t().recovery.minimum }}</span>
                }
              </div>
            </mat-step>
          </mat-stepper>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    p { max-width: 640px; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .thumb { position: relative; }
    .thumb img { width: 120px; height: 90px; object-fit: cover; border-radius: 8px; }
    .thumb button { position: absolute; top: -8px; right: -8px; background: var(--mat-sys-surface); }
    .fields { display: flex; flex-wrap: wrap; gap: 8px; max-width: 720px; }
    mat-form-field { min-width: 260px; }
    .wide { width: 100%; max-width: 720px; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class AccountRecoveryPage {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly shares = inject(SharesService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The selfie at /account/recovery/selfie, the ID at /account/recovery/details. */
  protected readonly startIndex = inject(ActivatedRoute).snapshot.data['start'] === 'details' ? ID : SELFIE;
  /** True until the details are on file: then the ID, email, phone and contact are required. */
  protected readonly firstVisit = !detailsOnFile(this.session.status());

  protected readonly max = MAX_IMAGES;
  protected readonly selfies = signal<PendingImage[]>([]);
  protected readonly images = signal<PendingImage[]>([]);
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly contactName = signal('');
  protected readonly contactPhone = signal('');
  protected readonly bankName = signal('');
  protected readonly accountName = signal('');
  protected readonly accountNumber = signal('');
  protected readonly extra = signal('');
  protected readonly why = signal(false);
  protected readonly selfieSent = signal(false);
  protected readonly busy = signal(false);
  protected readonly step = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly failed = signal(false);
  protected readonly done = signal(false);

  /** The linear stepper lets a step be left once it is complete; on a return visit every one is. */
  protected readonly selfieDone = computed(() => this.selfieSent() || this.startIndex === ID);
  protected readonly idDone = computed(() => !this.firstVisit || this.images().length > 0);
  protected readonly emailDone = computed(() => !this.firstVisit || this.email().trim() !== '');
  protected readonly phoneDone = computed(() => !this.firstVisit || this.phone().trim() !== '');
  protected readonly contactBoth = computed(() => this.contactName().trim() !== '' && this.contactPhone().trim() !== '');
  protected readonly contactEmpty = computed(() => this.contactName().trim() === '' && this.contactPhone().trim() === '');
  protected readonly contactDone = computed(() => this.contactBoth() || (!this.firstVisit && this.contactEmpty()));
  protected readonly bankDone = computed(
    () => this.bankName().trim() !== '' && this.accountName().trim() !== '' && this.accountNumber().trim() !== '',
  );
  protected readonly bankEmpty = computed(
    () => this.bankName().trim() === '' && this.accountName().trim() === '' && this.accountNumber().trim() === '',
  );

  /** The first visit's minimum: an ID photo, the email, the phone and the contact. */
  protected readonly minimumMet = computed(
    () => this.images().length > 0 && this.email().trim() !== '' && this.phone().trim() !== '' && this.contactBoth(),
  );
  /** Something for Finish to send: a photo or a line. */
  protected readonly hasNew = computed(() => this.images().length > 0 || this.texts().length > 0);
  protected readonly canFinish = computed(() => !this.firstVisit || this.minimumMet());
  protected readonly finishLabel = computed(() => (this.failed() ? this.t().common.retry : this.hasNew() ? this.t().recovery.finish : this.t().common.done));

  /** What the status counts after the send, for the done view. */
  protected readonly onFile = computed(() => {
    const status = this.session.status();
    return this.t().recovery.onFile(status?.bucketOneImages ?? 0, status?.bucketTwoImages ?? 0, status?.bucketTwoInfos ?? 0);
  });

  protected tookSelfie(photo: Photo): void {
    this.push(this.selfies, photo);
  }

  protected removeSelfie(index: number): void {
    this.drop(this.selfies, index);
  }

  protected took(photo: Photo): void {
    this.push(this.images, photo);
  }

  protected remove(index: number): void {
    this.drop(this.images, index);
  }

  protected skipBank(): void {
    this.bankName.set('');
    this.accountName.set('');
    this.accountNumber.set('');
  }

  protected toWallet(): void {
    void this.router.navigateByUrl(this.session.nextStep());
  }

  /** Next on the selfie step: the bucket one flow, then on to the ID. With nothing new and a selfie on file, just on. */
  protected async sendSelfie(stepper: MatStepper): Promise<void> {
    const selfies = this.selfies();
    if (selfies.length === 0) {
      if (this.selfieDone()) stepper.next();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.failed.set(false);
    try {
      this.step.set(this.t().recovery.encryptingSelfie);
      const key = this.crypto.newBucketKey();
      const encrypted = await this.encryptAll(key, selfies);
      this.step.set(this.t().recovery.depositingKey);
      const { keyId } = await this.shares.deposit(key, 'securitybucket1');
      this.step.set(this.t().recovery.storingSelfie);
      const res = await this.api.addToSecurityBucketOne(keyId, encrypted);
      if (!res.ok) throw new Error(`/add-to-security-bucket-one: ${reasonOf(res)}`);
      key.fill(0);
      this.clear(this.selfies);
      this.selfieSent.set(true);
      await this.refreshStatus();
      stepper.steps.first.completed = true;
      stepper.next();
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
      this.step.set('');
    }
  }

  /** Finish: the bucket two flow with everything gathered, then the done view. With nothing new, the done view at once. */
  protected async finish(): Promise<void> {
    if (!this.canFinish()) return;
    if (!this.hasNew()) {
      this.done.set(true);
      return;
    }
    const images = this.images();
    const texts = this.texts();
    this.busy.set(true);
    this.error.set(null);
    this.failed.set(false);
    try {
      this.step.set(this.t().recovery.encrypting);
      const key = this.crypto.newBucketKey();
      const encrypted = await this.encryptAll(key, images);
      const info: { info: string }[] = [];
      for (const text of texts) info.push({ info: await this.crypto.encryptToBase64(key, this.crypto.utf8(text)) });
      this.step.set(this.t().recovery.depositingKey);
      const { keyId } = await this.shares.deposit(key, 'securitybucket2');
      this.step.set(this.t().recovery.storing);
      const res = await this.api.addToSecurityBucketTwo(keyId, encrypted, info);
      if (!res.ok) throw new Error(`/add-to-security-bucket-two: ${reasonOf(res)}`);
      key.fill(0);
      this.clear(this.images);
      for (const field of [this.email, this.phone, this.contactName, this.contactPhone, this.bankName, this.accountName, this.accountNumber, this.extra]) {
        field.set('');
      }
      await this.refreshStatus();
      this.done.set(true);
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
      this.step.set('');
    }
  }

  /**
   * The info lines in the spec's order: phone, email, contact, bank, then
   * every extra line. Empty ones are left out; the contact and the bank only
   * go in whole.
   */
  private texts(): string[] {
    const lines: string[] = [];
    const phone = this.phone().trim();
    const email = this.email().trim();
    if (phone !== '') lines.push(`phone: ${phone}`);
    if (email !== '') lines.push(`email: ${email}`);
    if (this.contactBoth()) lines.push(`contact: ${this.contactName().trim()}, ${this.contactPhone().trim()}`);
    if (this.bankDone()) lines.push(`bank: ${this.bankName().trim()}, ${this.accountName().trim()}, ${this.accountNumber().trim()}`);
    for (const line of this.extra().split('\n')) {
      if (line.trim() !== '') lines.push(line.trim());
    }
    return lines;
  }

  private async encryptAll(key: Uint8Array, list: PendingImage[]): Promise<Image[]> {
    const encrypted: Image[] = [];
    for (const { photo } of list) {
      encrypted.push({ contentType: photo.contentType, image: await this.crypto.encryptToBase64(key, photo.bytes) });
    }
    return encrypted;
  }

  private async refreshStatus(): Promise<void> {
    const status = await this.api.checkAnopodStatus();
    if (status.ok) this.session.status.set(status.body);
  }

  private fail(err: unknown): void {
    this.failed.set(true);
    this.error.set(
      err instanceof DepositError ? this.t().recovery.retryFresh(err.message) : err instanceof Error ? err.message : String(err),
    );
  }

  private push(list: WritableSignal<PendingImage[]>, photo: Photo): void {
    if (list().length >= MAX_IMAGES) return;
    list.update((items) => [...items, { photo, url: URL.createObjectURL(new Blob([photo.bytes as BlobPart], { type: photo.contentType })) }]);
  }

  private drop(list: WritableSignal<PendingImage[]>, index: number): void {
    list.update((items) => {
      URL.revokeObjectURL(items[index].url);
      return items.filter((_, i) => i !== index);
    });
  }

  private clear(list: WritableSignal<PendingImage[]>): void {
    for (const item of list()) URL.revokeObjectURL(item.url);
    list.set([]);
  }
}

/** The next-step rule's bucket two line: an image and three infos on file. */
function detailsOnFile(status: StatusAnswer | null | undefined): boolean {
  return !!status && status.bucketTwoImages > 0 && status.bucketTwoInfos >= 3;
}
