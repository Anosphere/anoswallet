import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { CameraComponent, Photo } from '../components/camera.component';
import { CryptoService } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { Image, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';
import { PendingImage } from './bucket-one.page';

const MAX_IMAGES = 5;

/**
 * Bucket two (wallet spec 8.2): images (the camera in normal quality, or
 * files) and texts: phone, email, contact name, contact phone, plus free
 * extra lines. Add needs at least one image and the three texts; each text
 * is one info entry ("phone: ...", "email: ...", "contact: name, phone"). The
 * flow is bucket one's with securitybucket2 and /add-to-security-bucket-two.
 */
@Component({
  selector: 'app-bucket-two-page',
  imports: [FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, CameraComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Security bucket two</mat-card-title>
        <mat-card-subtitle>Things that prove you are who you say you are.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p>
          The minimum now: a good photo of your ID, your phone number, your email, and someone who can vouch for you by phone, like a
          spouse or someone who lives with you. You can add more later.
        </p>
        <h3>Images</h3>
        <app-camera quality="normal" (photo)="took($event)" />
        <div class="thumbs">
          @for (image of images(); track image.url) {
            <div class="thumb">
              <img [src]="image.url" alt="image" />
              <button mat-icon-button type="button" (click)="remove($index)" aria-label="Remove"><mat-icon>close</mat-icon></button>
            </div>
          }
        </div>
        <h3>Texts</h3>
        <div class="fields">
          <mat-form-field appearance="outline">
            <mat-label>Phone number</mat-label>
            <input matInput [ngModel]="phone()" (ngModelChange)="phone.set($event)" autocomplete="tel" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Email</mat-label>
            <input matInput [ngModel]="email()" (ngModelChange)="email.set($event)" autocomplete="email" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Contact name</mat-label>
            <input matInput [ngModel]="contactName()" (ngModelChange)="contactName.set($event)" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Contact phone</mat-label>
            <input matInput [ngModel]="contactPhone()" (ngModelChange)="contactPhone.set($event)" />
          </mat-form-field>
          <mat-form-field appearance="outline" class="wide">
            <mat-label>Anything else, one per line</mat-label>
            <textarea matInput rows="3" [ngModel]="extra()" (ngModelChange)="extra.set($event)"></textarea>
          </mat-form-field>
        </div>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          <p>{{ step() }}</p>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
      </mat-card-content>
      <mat-card-actions>
        <button mat-flat-button type="button" (click)="add()" [disabled]="busy() || !canAdd()">{{ failed() ? 'Retry' : 'Add' }}</button>
        @if (!canAdd()) {
          <span class="muted">At least one image, and the phone, email and contact.</span>
        }
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .thumb { position: relative; }
    .thumb img { width: 120px; height: 90px; object-fit: cover; border-radius: 8px; }
    .thumb button { position: absolute; top: -8px; right: -8px; background: var(--mat-sys-surface); }
    .fields { display: flex; flex-wrap: wrap; gap: 8px; max-width: 720px; }
    .fields mat-form-field { min-width: 260px; }
    .wide { width: 100%; }
    .muted { color: var(--mat-sys-on-surface-variant); margin-left: 8px; }
    .error { color: var(--mat-sys-error); }
  `,
})
export class BucketTwoPage {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly shares = inject(SharesService);
  private readonly router = inject(Router);

  protected readonly images = signal<PendingImage[]>([]);
  protected readonly phone = signal('');
  protected readonly email = signal('');
  protected readonly contactName = signal('');
  protected readonly contactPhone = signal('');
  protected readonly extra = signal('');
  protected readonly busy = signal(false);
  protected readonly step = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly failed = signal(false);

  protected readonly canAdd = computed(
    () => this.images().length > 0 && this.phone().trim() !== '' && this.email().trim() !== '' && this.contactName().trim() !== '' && this.contactPhone().trim() !== '',
  );

  protected took(photo: Photo): void {
    if (this.images().length >= MAX_IMAGES) return;
    this.images.update((list) => [...list, { photo, url: URL.createObjectURL(new Blob([photo.bytes as BlobPart], { type: photo.contentType })) }]);
  }

  protected remove(index: number): void {
    this.images.update((list) => {
      URL.revokeObjectURL(list[index].url);
      return list.filter((_, i) => i !== index);
    });
  }

  /** The texts as info entries: the three required ones, then the extra lines. */
  private texts(): string[] {
    const lines = [
      `phone: ${this.phone().trim()}`,
      `email: ${this.email().trim()}`,
      `contact: ${this.contactName().trim()}, ${this.contactPhone().trim()}`,
    ];
    for (const line of this.extra().split('\n')) {
      if (line.trim() !== '') lines.push(line.trim());
    }
    return lines;
  }

  protected async add(): Promise<void> {
    if (!this.canAdd()) return;
    const images = this.images();
    this.busy.set(true);
    this.error.set(null);
    this.failed.set(false);
    try {
      this.step.set('Encrypting under a fresh bucket key…');
      const key = this.crypto.newBucketKey();
      const encrypted: Image[] = [];
      for (const { photo } of images) {
        encrypted.push({ contentType: photo.contentType, image: await this.crypto.encryptToBase64(key, photo.bytes) });
      }
      const info: { info: string }[] = [];
      for (const text of this.texts()) info.push({ info: await this.crypto.encryptToBase64(key, this.crypto.utf8(text)) });
      this.step.set('Depositing the key with the keyholders…');
      const { keyId } = await this.shares.deposit(key, 'securitybucket2');
      this.step.set('Storing on the masterpod…');
      const res = await this.api.addToSecurityBucketTwo(keyId, encrypted, info);
      if (!res.ok) throw new Error(`/add-to-security-bucket-two: ${reasonOf(res)}`);
      key.fill(0);
      for (const image of images) URL.revokeObjectURL(image.url);
      this.images.set([]);
      this.phone.set('');
      this.email.set('');
      this.contactName.set('');
      this.contactPhone.set('');
      this.extra.set('');
      const status = await this.api.checkAnopodStatus();
      if (status.ok) this.session.status.set(status.body);
      await this.router.navigateByUrl(this.session.nextStep(status.ok ? status.body : undefined));
    } catch (err) {
      this.failed.set(true);
      this.error.set(err instanceof DepositError ? `${err.message}. Retry starts the step again with a fresh key.` : err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
      this.step.set('');
    }
  }
}
