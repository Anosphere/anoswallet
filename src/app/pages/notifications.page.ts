import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** The five case kinds of masterpod 13.7: their reference id is a case id, and the label links to the person's case page (wallet spec 13.4). */
const CASE_KINDS = ['tradeCaseOpened', 'disputeCaseOpened', 'caseScheduled', 'caseDecided', 'caseDismissed'];

/** The notifications page (wallet spec 8.2): the list, newest first, mark read; the five case kinds link to /cases/:caseId (13.4), the chat kinds to the chat requests or the room (8.2, Chat). The shell's poll keeps it fresh. */
@Component({
  selector: 'app-notifications-page',
  imports: [DatePipe, RouterLink, MatCardModule, MatButtonModule, MatListModule, MatIconModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Notifications</mat-card-title>
        <mat-card-subtitle>Newest first; refreshed every 5 seconds</mat-card-subtitle>
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
              <span matListItemLine>{{ n.createdAt | date: 'medium' }} · <code>{{ n.referenceId.slice(0, 16) }}…</code></span>
            </mat-list-item>
          } @empty {
            <p class="muted">No notifications yet.</p>
          }
        </mat-list>
      </mat-card-content>
      <mat-card-actions>
        <button mat-flat-button type="button" (click)="markRead()" [disabled]="busy() || session.unread().length === 0">
          Mark {{ session.unread().length }} read
        </button>
        <button mat-button type="button" (click)="refresh()" [disabled]="busy()">Refresh</button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `.muted { color: var(--mat-sys-on-surface-variant); }`,
})
export class NotificationsPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
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

  /** The kinds of the masterpod spec section 6 and the five case kinds of 13.7, in words. */
  protected label(kind: string): string {
    const labels: Record<string, string> = {
      vouchRequest: 'Someone asked you to vouch for them',
      vouchApproved: 'A seed vouched for you',
      vouchDeclined: 'A seed declined to vouch for you',
      vouched: 'You are vouched',
      chatInvite: 'You were invited to a chat room',
      inviteAccepted: 'Your invite was accepted',
      inviteDeclined: 'Your invite was declined',
      joinRequest: 'Someone asked to join your room',
      joinApproved: 'Your join request was approved',
      joinDeclined: 'Your join request was declined',
      tradeCaseOpened: 'An attestor opened a case on your trade: share your lookup id',
      disputeCaseOpened: 'Attestors opened a case on your escrow dispute: upload your evidence',
      caseScheduled: 'A video call was scheduled for your case',
      caseDecided: 'Your case was decided',
      caseDismissed: 'Your case was dismissed',
    };
    return labels[kind] ?? kind;
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
