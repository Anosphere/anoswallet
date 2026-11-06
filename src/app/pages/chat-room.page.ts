import { Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { Router, RouterLink } from '@angular/router';
import { AvatarComponent } from '../components/avatar.component';
import { CopyButtonComponent } from '../components/copy-button.component';
import { MESSAGES_PAGE, MESSAGES_POLL_MS } from '../constants';
import { ChatService, Piece, piecesOf } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, MessageItem, Profile, RoomItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** A decrypted message of the room, split into its pieces. */
interface ShownMessage {
  messageId: string;
  position: number;
  senderAnopodId: string;
  createdAt: string;
  pieces: Piece[];
  mine: boolean;
}

/**
 * One conversation (wallet spec 8.2, Chat), at /chat/:chatRoomId inside the
 * chat page's pane: a header with the back arrow (on a phone), the avatar
 * or icon, the title, the members and a menu (Invite someone for the
 * creator of a private or public room, Members, Leave for a member who is
 * not the creator); the thread, opened at the room's newest MESSAGES_PAGE
 * messages with Load older messages on top while a page came back full,
 * polled every 3 seconds after the newest shown position; the message box
 * and Send. Room keys come from ChatService; an account id in a message
 * shows in code font with a copy button (8.5).
 */
@Component({
  selector: 'app-chat-room-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatMenuModule, AvatarComponent, CopyButtonComponent],
  template: `
    @if (room(); as room) {
      <header class="head">
        <a mat-icon-button class="back" routerLink="/chat" aria-label="Back to chats"><mat-icon>arrow_back</mat-icon></a>
        @if (chat.otherPerson(room); as other) {
          <app-avatar [anopodId]="other.anopodId" [username]="other.username" />
        } @else {
          <span class="disc"><mat-icon>{{ chat.icon(room) }}</mat-icon></span>
        }
        <div class="texts">
          <div class="title">{{ chat.title(room) }}</div>
          <div class="line">{{ membersLine(room) }}</div>
        </div>
        <button mat-icon-button type="button" [matMenuTriggerFor]="menu" aria-label="More"><mat-icon>more_vert</mat-icon></button>
        <mat-menu #menu="matMenu">
          @if (canInvite()) {
            <button mat-menu-item type="button" (click)="showInvite.set(!showInvite())"><mat-icon>person_add</mat-icon><span>Invite someone</span></button>
          }
          <button mat-menu-item type="button" (click)="showMembers.set(!showMembers())"><mat-icon>group</mat-icon><span>Members</span></button>
          @if (!isCreator()) {
            <button mat-menu-item type="button" (click)="leave()" [disabled]="busy()"><mat-icon>logout</mat-icon><span>Leave</span></button>
          }
        </mat-menu>
      </header>
      @if (showInvite()) {
        <div class="panel form">
          <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>Invite by username</mat-label><input matInput [ngModel]="inviteName()" (ngModelChange)="inviteName.set($event)" (keyup.enter)="findInvitee()" /></mat-form-field>
          <button mat-stroked-button type="button" (click)="findInvitee()" [disabled]="busy() || !inviteName().trim()">Find</button>
          @if (inviteTarget(); as found) {
            @if (found.selfie; as selfie) {
              <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" alt="selfie" />
            }
            <span>{{ found.firstName }} {{ found.lastName }} <code>{{ found.username }}</code></span>
            <button mat-flat-button type="button" (click)="invite()" [disabled]="busy()">Invite</button>
          }
        </div>
      }
      @if (showMembers()) {
        <div class="panel members">
          @for (m of room.members; track m.anopodId) {
            <span class="member"><app-avatar [anopodId]="m.anopodId" [username]="m.username" [size]="28" /> {{ m.username }}</span>
          }
          @for (m of room.invited; track m.anopodId) {
            <span class="member"><app-avatar [anopodId]="m.anopodId" [username]="m.username" [size]="28" /> {{ m.username }} <span class="muted">(invited)</span></span>
          }
        </div>
      }
      <div class="thread" #thread>
        @if (canLoadOlder()) {
          <button mat-button type="button" class="older" (click)="loadOlder()" [disabled]="busy()">Load older messages</button>
        }
        @for (m of messages(); track m.messageId) {
          <div class="bubble" [class.mine]="m.mine">
            <span class="sender">{{ senderName(room, m.senderAnopodId) }}</span>
            <span class="text">
              @for (piece of m.pieces; track $index) {
                @if (piece.accountId) {
                  <code>{{ piece.text }}</code><app-copy-button [text]="piece.text" label="Copy the account id" />
                } @else {
                  <span class="plain">{{ piece.text }}</span>
                }
              }
            </span>
          </div>
        } @empty {
          <p class="muted empty">No messages yet.</p>
        }
      </div>
      @if (error(); as text) {
        <p class="error note">{{ text }}</p>
      }
      <div class="composer">
        <mat-form-field appearance="outline" class="grow" subscriptSizing="dynamic"><mat-label>Message</mat-label><input matInput [ngModel]="messageText()" (ngModelChange)="messageText.set($event)" (keyup.enter)="send()" /></mat-form-field>
        <button mat-flat-button type="button" (click)="send()" [disabled]="busy() || !messageText().trim()">Send</button>
      </div>
    } @else if (!loaded()) {
      <p class="muted note">Loading the chat.</p>
    } @else {
      <div class="note">
        <p class="muted">You are not in this chat.</p>
        <a mat-button routerLink="/chat"><mat-icon>arrow_back</mat-icon> Chats</a>
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .back { display: none; }
    .texts { flex: 1; min-width: 0; }
    .title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .line { font-size: 13px; color: var(--mat-sys-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .disc { width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface-variant); flex: none; }
    .panel { padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .members { display: flex; flex-direction: column; gap: 6px; }
    .member { display: inline-flex; align-items: center; gap: 8px; }
    .selfie { width: 40px; height: 40px; object-fit: cover; border-radius: 50%; }
    .thread { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding: 12px; }
    .older { align-self: center; }
    .bubble { display: flex; flex-direction: column; max-width: 80%; padding: 8px 12px; border-radius: 12px; background: var(--mat-sys-surface-container); align-self: flex-start; }
    .bubble.mine { align-self: flex-end; background: var(--mat-sys-primary-container); }
    .bubble code { font-size: 12px; word-break: break-all; }
    .plain { white-space: pre-wrap; overflow-wrap: anywhere; }
    .sender { font-size: 11px; color: var(--mat-sys-on-surface-variant); }
    .composer { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .grow { flex: 1; min-width: 0; }
    .note { padding: 12px; margin: 0; }
    .empty { text-align: center; margin: auto; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .back { display: inline-flex; }
    }
  `,
})
export class ChatRoomPage {
  readonly chatRoomId = input.required<string>();

  protected readonly session = inject(SessionService);
  protected readonly chat = inject(ChatService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');

  /** True once the room list has arrived; the room is the one of the route, null when the pod is not in it. */
  protected readonly loaded = computed(() => this.session.chatRooms() !== null);
  protected readonly room = computed(() => this.session.chatRooms()?.rooms.find((r) => r.chatRoomId === this.chatRoomId()) ?? null);
  protected readonly isCreator = computed(() => this.room()?.creatorAnopodId === this.session.anopodId());
  protected readonly canInvite = computed(() => this.isCreator() && this.room()?.type !== 'marketplace');
  protected readonly messages = signal<ShownMessage[]>([]);
  protected readonly canLoadOlder = signal(false);
  protected readonly showInvite = signal(false);
  protected readonly showMembers = signal(false);
  protected readonly inviteName = signal('');
  protected readonly inviteTarget = signal<Profile | null>(null);
  protected readonly messageText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The room the thread shows, whether its opening read is done, and the positions of the oldest and newest shown. */
  private openedFor: string | null = null;
  private ready = false;
  private oldest = 0;
  private newest = 0;

  constructor() {
    // The route's room, once the list has it: opened when it changes.
    effect(() => {
      const room = this.room();
      if (!room || room.chatRoomId === this.openedFor) return;
      this.openedFor = room.chatRoomId;
      untracked(() => void this.open(room));
    });
    const timer = setInterval(() => void this.poll(true), MESSAGES_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected senderName(room: RoomItem, anopodId: string): string {
    return room.members.find((m) => m.anopodId === anopodId)?.username ?? anopodId.slice(0, 8);
  }

  /** The members' usernames, then the invited as "(invited)". */
  protected membersLine(room: RoomItem): string {
    return [...room.members.map((m) => m.username), ...room.invited.map((m) => `${m.username} (invited)`)].join(', ');
  }

  /** The room's newest page; whatever was shown before is dropped. */
  private async open(room: RoomItem): Promise<void> {
    this.ready = false;
    this.messages.set([]);
    this.oldest = 0;
    this.newest = 0;
    this.canLoadOlder.set(false);
    this.showInvite.set(false);
    this.showMembers.set(false);
    this.inviteTarget.set(null);
    this.error.set(null);
    const res = await this.api.listMessages(room.chatRoomId, { beforePosition: room.lastPosition + 1, limit: MESSAGES_PAGE });
    if (this.openedFor !== room.chatRoomId) return;
    if (!res.ok) {
      this.error.set(`/list-messages: ${reasonOf(res)}`);
      return;
    }
    const shown = await this.shown(room, res.body.messages);
    if (this.openedFor !== room.chatRoomId) return;
    this.messages.set(shown);
    this.oldest = shown.length > 0 ? shown[0].position : 0;
    this.newest = shown.length > 0 ? shown[shown.length - 1].position : 0;
    this.canLoadOlder.set(res.body.messages.length === MESSAGES_PAGE);
    this.ready = true;
    this.scrollToBottom();
  }

  /** The page before the oldest shown; the reader stays on the message they were looking at. */
  protected loadOlder(): Promise<void> {
    const room = this.room();
    if (!room || this.oldest === 0) return Promise.resolve();
    return this.run(async () => {
      const res = await this.api.listMessages(room.chatRoomId, { beforePosition: this.oldest, limit: MESSAGES_PAGE });
      if (!res.ok || this.openedFor !== room.chatRoomId) return res;
      const shown = await this.shown(room, res.body.messages);
      if (shown.length > 0) {
        const el = this.thread()?.nativeElement;
        const heightBefore = el?.scrollHeight ?? 0;
        this.oldest = shown[0].position;
        this.messages.update((list) => [...shown, ...list.filter((m) => !shown.some((s) => s.messageId === m.messageId))]);
        afterNextRender(
          () => {
            if (el) el.scrollTop += el.scrollHeight - heightBefore;
          },
          { injector: this.injector },
        );
      }
      this.canLoadOlder.set(res.body.messages.length === MESSAGES_PAGE);
      return res;
    });
  }

  /** New messages after the newest shown: quiet from the timer, logged after a send. */
  private async poll(quiet: boolean): Promise<void> {
    const room = this.room();
    if (!room || !this.ready || this.openedFor !== room.chatRoomId || !this.session.hasSession() || (quiet && this.busy())) return;
    const res = await this.api.listMessages(room.chatRoomId, { afterPosition: this.newest }, quiet);
    if (!res.ok || this.openedFor !== room.chatRoomId || res.body.messages.length === 0) return;
    const shown = await this.shown(room, res.body.messages);
    if (this.openedFor !== room.chatRoomId) return;
    this.messages.update((list) => [...list.filter((m) => !shown.some((s) => s.messageId === m.messageId)), ...shown]);
    this.newest = Math.max(this.newest, shown[shown.length - 1].position);
    if (this.oldest === 0) this.oldest = shown[0].position;
    this.scrollToBottom();
  }

  /** The messages decrypted with the room key and split into pieces; the two reasons a text cannot show, as before. */
  private async shown(room: RoomItem, items: MessageItem[]): Promise<ShownMessage[]> {
    const hasKey = (await this.chat.roomKeyOf(room)) !== null;
    const me = this.session.anopodId();
    const list: ShownMessage[] = [];
    for (const m of items) {
      const text = (await this.chat.decryptMessage(room, m.message)) ?? (hasKey ? '(cannot decrypt)' : '(no room key)');
      list.push({ messageId: m.messageId, position: m.position, senderAnopodId: m.senderAnopodId, createdAt: m.createdAt, pieces: piecesOf(text), mine: m.senderAnopodId === me });
    }
    return list;
  }

  protected send(): Promise<void> {
    return this.run(async () => {
      const room = this.room();
      if (!room) throw new Error('This chat is not open');
      const key = await this.chat.roomKeyOf(room);
      if (!key) throw new Error('No room key for this room');
      const res = await this.api.sendMessage(room.chatRoomId, await this.crypto.encryptText(key, this.messageText().trim()));
      if (res.ok) {
        this.messageText.set('');
        await this.poll(false);
      }
      return res;
    });
  }

  protected findInvitee(): Promise<void> {
    return this.run(async () => {
      const res = await this.api.searchUsernames(this.inviteName().trim().toLowerCase());
      this.inviteTarget.set(res.ok ? res.body : null);
      return res;
    });
  }

  /** The room's key wrapped to the found pod's chat keys; the room list is refreshed so the invite shows in the title. */
  protected invite(): Promise<void> {
    return this.run(async () => {
      const room = this.room();
      const target = this.inviteTarget();
      if (!room || !target) throw new Error('Find the username first');
      const hpkeKey = await this.chat.wrapFor(room.chatRoomId, target.anopodId);
      const res = await this.api.inviteToChatRoom(room.chatRoomId, target.anopodId, hpkeKey);
      if (res.ok) {
        this.inviteName.set('');
        this.inviteTarget.set(null);
        this.showInvite.set(false);
        await this.chat.refreshRooms();
      }
      return res;
    });
  }

  protected leave(): Promise<void> {
    return this.run(async () => {
      const room = this.room();
      if (!room) throw new Error('This chat is not open');
      const res = await this.api.leaveChatRoom(room.chatRoomId);
      if (res.ok) {
        this.session.roomKeys.delete(room.chatRoomId);
        await this.chat.refreshRooms();
        await this.router.navigateByUrl('/chat');
      }
      return res;
    });
  }

  private scrollToBottom(): void {
    afterNextRender(
      () => {
        const el = this.thread()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      },
      { injector: this.injector },
    );
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
