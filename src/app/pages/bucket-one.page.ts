import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { CameraComponent, Photo } from '../components/camera.component';
import { CryptoService } from '../services/crypto.service';
import { reasonOf } from '../services/log.service';
import { Image, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { DepositError, SharesService } from '../services/shares.service';

/** An image waiting to be added, with its preview. */
export interface PendingImage {
  photo: Photo;
  url: string;
}

const MAX_IMAGES = 5;

/**
 * Bucket one (wallet spec 8.2): "Add a high quality selfie." The camera in
 * high quality, up to five images, preview and remove. Add: a fresh bucket
 * key and keyId; each image encrypted under the key; the deposits
 * (securitybucket1); then /add-to-security-bucket-one with keyId and the
 * images; on 201 the key is dropped and the next-step rule runs.
 */
@Component({
  selector: 'app-bucket-one-page',
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatProgressBarModule, CameraComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Security bucket one</mat-card-title>
        <mat-card-subtitle>Add a high quality selfie.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p>
          These images are encrypted in this tab under a key only the keyholders can rebuild, and kept for a recovery. Up to five;
          one good selfie is enough to start.
        </p>
        <app-camera quality="high" (photo)="took($event)" />
        <div class="thumbs">
          @for (image of images(); track image.url) {
            <div class="thumb">
              <img [src]="image.url" alt="selfie" />
              <button mat-icon-button type="button" (click)="remove($index)" aria-label="Remove"><mat-icon>close</mat-icon></button>
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
      </mat-card-content>
      <mat-card-actions>
        <button mat-flat-button type="button" (click)="add()" [disabled]="busy() || images().length === 0">
          {{ failed() ? 'Retry' : 'Add' }} ({{ images().length }} of {{ max }})
        </button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .thumb { position: relative; }
    .thumb img { width: 120px; height: 90px; object-fit: cover; border-radius: 8px; }
    .thumb button { position: absolute; top: -8px; right: -8px; background: var(--mat-sys-surface); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class BucketOnePage {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly shares = inject(SharesService);
  private readonly router = inject(Router);

  protected readonly max = MAX_IMAGES;
  protected readonly images = signal<PendingImage[]>([]);
  protected readonly busy = signal(false);
  protected readonly step = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly failed = signal(false);

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

  protected async add(): Promise<void> {
    const images = this.images();
    if (images.length === 0) return;
    this.busy.set(true);
    this.error.set(null);
    this.failed.set(false);
    try {
      this.step.set('Encrypting the images under a fresh bucket key…');
      const key = this.crypto.newBucketKey();
      const encrypted: Image[] = [];
      for (const { photo } of images) {
        encrypted.push({ contentType: photo.contentType, image: await this.crypto.encryptToBase64(key, photo.bytes) });
      }
      this.step.set('Depositing the key with the keyholders…');
      const { keyId } = await this.shares.deposit(key, 'securitybucket1');
      this.step.set('Storing the images on the masterpod…');
      const res = await this.api.addToSecurityBucketOne(keyId, encrypted);
      if (!res.ok) throw new Error(`/add-to-security-bucket-one: ${reasonOf(res)}`);
      key.fill(0);
      for (const image of images) URL.revokeObjectURL(image.url);
      this.images.set([]);
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
