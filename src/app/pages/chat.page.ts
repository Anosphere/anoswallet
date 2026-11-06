import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AvatarComponent } from '../components/avatar.component';
import { ChatService } from '../services/chat.service';
import { reasonOf } from '../services/log.service';
import { RoomItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * Chat (wallet spec 8.2): the list of chats, and beside it on a desktop the
 * pane for the child route (a conversation, the requests, a new chat); on a
 * phone one or the other, the pane while a child route is open. The rows:
 * the other person's avatar or the kind's icon, the title, the newest
 * message decrypted as a one-line preview, the time; newest activity first;
 * a Requests row on top while invites or join requests wait; a pencil to
 * /chat/new. An unread room (session.unreadRooms) has a dot under its
 * time and a bold title. The rooms are session.chatRooms, which the shell's poll
 * refreshes every 5 seconds; the page refreshes them once when it opens.
 */
@Component({
  selector: 'app-chat-page',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule, MatIconModule, AvatarComponent],
  template: `
    <div class="chat" [class.child-open]="childOpen()">
      <section class="list">
        <header class="list-head">
          <h1>Chats</h1>
          <a mat-icon-button class="pencil" routerLink="/chat/new" aria-label="New chat"><mat-icon>edit</mat-icon></a>
        </header>
        @if (!session.hasChatKeys()) {
          <p class="error note">No chat keys in this tab: unlock again.</p>
        }
        @if (error(); as text) {
          <p class="error note">{{ text }}</p>
        }
        <div class="rows">
          @if (requestCount() > 0) {
            <a class="row" routerLink="/chat/requests" routerLinkActive="open">
              <span class="disc"><mat-icon>person_add</mat-icon></span>
              <span class="texts">
                <span class="title">Requests</span>
                <span class="line">{{ requestLine() }}</span>
              </span>
            </a>
          }
          @for (room of rooms(); track room.chatRoomId) {
            <a class="row" [routerLink]="['/chat', room.chatRoomId]" routerLinkActive="open" [class.unread]="unreadIds().has(room.chatRoomId)">
              @if (chat.otherPerson(room); as other) {
                <app-avatar [anopodId]="other.anopodId" [username]="other.username" [size]="48" />
              } @else {
                <span class="disc"><mat-icon>{{ chat.icon(room) }}</mat-icon></span>
              }
              <span class="texts">
                <span class="title">{{ chat.title(room) }}</span>
                <span class="line">{{ preview(room) }}</span>
              </span>
              <span class="meta">
                <span class="when">{{ chat.shortWhen(chat.activityAt(room)) }}</span>
                @if (unreadIds().has(room.chatRoomId)) {
                  <span class="dot"></span>
                }
              </span>
            </a>
          } @empty {
            @if (session.chatRooms() === null) {
              <p class="muted note">Loading your chats.</p>
            } @else {
              <p class="muted note">No chats yet. Tap the pencil to start one.</p>
            }
          }
        </div>
        <a mat-fab class="fab" routerLink="/chat/new" aria-label="New chat"><mat-icon>edit</mat-icon></a>
      </section>
      <section class="pane">
        @if (!childOpen()) {
          <p class="muted placeholder">Pick a chat, or start a new one.</p>
        }
        <router-outlet />
      </section>
    </div>
  `,
  styles: `
    :host { display: block; height: calc(100dvh - 64px - 32px); }
    .chat { display: flex; height: 100%; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; overflow: hidden; background: var(--mat-sys-surface); }
    .list { width: 360px; flex: none; display: flex; flex-direction: column; min-height: 0; position: relative; border-right: 1px solid var(--mat-sys-outline-variant); }
    .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .list-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    h1 { font-size: 1.25rem; font-weight: 500; margin: 0; }
    .rows { flex: 1; min-height: 0; overflow: auto; }
    .row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; color: inherit; text-decoration: none; }
    .row:hover { background: var(--mat-sys-surface-container); }
    .row.open { background: var(--mat-sys-secondary-container); }
    .disc { width: 48px; height: 48px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface-variant); flex: none; }
    .texts { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .line { font-size: 13px; color: var(--mat-sys-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: none; align-self: flex-start; margin-top: 4px; }
    .when { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--mat-sys-primary); }
    .row.unread .title { font-weight: 700; }
    .row.unread .line { color: var(--mat-sys-on-surface); }
    .fab { display: none; position: absolute; right: 16px; bottom: 16px; }
    .placeholder { margin: auto; }
    .note { padding: 8px 16px; margin: 0; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .list { width: 100%; border-right: none; }
      .pane { display: none; }
      .chat.child-open .list { display: none; }
      .chat.child-open .pane { display: flex; }
      .pencil { display: none; }
      .fab { display: inline-flex; }
    }
    @media (max-width: 599px) {
      :host { height: calc(100dvh - 56px - 32px); }
    }
  `,
})
export class ChatPage {
  protected readonly session = inject(SessionService);
  protected readonly chat = inject(ChatService);
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** True while a child route (a conversation, the requests, a new chat) is open. */
  protected readonly childOpen = computed(() => this.url().startsWith('/chat/'));

  protected readonly rooms = computed(() => this.chat.sorted(this.session.chatRooms()?.rooms ?? []));
  protected readonly unreadIds = computed(() => new Set(this.session.unreadRooms().map((r) => r.chatRoomId)));
  protected readonly requestCount = computed(() => {
    const answer = this.session.chatRooms();
    return answer ? answer.invites.length + answer.joinRequests.length : 0;
  });
  protected readonly requestLine = computed(() => {
    const answer = this.session.chatRooms();
    return answer ? `${count(answer.invites.length, 'invite')}, ${count(answer.joinRequests.length, 'join request')}` : '';
  });
  protected readonly error = signal<string | null>(null);
  /** The newest message of each room, decrypted, by message id. */
  private readonly previews = signal(new Map<string, string>());

  constructor() {
    void this.chat.refreshRooms().then((res) => {
      if (!res.ok) this.error.set(`/list-chat-rooms: ${reasonOf(res)}`);
    });
    effect(() => {
      const rooms = this.session.chatRooms()?.rooms ?? [];
      untracked(() => void this.decryptPreviews(rooms));
    });
  }

  /** The one-line preview: "You: " before this pod's own message; the two texts for a room without messages or a message that will not open. */
  protected preview(room: RoomItem): string {
    const last = room.lastMessage;
    if (!last) return 'No messages yet';
    const text = this.previews().get(last.messageId);
    if (text === undefined) return '';
    return (last.senderAnopodId === this.session.anopodId() ? 'You: ' : '') + text;
  }

  private async decryptPreviews(rooms: RoomItem[]): Promise<void> {
    const have = this.previews();
    const todo = rooms.filter((r) => r.lastMessage !== null && !have.has(r.lastMessage.messageId));
    if (todo.length === 0) return;
    const added = new Map<string, string>();
    for (const room of todo) {
      const last = room.lastMessage;
      if (!last) continue;
      const text = await this.chat.decryptMessage(room, last.message);
      added.set(last.messageId, text === null ? '(cannot read)' : text.replace(/\s+/g, ' ').trim());
    }
    this.previews.update((map) => new Map([...map, ...added]));
  }
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
