import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import { AvatarComponent } from '../components/avatar.component';
import { ChatService } from '../services/chat.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { InviteItem, JoinRequestItem, MasterpodApiService } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * The chat requests (wallet spec 8.2, Chat), at /chat/requests inside the
 * chat page's pane: the invites to this pod with Accept and Decline, and the
 * join requests on the rooms it created with Approve and Decline, each with
 * the person's avatar. Accept opens the room; Approve wraps the room key to
 * the requester. The lists come from session.chatRooms, refreshed after
 * every answer.
 */
@Component({
  selector: 'app-chat-requests-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, AvatarComponent],
  template: `
    <header class="head">
      <a mat-icon-button class="back" routerLink="/chat" aria-label="Back to chats"><mat-icon>arrow_back</mat-icon></a>
      <h2>Requests</h2>
    </header>
    <div class="body">
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      }
      @if (invites().length === 0 && joinRequests().length === 0) {
        <p class="muted">No requests.</p>
      } @else {
        <h3>Invites to you</h3>
        @for (invite of invites(); track invite.inviteId) {
          <div class="item">
            <app-avatar [anopodId]="invite.from.anopodId" [username]="invite.from.username" />
            <span class="text"><strong>{{ invite.from.username }}</strong> {{ inviteText(invite) }}</span>
            <span class="actions">
              <button mat-flat-button type="button" (click)="accept(invite)" [disabled]="busy()">Accept</button>
              <button mat-button type="button" (click)="decline(invite)" [disabled]="busy()">Decline</button>
            </span>
          </div>
        } @empty {
          <p class="muted">None.</p>
        }
        <h3>Join requests on your rooms</h3>
        @for (request of joinRequests(); track request.joinRequestId) {
          <div class="item">
            <app-avatar [anopodId]="request.from.anopodId" [username]="request.from.username" />
            <span class="text"><strong>{{ request.from.username }}</strong> asks to join {{ roomTitle(request.chatRoomId) }}</span>
            <span class="actions">
              <button mat-flat-button type="button" (click)="approve(request)" [disabled]="busy()">Approve</button>
              <button mat-button type="button" (click)="declineJoin(request)" [disabled]="busy()">Decline</button>
            </span>
          </div>
        } @empty {
          <p class="muted">None.</p>
        }
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .head h2 { font-size: 1.1rem; font-weight: 500; margin: 0; }
    .back { display: none; }
    .body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
    h3 { font-size: 0.95rem; font-weight: 500; margin: 12px 0 8px; }
    .item { display: flex; align-items: center; gap: 12px; padding: 8px 0; flex-wrap: wrap; }
    .text { flex: 1; min-width: 160px; }
    .actions { display: flex; gap: 4px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .back { display: inline-flex; }
    }
  `,
})
export class ChatRequestsPage {
  protected readonly session = inject(SessionService);
  protected readonly chat = inject(ChatService);
  private readonly api = inject(MasterpodApiService);
  private readonly router = inject(Router);

  protected readonly invites = computed(() => this.session.chatRooms()?.invites ?? []);
  protected readonly joinRequests = computed(() => this.session.chatRooms()?.joinRequests ?? []);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** An invite about a listing reads "wants to chat about your listing Selling 100 anos for THB" (2026-11-06); the others as before. */
  protected inviteText(invite: InviteItem): string {
    if (invite.listing) return `wants to chat about your listing ${this.chat.listingWords(invite.listing)}`;
    return invite.type === 'public' ? `invited you to "${invite.name}"` : 'invited you to a private chat';
  }

  protected roomTitle(chatRoomId: string): string {
    const room = this.session.chatRooms()?.rooms.find((r) => r.chatRoomId === chatRoomId);
    return room ? this.chat.title(room) : 'your room';
  }

  protected accept(invite: InviteItem): Promise<void> {
    return this.run(async () => {
      const res = await this.api.acceptInvite(invite.inviteId);
      await this.chat.refreshRooms();
      if (res.ok) await this.router.navigate(['/chat', res.body.chatRoomId]);
      return res;
    });
  }

  protected decline(invite: InviteItem): Promise<void> {
    return this.run(async () => {
      const res = await this.api.declineInvite(invite.inviteId);
      await this.chat.refreshRooms();
      return res;
    });
  }

  /** The room's key wrapped to the requester's chat keys goes with the approval. */
  protected approve(request: JoinRequestItem): Promise<void> {
    return this.run(async () => {
      const hpkeKey = await this.chat.wrapFor(request.chatRoomId, request.from.anopodId);
      const res = await this.api.approveJoin(request.joinRequestId, hpkeKey);
      await this.chat.refreshRooms();
      return res;
    });
  }

  protected declineJoin(request: JoinRequestItem): Promise<void> {
    return this.run(async () => {
      const res = await this.api.declineJoin(request.joinRequestId);
      await this.chat.refreshRooms();
      return res;
    });
  }

  private async run(action: () => Promise<ApiResponse<unknown>>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await action();
      if (!res.ok) this.error.set(reasonOf(res));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
