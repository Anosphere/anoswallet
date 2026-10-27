import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { reasonOf } from '../services/log.service';
import { MasterpodApiService, VouchRequestItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** The seed page (wallet spec 8.2): /list-vouch-requests with selfies, approve and decline, for a seed or super seed. */
@Component({
  selector: 'app-seed-page',
  imports: [DatePipe, MatCardModule, MatButtonModule, MatListModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Vouch requests</mat-card-title>
        <mat-card-subtitle>People asking you to vouch for them. Approve only someone you know.</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (!session.isSeed()) {
          <p class="muted">This anoPod is not a seed, so nobody can ask it to vouch.</p>
        }
        @if (error(); as text) {
          <p class="error">{{ text }}</p>
        }
        <div class="requests">
          @for (r of requests(); track r.vouchIdNumber) {
            <mat-card appearance="outlined" class="request">
              <mat-card-content class="body">
                @if (r.from.selfie; as selfie) {
                  <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" alt="selfie" />
                }
                <div>
                  <div class="name">{{ r.from.firstName }} {{ r.from.lastName }} <code>{{ r.from.username }}</code></div>
                  <div class="muted">asked {{ r.createdAt | date: 'medium' }}</div>
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-flat-button type="button" (click)="approve(r.vouchIdNumber)" [disabled]="busy()">Approve</button>
                <button mat-button type="button" (click)="decline(r.vouchIdNumber)" [disabled]="busy()">Decline</button>
              </mat-card-actions>
            </mat-card>
          } @empty {
            <p class="muted">No open requests.</p>
          }
        </div>
      </mat-card-content>
      <mat-card-actions>
        <button mat-button type="button" (click)="load()" [disabled]="busy()">Refresh</button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .requests { display: flex; flex-wrap: wrap; gap: 12px; }
    .request { width: 320px; }
    .body { display: flex; gap: 12px; align-items: center; }
    .selfie { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; }
    .name { font-weight: 500; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class SeedPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  protected readonly requests = signal<VouchRequestItem[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.listVouchRequests();
      if (res.ok) this.requests.set(res.body.requests);
      else this.error.set(reasonOf(res));
    } finally {
      this.busy.set(false);
    }
  }

  protected async approve(vouchIdNumber: string): Promise<void> {
    await this.act(() => this.api.approveVouchRequest(vouchIdNumber));
  }

  protected async decline(vouchIdNumber: string): Promise<void> {
    await this.act(() => this.api.declineVouchRequest(vouchIdNumber));
  }

  private async act(call: () => Promise<{ ok: boolean; status: number; body: unknown }>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await call();
      if (!res.ok) this.error.set(reasonOf(res));
    } finally {
      this.busy.set(false);
    }
    await this.load();
  }
}
