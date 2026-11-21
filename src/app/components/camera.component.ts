import { Component, ElementRef, OnDestroy, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { redrawImage, redrawSquare, squareJpeg } from '../images';
import { LanguageService } from '../services/language.service';

/** What the camera hands over: the image's type and bytes, for the caller to encrypt or send. */
export interface Photo {
  contentType: string;
  bytes: Uint8Array;
}

/** normal: 1280 by 720, JPEG 0.92 (a bucket two image); high: 1920 by 1080, JPEG 0.95 (bucket one); publicSelfie: the middle of the picture as a square of at most 320 by 320, JPEG 0.8 (the selfie of the Create page, 2026-11-21). */
export type CameraQuality = 'normal' | 'high' | 'publicSelfie';

/** user: the front camera (a selfie); environment: the back camera (an ID laid on a table). */
export type CameraFacing = 'user' | 'environment';

const SIZES: Record<CameraQuality, { width: number; height: number; jpeg: number; square?: number }> = {
  normal: { width: 1280, height: 720, jpeg: 0.92 },
  high: { width: 1920, height: 1080, jpeg: 0.95 },
  // The public selfie of the Create page (2026-11-21): the camera is asked for 1280 by 720 as for normal, and what is emitted is the middle of the picture as a square of at most `square` pixels a side, JPEG 0.8 (squareJpeg in ../images). Every place that shows a public selfie shows that middle square.
  publicSelfie: { width: 1280, height: 720, jpeg: 0.8, square: 320 },
};

/**
 * The camera component (wallet spec 8.4): the live camera when getUserMedia
 * is available (facingMode from `facing`, user or environment, the size from
 * the quality), Take photo, the frame drawn to a canvas and encoded as JPEG,
 * preview, Retake. Below it always a file input, accept image/*, capture set
 * to the same facing, so a phone offers that camera, as the fallback when the
 * camera is refused or absent. Every photo taken or file chosen is emitted as
 * `photo`; Retake emits `cleared`. A chosen file larger than the quality's
 * size is scaled down to it first (2026-11-08), so a phone's photo weighs
 * what a photo from the live camera weighs. Since 2026-11-12 every chosen
 * file is redrawn as a fresh JPEG (redrawImage in ../images), whatever its
 * size, so nothing but its pixels is sent; a file the browser cannot read
 * as a picture is refused with a line under the input and emits nothing.
 * Since 2026-11-21 the quality publicSelfie, for the selfie of the Create
 * page: the frame, or the chosen file, goes out as the middle of the
 * picture as a square of at most 320 by 320 (squareJpeg and redrawSquare
 * in ../images), the camera is shown as that square, and the photo taken
 * is shown at 160 pixels.
 */
@Component({
  selector: 'app-camera',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="camera">
      @if (preview(); as url) {
        <img class="frame" [class.square]="square()" [src]="url" [alt]="t().camera.yourPhoto" />
        <div class="row">
          <button mat-stroked-button type="button" (click)="retake()">{{ t().camera.retake }}</button>
        </div>
      } @else {
        @if (cameraError(); as text) {
          <p class="muted">{{ text }}</p>
        } @else {
          <video #video class="frame" [class.square]="square()" autoplay playsinline muted></video>
          <div class="row">
            <button mat-flat-button type="button" (click)="takePhoto()" [disabled]="!ready()">
              <mat-icon>photo_camera</mat-icon> {{ t().camera.takePhoto }}
            </button>
          </div>
        }
      }
      <label class="file">
        <span class="muted">{{ t().camera.orPick }}</span>
        <input type="file" accept="image/*" [attr.capture]="facing()" (change)="fileChosen($event)" />
      </label>
      @if (fileError(); as text) {
        <p class="error">{{ text }}</p>
      }
    </div>
  `,
  styles: `
    .camera { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
    .frame { max-width: 100%; width: 480px; aspect-ratio: 4 / 3; object-fit: cover; background: #000; border-radius: 8px; }
    /* The public selfie (2026-11-21): the camera shows the square that is kept, and the photo taken is shown at 160 pixels, the largest any page draws a selfie. */
    .frame.square { width: 320px; aspect-ratio: 1; }
    img.frame.square { width: 160px; }
    .row { display: flex; gap: 8px; }
    .file { display: flex; flex-direction: column; gap: 4px; }
    .muted { color: var(--mat-sys-on-surface-variant); font-size: 13px; margin: 0; }
    .error { color: var(--mat-sys-error); font-size: 13px; margin: 0; }
  `,
})
export class CameraComponent implements OnDestroy {
  readonly quality = input<CameraQuality>('normal');
  readonly facing = input<CameraFacing>('user');
  readonly photo = output<Photo>();
  readonly cleared = output<void>();

  /** True for the public selfie (2026-11-21): the camera and the photo taken are shown as a square. */
  protected readonly square = computed(() => SIZES[this.quality()].square !== undefined);
  protected readonly preview = signal<string | null>(null);
  protected readonly ready = signal(false);
  protected readonly cameraError = signal<string | null>(null);
  /** Set when a chosen file was refused: the browser could not read it as a picture (2026-11-12). Cleared by the next photo. */
  protected readonly fileError = signal<string | null>(null);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private stream: MediaStream | null = null;
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  constructor() {
    afterNextRender(() => void this.start());
  }

  ngOnDestroy(): void {
    this.stop();
    this.dropPreview();
  }

  /** Opens the camera; without one, or when refused, only the file input is left. */
  private async start(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cameraError.set(this.t().camera.noCamera);
      return;
    }
    const size = SIZES[this.quality()];
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing(), width: { ideal: size.width }, height: { ideal: size.height } },
        audio: false,
      });
    } catch (err) {
      this.cameraError.set(this.t().camera.couldNotOpen(err instanceof Error ? err.message : String(err)));
      return;
    }
    const video = this.video()?.nativeElement ?? this.host.nativeElement.querySelector('video');
    if (!video) return;
    video.srcObject = this.stream;
    video.onloadedmetadata = () => this.ready.set(true);
  }

  private stop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.ready.set(false);
  }

  /** The current frame as a JPEG; for the public selfie (2026-11-21) the middle of the frame as a square. */
  protected async takePhoto(): Promise<void> {
    const video = this.video()?.nativeElement ?? this.host.nativeElement.querySelector('video');
    if (!video || video.videoWidth === 0) return;
    const { jpeg, square } = SIZES[this.quality()];
    if (square) {
      // The public selfie (2026-11-21): the middle of the frame as a square, not the whole frame.
      const cut = await squareJpeg(video, video.videoWidth, video.videoHeight, square, jpeg);
      if (!cut) return;
      await this.emit(cut, 'image/jpeg');
      this.stop();
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', SIZES[this.quality()].jpeg));
    if (!blob) return;
    await this.emit(blob, 'image/jpeg');
    this.stop();
  }

  /** A file from the input: a phone's camera or a picked image, redrawn as a JPEG (2026-11-12) and scaled to the quality's size when it is larger, or for the public selfie (2026-11-21) cut to the middle square of at most 320 by 320; a file the browser cannot read as a picture is refused. */
  protected async fileChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const { width, jpeg, square } = SIZES[this.quality()];
    // The public selfie (2026-11-21) is the middle of the picked picture as a square.
    const redrawn = square ? await redrawSquare(file, square, jpeg) : await redrawImage(file, width, jpeg);
    if (!redrawn) {
      this.fileError.set(this.t().camera.unreadable);
      return;
    }
    await this.emit(redrawn, 'image/jpeg');
    this.stop();
  }

  protected retake(): void {
    this.dropPreview();
    this.cleared.emit();
    void this.start();
  }

  private async emit(blob: Blob, contentType: string): Promise<void> {
    this.fileError.set(null);
    this.dropPreview();
    this.preview.set(URL.createObjectURL(blob));
    this.photo.emit({ contentType, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }

  private dropPreview(): void {
    const url = this.preview();
    if (url) URL.revokeObjectURL(url);
    this.preview.set(null);
  }
}
