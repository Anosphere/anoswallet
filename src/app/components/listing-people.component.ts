import { Component, computed, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { ChatService } from '../services/chat.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { InviteItem, ListingItem, MasterpodApiService, RoomItem, RoomMember } from '../services/masterpod-api.service';
import { MarketplaceService } from '../services/marketplace.service';
import { AvatarComponent } from './avatar.component';

/**
 * The owner's block of a listing (wallet spec 8.7), on the listing page
 * and Your listings: the people waiting (the invites to this pod about the
 * listing: avatar, "somchai wants to chat", Accept, which calls
 * /accept-invite and refreshes the rooms, and Decline), then the chats (the
 * rooms about it: avatar, username, Open chat to the conversation);
 * "Nobody has connected yet." when both are empty. The lists are live from
 * session.chatRooms. `changed` fires after an answer, so a page can read
 * its listing again.
 */
@Component({
  selector: 'app-listing-people',
  imports: [RouterLink, MatButtonModule, AvatarComponent],
  template: `
    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    @for (invite of invites(); track invite.inviteId) {
      <div class="item">
        <app-avatar [anopodId]="invite.from.anopodId" [username]="invite.from.username" />
        <span class="text"><strong>{{ invite.from.username }}</strong> wants to chat</span>
        <span class="actions">
          <button mat-flat-button type="button" (click)="accept(invite)" [disabled]="busy()">Accept</button>
          <button mat-button type="button" (click)="decline(invite)" [disabled]="busy()">Decline</button>
        </span>
      </div>
    }
    @for (room of rooms(); track room.chatRoomId) {
      <div class="item">
        <app-avatar [anopodId]="person(room).anopodId" [username]="person(room).username" />
        <span class="text"><strong>{{ person(room).username }}</strong></span>
        <a mat-stroked-button [routerLink]="['/chat', room.chatRoomId]">Open chat</a>
      </div>
    }
    @if (invites().length === 0 && rooms().length === 0) {
      <p class="muted">Nobody has connected yet.</p>
    }
  `,
  styles: `
    :host { display: block; }
    .item { display: flex; align-items: center; gap: 12px; padding: 8px 0; flex-wrap: wrap; }
    .text { flex: 1; min-width: 140px; }
    .actions { display: flex; gap: 4px; }
    .muted { color: var(--mat-sys-on-surface-variant); margin: 8px 0; }
    .error { color: var(--mat-sys-error); margin: 8px 0; }
  `,
})
export class ListingPeopleComponent {
  readonly listing = input.required<ListingItem>();
  /** Fires after an Accept or a Decline was answered and the rooms refreshed. */
  readonly changed = output<void>();

  private readonly market = inject(MarketplaceService);
  private readonly chat = inject(ChatService);
  private readonly api = inject(MasterpodApiService);

  protected readonly invites = computed(() => this.market.invitesAbout(this.listing().listingId));
  protected readonly rooms = computed(() => this.market.roomsAbout(this.listing().listingId));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The person who connected: the room's creator. */
  protected person(room: RoomItem): RoomMember {
    return room.members.find((m) => m.anopodId === room.creatorAnopodId) ?? { anopodId: room.creatorAnopodId, username: room.creatorAnopodId.slice(0, 8) };
  }

  protected accept(invite: InviteItem): Promise<void> {
    return this.run(() => this.api.acceptInvite(invite.inviteId));
  }

  protected decline(invite: InviteItem): Promise<void> {
    return this.run(() => this.api.declineInvite(invite.inviteId));
  }

  private async run(action: () => Promise<ApiResponse<unknown>>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await action();
      if (!res.ok) this.error.set(reasonOf(res));
      await this.chat.refreshRooms();
      this.changed.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
