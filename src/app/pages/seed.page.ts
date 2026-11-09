import { Component, DestroyRef, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AvatarComponent } from '../components/avatar.component';
import { VOUCH_REQUESTS_POLL_MS } from '../constants';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, VouchRequestItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * The seed page (wallet spec 8.2): the open vouch requests from
 * /list-vouch-requests, one card each with the requester's avatar (the
 * picture comes through the profile cache, a few at a time), Approve and
 * Decline on their own card, and a quiet 5-second poll for new requests;
 * for a seed or super seed.
 */
@Component({
  selector: 'app-seed-page',
  imports: [MatCardModule, MatButtonModule, MatListModule, MatProgressSpinnerModule, AvatarComponent],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().seed.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().seed.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (!session.isSeed()) {
          <p class="muted">{{ t().seed.notSeed }}</p>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (fetching()) {
          <p class="muted fetching"><mat-spinner [diameter]="24" /> {{ t().seed.fetching }}</p>
        } @else {
          <div class="requests">
            @for (r of requests(); track r.vouchIdNumber) {
              <mat-card appearance="outlined" class="request">
                <mat-card-content class="body">
                  <app-avatar [anopodId]="r.from.anopodId" [username]="r.from.username" [size]="72" />
                  <div>
                    <div class="name">{{ r.from.firstName }} {{ r.from.lastName }} <code>{{ r.from.username }}</code></div>
                    <div class="muted">{{ t().seed.asked(lang.dateTime(r.createdAt)) }}</div>
                  </div>
                </mat-card-content>
                <mat-card-actions>
                  <button mat-flat-button type="button" (click)="approve(r.vouchIdNumber)" [disabled]="acting().has(r.vouchIdNumber)">{{ t().common.approve }}</button>
                  <button mat-button type="button" (click)="decline(r.vouchIdNumber)" [disabled]="acting().has(r.vouchIdNumber)">{{ t().common.decline }}</button>
                </mat-card-actions>
                @if (cardErrors().get(r.vouchIdNumber); as text) {
                  <p class="error card-error">{{ text }}</p>
                }
              </mat-card>
            } @empty {
              <p class="muted">{{ t().seed.none }}</p>
            }
          </div>
        }
      </mat-card-content>
      <mat-card-actions>
        <button mat-button type="button" (click)="load()" [disabled]="listing()">{{ t().common.refresh }}</button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .requests { display: flex; flex-wrap: wrap; gap: 12px; }
    .request { width: 320px; }
    .body { display: flex; gap: 12px; align-items: center; }
    .fetching { display: flex; align-items: center; gap: 12px; }
    .card-error { margin: 0 16px 12px; }
    .name { font-weight: 500; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class SeedPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  /** The open requests as the masterpod orders them, minus the ones handled on this page. */
  protected readonly requests = signal<VouchRequestItem[]>([]);
  /** True until the first list answer, then false for good: the poll is silent. */
  protected readonly fetching = signal(true);
  /** The vouchIdNumbers with an Approve or Decline in flight; only their own two buttons are disabled. */
  protected readonly acting = signal<ReadonlySet<string>>(new Set());
  /** vouchIdNumber to the reason of its last refusal, printed on its card. */
  protected readonly cardErrors = signal<ReadonlyMap<string, string>>(new Map());
  /** The page-level reason when a list read that is not quiet fails. */
  protected readonly error = signal<string | null>(null);
  /** A list read is in flight: the poll skips its tick and Refresh is disabled. */
  protected readonly listing = signal(false);
  /** The vouchIdNumbers approved, declined or found gone here since the page opened: a poll's answer never brings them back. */
  private readonly handled = new Set<string>();

  constructor() {
    void this.load();
    const timer = setInterval(() => {
      if (!this.listing()) void this.load(true);
    }, VOUCH_REQUESTS_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** The list from /list-vouch-requests. Quiet for the poll, which changes nothing on screen when it fails. */
  protected async load(quiet = false): Promise<void> {
    this.listing.set(true);
    try {
      const res = await this.api.listVouchRequests(quiet);
      if (res.ok) {
        this.requests.set(res.body.requests.filter((r) => !this.handled.has(r.vouchIdNumber)));
        this.error.set(null);
      } else if (!quiet) {
        this.error.set(reasonOf(res));
      }
    } finally {
      this.fetching.set(false);
      this.listing.set(false);
    }
  }

  protected async approve(vouchIdNumber: string): Promise<void> {
    await this.act(vouchIdNumber, () => this.api.approveVouchRequest(vouchIdNumber));
  }

  protected async decline(vouchIdNumber: string): Promise<void> {
    await this.act(vouchIdNumber, () => this.api.declineVouchRequest(vouchIdNumber));
  }

  /**
   * One card's Approve or Decline. On ok, or on a 404 (the request was
   * handled from another device), the card goes; any other refusal stays
   * on the card as its reason. Nothing is fetched again.
   */
  private async act(vouchIdNumber: string, call: () => Promise<ApiResponse<unknown>>): Promise<void> {
    this.acting.update((set) => new Set(set).add(vouchIdNumber));
    this.cardErrors.update((map) => {
      const next = new Map(map);
      next.delete(vouchIdNumber);
      return next;
    });
    try {
      const res = await call();
      if (res.ok || res.status === 404) this.remove(vouchIdNumber);
      else this.cardErrors.update((map) => new Map(map).set(vouchIdNumber, reasonOf(res)));
    } finally {
      this.acting.update((set) => {
        const next = new Set(set);
        next.delete(vouchIdNumber);
        return next;
      });
    }
  }

  private remove(vouchIdNumber: string): void {
    this.handled.add(vouchIdNumber);
    this.requests.update((list) => list.filter((r) => r.vouchIdNumber !== vouchIdNumber));
  }
}
