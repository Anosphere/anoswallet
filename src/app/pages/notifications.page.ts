import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** The five case kinds of masterpod 13.7: their reference id is a case id, and the label links to the person's case page (wallet spec 13.4). */
const CASE_KINDS = ['tradeCaseOpened', 'disputeCaseOpened', 'caseScheduled', 'caseDecided', 'caseDismissed'];

/** The notifications page (wallet spec 8.2): the list, newest first, mark read; the five case kinds link to /cases/:caseId (13.4), the chat kinds to the chat requests or the room (8.2, Chat). The shell's poll keeps it fresh. */
@Component({
  selector: 'app-notifications-page',
  imports: [RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().notifications.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().notifications.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <mat-list>
          @for (n of session.notifications(); track n.notificationNumber) {
            <mat-list-item>
              <mat-icon matListItemIcon>{{ n.read ? 'drafts' : 'mark_email_unread' }}</mat-icon>
              @if (linkOf(n.kind, n.referenceId); as link) {
                <a matListItemTitle [routerLink]="link">{{ label(n.kind) }}</a>
              } @else {
                <span matListItemTitle>{{ label(n.kind) }}</span>
              }
              <span matListItemLine>{{ lang.dateTime(n.createdAt) }} · <code>{{ n.referenceId.slice(0, 16) }}…</code></span>
            </mat-list-item>
          } @empty {
            <p class="muted">{{ t().notifications.none }}</p>
          }
        </mat-list>
      </mat-card-content>
      <mat-card-actions>
        <button mat-flat-button type="button" (click)="markRead()" [disabled]="busy() || session.unread().length === 0">
          {{ t().notifications.markRead(session.unread().length) }}
        </button>
        <button mat-button type="button" (click)="refresh()" [disabled]="busy()">{{ t().common.refresh }}</button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `.muted { color: var(--mat-sys-on-surface-variant); }`,
})
export class NotificationsPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  protected readonly busy = signal(false);

  constructor() {
    void this.refresh();
  }

  /** Where the label leads: a case kind to the case; chatInvite and joinRequest to the chat requests; inviteAccepted, inviteDeclined and joinApproved to the room, the reference being its id; null for the rest. */
  protected linkOf(kind: string, referenceId: string): string[] | null {
    if (CASE_KINDS.includes(kind)) return ['/cases', referenceId];
    if (kind === 'chatInvite' || kind === 'joinRequest') return ['/chat/requests'];
    if (kind === 'inviteAccepted' || kind === 'inviteDeclined' || kind === 'joinApproved') return ['/chat', referenceId];
    return null;
  }

  /** The kinds of the masterpod spec section 6 and the five case kinds of 13.7, in words, from the dictionary; a kind it does not know shows as it is. */
  protected label(kind: string): string {
    return this.t().notifications.labels[kind] ?? kind;
  }

  protected async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.api.listNotifications(false, true);
      if (res.ok) this.session.notifications.set(res.body.notifications);
    } finally {
      this.busy.set(false);
    }
  }

  protected async markRead(): Promise<void> {
    const numbers = this.session.unread().map((n) => n.notificationNumber);
    if (numbers.length === 0) return;
    this.busy.set(true);
    try {
      await this.api.markNotificationsRead(numbers);
      const res = await this.api.listNotifications(false, true);
      if (res.ok) this.session.notifications.set(res.body.notifications);
    } finally {
      this.busy.set(false);
    }
  }
}
