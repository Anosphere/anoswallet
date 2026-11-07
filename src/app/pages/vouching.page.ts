import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { Router } from '@angular/router';
import { LanguageService } from '../services/language.service';
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
 * The vouching page (wallet spec 8.2). Until vouched: the status line
 * (vouchCount) the notification poll refreshes, the instructions (how
 * vouching works, what to do, while you wait), a username search showing
 * the profile card with the selfie and the seed flags, a Send request
 * button, and the requests sent this session. Once vouched, only a big
 * "You've been vouched", the count and a big Continue to /identity.
 */
@Component({
  selector: 'app-vouching-page',
  imports: [FormsModule, MatCardModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatListModule, MatChipsModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().vouching.title }}</mat-card-title>
        @if (!session.vouched()) {
          <mat-card-subtitle>{{ t().vouching.subtitle }}</mat-card-subtitle>
        }
      </mat-card-header>
      <mat-card-content>
        @if (session.vouched()) {
          <div class="vouched">
            <h2 class="headline">{{ t().vouching.vouchedHeadline }}</h2>
            <p class="lead">{{ t().vouching.vouchedBy(vouchCount()) }}</p>
            <button mat-flat-button type="button" class="big" (click)="continue()">{{ t().common.continue }}</button>
          </div>
        } @else {
          <p class="status">{{ t().vouching.notYet(vouchCount()) }}</p>

          <section class="how">
            <h3>{{ t().vouching.howTitle }}</h3>
            <p>{{ t().vouching.how1 }}</p>
            <p>{{ t().vouching.how2 }}</p>
            <h3>{{ t().vouching.whatTitle }}</h3>
            <ol>
              <li>{{ t().vouching.what1 }}</li>
              <li>{{ t().vouching.what2 }}</li>
              <li>{{ t().vouching.what3 }}</li>
              <li>{{ t().vouching.what4 }}</li>
            </ol>
            <h3>{{ t().vouching.waitTitle }}</h3>
            <p>{{ t().vouching.wait }}</p>
          </section>

          <h3>{{ t().vouching.findTitle }}</h3>
          <div class="row">
            <mat-form-field appearance="outline">
              <mat-label>{{ t().common.username }}</mat-label>
              <input matInput [ngModel]="searchName()" (ngModelChange)="searchName.set($event)" (keyup.enter)="search()" />
            </mat-form-field>
            <button mat-stroked-button type="button" (click)="search()" [disabled]="busy() || !searchName().trim()">{{ t().common.search }}</button>
          </div>
          @if (searchError(); as text) {
            <p class="error">{{ text }}</p>
          }
          @if (found(); as profile) {
            <mat-card appearance="outlined" class="profile">
              <mat-card-content class="profile-body">
                @if (profile.selfie; as selfie) {
                  <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" [alt]="t().common.selfie" />
                }
                <div>
                  <div class="name">{{ profile.firstName }} {{ profile.lastName }} <code>{{ profile.username }}</code></div>
                  <mat-chip-set>
                    @if (profile.isSuperSeed) { <mat-chip>{{ t().vouching.superSeed }}</mat-chip> }
                    @if (profile.isSeed) { <mat-chip>{{ t().vouching.seed }}</mat-chip> }
                    @if (!foundCanVouch()) { <mat-chip>{{ t().vouching.cannotVouch }}</mat-chip> }
                  </mat-chip-set>
                  @if (!foundCanVouch()) {
                    <p class="muted">{{ t().vouching.notSeed(profile.username) }}</p>
                  }
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-flat-button type="button" (click)="sendRequest()" [disabled]="busy() || !foundCanVouch() || session.vouched()">{{ t().vouching.sendRequest }}</button>
              </mat-card-actions>
            </mat-card>
          }

          <h3>{{ t().vouching.sentTitle }}</h3>
          <mat-list>
            @for (r of sent(); track $index) {
              <mat-list-item>
                <span matListItemTitle>{{ r.username }}</span>
                <span matListItemLine>{{ r.time }} · {{ r.result }}</span>
              </mat-list-item>
            } @empty {
              <p class="muted">{{ t().common.noneYet }}</p>
            }
          </mat-list>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .vouched { text-align: center; padding: 24px 0; }
    .headline { font-size: 2rem; font-weight: 500; margin: 0 0 8px; }
    .lead { font-size: 1.125rem; margin: 0 0 24px; }
    .big { height: 52px; font-size: 1.125rem; padding: 0 40px; }
    .how ol { padding-left: 20px; }
    .how li { margin-bottom: 4px; }
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
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly searchName = signal('');
  protected readonly found = signal<Profile | null>(null);
  protected readonly searchError = signal<string | null>(null);
  protected readonly sent = signal<SentRequest[]>([]);
  protected readonly busy = signal(false);
  protected readonly vouchCount = computed(() => this.session.status()?.vouchCount ?? 0);
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
        { time: new Date().toLocaleTimeString(this.lang.tag()), username: target.username, result: res.ok ? this.t().vouching.requestSent : reasonOf(res) },
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
