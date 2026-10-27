import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { Router } from '@angular/router';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService, Profile } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** One vouch request sent this session. */
interface SentRequest {
  time: string;
  username: string;
  result: string;
}

/**
 * The vouching page (wallet spec 8.2): a username search showing the
 * profile card with the selfie and the seed flags, a Send request button,
 * the requests sent this session, and the status line (vouchCount, vouched)
 * the notification poll refreshes; when vouched, Continue to /identity.
 */
@Component({
  selector: 'app-vouching-page',
  imports: [FormsModule, MatCardModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatListModule, MatChipsModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Get vouched</mat-card-title>
        <mat-card-subtitle>Pick one or two or more to vouch for you. You'll have to check back after you've been vouched for.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p class="status">
          @if (session.vouched()) {
            You are vouched ({{ session.status()?.vouchCount }} {{ session.status()?.vouchCount === 1 ? 'vouch' : 'vouches' }}).
          } @else {
            Not vouched yet: {{ session.status()?.vouchCount ?? 0 }} of 2 vouches, or one by a super seed. This line refreshes every few seconds.
          }
        </p>
        @if (session.vouched()) {
          <button mat-flat-button type="button" (click)="continue()">Continue</button>
        }

        <h3>Find a seed</h3>
        <div class="row">
          <mat-form-field appearance="outline">
            <mat-label>Username</mat-label>
            <input matInput [ngModel]="searchName()" (ngModelChange)="searchName.set($event)" (keyup.enter)="search()" />
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="search()" [disabled]="busy() || !searchName().trim()">Search</button>
        </div>
        @if (searchError(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (found(); as profile) {
          <mat-card appearance="outlined" class="profile">
            <mat-card-content class="profile-body">
              @if (profile.selfie; as selfie) {
                <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" alt="selfie" />
              }
              <div>
                <div class="name">{{ profile.firstName }} {{ profile.lastName }} <code>{{ profile.username }}</code></div>
                <mat-chip-set>
                  @if (profile.isSuperSeed) { <mat-chip>super seed</mat-chip> }
                  @if (profile.isSeed) { <mat-chip>seed</mat-chip> }
                  @if (!foundCanVouch()) { <mat-chip>cannot vouch</mat-chip> }
                </mat-chip-set>
                @if (!foundCanVouch()) {
                  <p class="muted">{{ profile.username }} exists but is not a seed or super seed, so they cannot vouch for you.</p>
                }
              </div>
            </mat-card-content>
            <mat-card-actions>
              <button mat-flat-button type="button" (click)="sendRequest()" [disabled]="busy() || !foundCanVouch() || session.vouched()">Send request</button>
            </mat-card-actions>
          </mat-card>
        }

        <h3>Requests sent this session</h3>
        <mat-list>
          @for (r of sent(); track $index) {
            <mat-list-item>
              <span matListItemTitle>{{ r.username }}</span>
              <span matListItemLine>{{ r.time }} · {{ r.result }}</span>
            </mat-list-item>
          } @empty {
            <p class="muted">None yet.</p>
          }
        </mat-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .profile { max-width: 520px; margin-top: 8px; }
    .profile-body { display: flex; gap: 16px; align-items: flex-start; }
    .selfie { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; }
    .name { font-weight: 500; margin-bottom: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class VouchingPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly router = inject(Router);

  protected readonly searchName = signal('');
  protected readonly found = signal<Profile | null>(null);
  protected readonly searchError = signal<string | null>(null);
  protected readonly sent = signal<SentRequest[]>([]);
  protected readonly busy = signal(false);
  protected readonly foundCanVouch = computed(() => {
    const profile = this.found();
    return profile !== null && (profile.isSeed || profile.isSuperSeed);
  });

  protected async search(): Promise<void> {
    const username = this.searchName().trim().toLowerCase();
    if (!username) return;
    this.busy.set(true);
    this.searchError.set(null);
    try {
      const res = await this.api.searchUsernames(username);
      this.found.set(res.ok ? res.body : null);
      if (!res.ok) this.searchError.set(reasonOf(res));
    } finally {
      this.busy.set(false);
    }
  }

  protected async sendRequest(): Promise<void> {
    const target = this.found();
    if (!target) return;
    this.busy.set(true);
    try {
      const res = await this.api.sendVouchRequest(target.anopodId);
      this.sent.update((list) => [
        { time: new Date().toLocaleTimeString(), username: target.username, result: res.ok ? 'request sent' : reasonOf(res) },
        ...list,
      ]);
    } finally {
      this.busy.set(false);
    }
  }

  protected continue(): void {
    void this.router.navigateByUrl('/identity');
  }
}
