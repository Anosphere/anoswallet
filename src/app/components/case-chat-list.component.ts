import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { ChatService } from '../services/chat.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { InviteItem, MasterpodApiService, RoomItem, RoomMember } from '../services/masterpod-api.service';
import { AvatarComponent } from './avatar.component';

/**
 * The person's chats with the attestors of a case (wallet spec 8.7 and
 * 13.3), on My case, in the shape of the listing's people: the attestors
 * waiting (the invites to this pod into a room about the case: avatar,
 * "attestorjoy is an attestor on this case and wants to chat with you",
 * Accept, which calls /accept-invite, refreshes the rooms and opens the
 * conversation, and Decline), then the chats (the rooms about the case:
 * the avatar and username of the room's creator, who is the attestor, and
 * Open chat to the conversation); "No attestor has started a chat with you
 * about this case yet." when both are empty. The lists are live from
 * session.chatRooms.
 */
@Component({
  selector: 'app-case-chat-list',
  imports: [RouterLink, MatButtonModule, AvatarComponent],
  template: `
    @if (error(); as text) {
      <p class="error">{{ text }}</p>
    }
    @for (invite of invites(); track invite.inviteId) {
      <div class="item">
        <app-avatar [anopodId]="invite.from.anopodId" [username]="invite.from.username" />
        <span class="text"><strong>{{ invite.from.username }}</strong> {{ t().caseChat.wants }}</span>
        <span class="actions">
          <button mat-flat-button type="button" (click)="accept(invite)" [disabled]="busy()">{{ t().common.accept }}</button>
          <button mat-button type="button" (click)="decline(invite)" [disabled]="busy()">{{ t().common.decline }}</button>
        </span>
      </div>
    }
    @for (room of rooms(); track room.chatRoomId) {
      <div class="item">
        <app-avatar [anopodId]="attestor(room).anopodId" [username]="attestor(room).username" />
        <span class="text"><strong>{{ attestor(room).username }}</strong></span>
        <a mat-stroked-button [routerLink]="['/chat', room.chatRoomId]">{{ t().common.openChat }}</a>
      </div>
    }
    @if (invites().length === 0 && rooms().length === 0) {
      <p class="muted">{{ t().caseChat.none }}</p>
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
export class CaseChatListComponent {
  /** The case the chats are about. */
  readonly caseId = input.required<string>();

  private readonly chat = inject(ChatService);
  private readonly api = inject(MasterpodApiService);
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly invites = computed(() => this.chat.caseInvitesOf(this.caseId()));
  protected readonly rooms = computed(() => this.chat.caseRoomsOf(this.caseId()));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The attestor of a chat about the case: the room's creator. */
  protected attestor(room: RoomItem): RoomMember {
    return room.members.find((m) => m.anopodId === room.creatorAnopodId) ?? { anopodId: room.creatorAnopodId, username: room.creatorAnopodId.slice(0, 8) };
  }

  /** /accept-invite, the rooms refreshed, and the conversation opens. */
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
