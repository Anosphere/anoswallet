import { TextFieldModule } from '@angular/cdk/text-field';
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
import { FoundAccountId, PinnedListingComponent } from '../components/pinned-listing.component';
import { MESSAGES_PAGE, MESSAGES_POLL_MS } from '../constants';
import { ChatService, Piece, piecesOf } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, MessageItem, Profile, RoomItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** A decrypted message of the room, split into its pieces; `pending` while this pod's own message is on its way. */
interface ShownMessage {
  messageId: string;
  position: number;
  senderAnopodId: string;
  createdAt: string;
  pieces: Piece[];
  mine: boolean;
  pending: boolean;
}

/** Messages by one sender within GROUP_MINUTES of each other on one day: the name once on top (someone else's, in a room that is not direct), the time once below. */
interface Group {
  senderAnopodId: string;
  senderName: string;
  mine: boolean;
  showSender: boolean;
  messages: ShownMessage[];
  time: string;
}

/** What the thread draws: a day line, or a group of bubbles. */
type ThreadItem = { kind: 'day'; key: string; label: string } | { kind: 'group'; key: string; group: Group };

/** Messages this close in time by one sender share a group. */
const GROUP_MINUTES = 5;

/** A message that arrives scrolls the thread down only when the reader is this close to the bottom. */
const FOLLOW_PX = 120;

/**
 * One conversation (wallet spec 8.2, Chat), at /chat/:chatRoomId inside the
 * chat page's pane: a header with the back arrow (on a phone), the avatar
 * or icon, the title, the members and a menu (Invite someone for the
 * creator of a private or public room, Members, Leave for a member who is
 * not the creator); the thread, opened at the room's newest MESSAGES_PAGE
 * messages with Load older messages on top while a page came back full,
 * polled every 3 seconds after the newest shown position, the messages
 * grouped by sender and five minutes with a day line between days; the
 * message box that grows to five lines (Enter sends, Shift+Enter a new
 * line) and the round Send. A sent message shows at once as a pale bubble
 * marked "Sending" and gets its tick from the answer. Room keys come from
 * ChatService; an account id in a message shows in code font with a copy
 * button (8.5). The room is marked seen when it opens and when new
 * messages show. A private room about a listing shows the pinned listing
 * card (8.7) between the header and the thread, fed with the account ids
 * found in the messages (2026-11-06).
 */
@Component({
  selector: 'app-chat-room-page',
  imports: [FormsModule, RouterLink, TextFieldModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatMenuModule, AvatarComponent, CopyButtonComponent, PinnedListingComponent],
  template: `
    @if (room(); as room) {
      <header class="head">
        <a mat-icon-button class="back" routerLink="/chat" [attr.aria-label]="t().common.backToChats"><mat-icon>arrow_back</mat-icon></a>
        @if (chat.otherPerson(room); as other) {
          <app-avatar [anopodId]="other.anopodId" [username]="other.username" />
        } @else {
          <span class="disc"><mat-icon>{{ chat.icon(room) }}</mat-icon></span>
        }
        <div class="texts">
          <div class="title">{{ chat.title(room) }}</div>
          <div class="line">{{ membersLine(room) }}</div>
        </div>
        <button mat-icon-button type="button" [matMenuTriggerFor]="menu" [attr.aria-label]="t().chatRoom.more"><mat-icon>more_vert</mat-icon></button>
        <mat-menu #menu="matMenu">
          @if (canInvite()) {
            <button mat-menu-item type="button" (click)="showInvite.set(!showInvite())"><mat-icon>person_add</mat-icon><span>{{ t().chatRoom.inviteSomeone }}</span></button>
          }
          <button mat-menu-item type="button" (click)="showMembers.set(!showMembers())"><mat-icon>group</mat-icon><span>{{ t().chatRoom.members }}</span></button>
          @if (!isCreator()) {
            <button mat-menu-item type="button" (click)="leave()" [disabled]="busy()"><mat-icon>logout</mat-icon><span>{{ t().chatRoom.leave }}</span></button>
          }
        </mat-menu>
      </header>
      @if (showInvite()) {
        <div class="panel form">
          <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().chatRoom.inviteByUsername }}</mat-label><input matInput [ngModel]="inviteName()" (ngModelChange)="inviteName.set($event)" (keyup.enter)="findInvitee()" /></mat-form-field>
          <button mat-stroked-button type="button" (click)="findInvitee()" [disabled]="busy() || !inviteName().trim()">{{ t().common.find }}</button>
          @if (inviteTarget(); as found) {
            @if (found.selfie; as selfie) {
              <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" [alt]="t().common.selfie" />
            }
            <span>{{ found.firstName }} {{ found.lastName }} <code>{{ found.username }}</code></span>
            <button mat-flat-button type="button" (click)="invite()" [disabled]="busy()">{{ t().chatRoom.invite }}</button>
          }
        </div>
      }
      @if (showMembers()) {
        <div class="panel members">
          @for (m of room.members; track m.anopodId) {
            <span class="member"><app-avatar [anopodId]="m.anopodId" [username]="m.username" [size]="28" /> {{ m.username }}</span>
          }
          @for (m of room.invited; track m.anopodId) {
            <span class="member"><app-avatar [anopodId]="m.anopodId" [username]="m.username" [size]="28" /> {{ m.username }} <span class="muted">{{ t().chatRoom.invited }}</span></span>
          }
        </div>
      }
      @if (room.type === 'private' && room.listing) {
        <app-pinned-listing [room]="room" [accountIds]="accountIds()" />
      }
      <div class="thread" #threadBox>
        @if (canLoadOlder()) {
          <button mat-button type="button" class="older" (click)="loadOlder()" [disabled]="busy()">{{ t().chatRoom.loadOlder }}</button>
        }
        @for (item of thread(); track item.key) {
          @if (item.kind === 'day') {
            <div class="day"><span>{{ item.label }}</span></div>
          } @else {
            <div class="group" [class.mine]="item.group.mine">
              @if (item.group.showSender) {
                <app-avatar class="face" [anopodId]="item.group.senderAnopodId" [username]="item.group.senderName" [size]="28" />
              }
              <div class="bubbles">
                @if (item.group.showSender) {
                  <span class="sender">{{ item.group.senderName }}</span>
                }
                @for (m of item.group.messages; track m.messageId) {
                  <div class="bubble" [class.pending]="m.pending">
                    <span class="text">
                      @for (piece of m.pieces; track $index) {
                        @if (piece.accountId) {
                          <code>{{ piece.text }}</code><app-copy-button [text]="piece.text" [label]="t().common.copyAccountId" />
                        } @else {
                          <span class="plain">{{ piece.text }}</span>
                        }
                      }
                    </span>
                    @if (m.mine) {
                      <span class="state">
                        @if (m.pending) {
                          {{ t().chatRoom.sending }}
                        } @else {
                          <mat-icon class="tick">done</mat-icon>
                        }
                      </span>
                    }
                  </div>
                }
                <span class="time">{{ item.group.time }}</span>
              </div>
            </div>
          }
        } @empty {
          <p class="muted empty">{{ t().chatRoom.noMessages }}</p>
        }
      </div>
      @if (error(); as text) {
        <p class="error note">{{ text }}</p>
      }
      <div class="composer">
        <mat-form-field appearance="outline" class="grow" subscriptSizing="dynamic">
          <mat-label>{{ t().chatRoom.message }}</mat-label>
          <textarea matInput cdkTextareaAutosize cdkAutosizeMinRows="1" cdkAutosizeMaxRows="5" [ngModel]="messageText()" (ngModelChange)="messageText.set($event)" (keydown.enter)="enter($event)"></textarea>
        </mat-form-field>
        <button mat-mini-fab type="button" class="send" (click)="send()" [disabled]="busy() || !messageText().trim()" [attr.aria-label]="t().common.send"><mat-icon>send</mat-icon></button>
      </div>
    } @else if (!loaded()) {
      <p class="muted note">{{ t().chatRoom.loading }}</p>
    } @else {
      <div class="note">
        <p class="muted">{{ t().chatRoom.notInChat }}</p>
        <a mat-button routerLink="/chat"><mat-icon>arrow_back</mat-icon> {{ t().common.chats }}</a>
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
    .thread { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
    .older { align-self: center; }
    .day { display: flex; justify-content: center; margin: 8px 0 0; }
    .day span { font-size: 12px; color: var(--mat-sys-on-surface-variant); background: var(--mat-sys-surface-container); border-radius: 10px; padding: 2px 10px; }
    .group { display: flex; align-items: flex-end; gap: 8px; max-width: 80%; align-self: flex-start; }
    .group.mine { align-self: flex-end; }
    .face { margin-bottom: 18px; }
    .bubbles { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
    .group.mine .bubbles { align-items: flex-end; }
    .bubble { padding: 8px 12px; border-radius: 16px; background: var(--mat-sys-surface-container); overflow-wrap: anywhere; }
    .group.mine .bubble { background: var(--mat-sys-primary-container); }
    .bubble.pending { opacity: 0.6; }
    .bubble code { font-size: 12px; word-break: break-all; }
    .plain { white-space: pre-wrap; }
    .state { display: inline-flex; align-items: center; margin-left: 6px; font-size: 11px; color: var(--mat-sys-on-surface-variant); vertical-align: bottom; }
    .tick { font-size: 14px; width: 14px; height: 14px; }
    .sender { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 0 0 2px 8px; }
    .time { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 2px 8px 0; }
    .composer { display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .grow { flex: 1; min-width: 0; }
    .send { flex: none; margin-bottom: 4px; }
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
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  private readonly threadBox = viewChild<ElementRef<HTMLElement>>('threadBox');

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

  /** The messages as the thread draws them: a day line before each day, the messages of one sender within GROUP_MINUTES in one group. */
  protected readonly thread = computed<ThreadItem[]>(() => {
    const room = this.room();
    if (!room) return [];
    const direct = this.chat.kind(room) === 'direct';
    const items: ThreadItem[] = [];
    let group: Group | null = null;
    let lastDay = '';
    for (const m of this.messages()) {
      const day = dayKey(m.createdAt);
      if (day !== lastDay) {
        items.push({ kind: 'day', key: `day-${day}`, label: this.chat.dayLabel(m.createdAt) });
        lastDay = day;
        group = null;
      }
      const previous = group ? group.messages[group.messages.length - 1] : null;
      if (group && previous && group.senderAnopodId === m.senderAnopodId && minutesBetween(previous.createdAt, m.createdAt) < GROUP_MINUTES) {
        group.messages.push(m);
        group.time = this.chat.timeOf(m.createdAt);
      } else {
        group = {
          senderAnopodId: m.senderAnopodId,
          senderName: this.senderName(room, m.senderAnopodId),
          mine: m.mine,
          showSender: !m.mine && !direct,
          messages: [m],
          time: this.chat.timeOf(m.createdAt),
        };
        items.push({ kind: 'group', key: m.messageId, group });
      }
    }
    return items;
  });

  /** The account ids in the decrypted messages (the 64-hex pieces), each with its sender and position, newest first: what the pinned listing card works from (8.7). */
  protected readonly accountIds = computed<FoundAccountId[]>(() => {
    const found: FoundAccountId[] = [];
    for (const m of this.messages()) {
      for (const piece of m.pieces) {
        if (piece.accountId) found.push({ accountId: piece.text.toLowerCase(), senderAnopodId: m.senderAnopodId, position: m.position });
      }
    }
    return found.sort((a, b) => b.position - a.position);
  });

  /** The room the thread shows, whether its opening read is done, and the positions of the oldest and newest shown. */
  private openedFor: string | null = null;
  private ready = false;
  private oldest = 0;
  private newest = 0;
  private pendingCount = 0;

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
    return [...room.members.map((m) => m.username), ...room.invited.map((m) => this.t().rooms.invited(m.username))].join(', ');
  }

  /** Enter sends; Shift+Enter is left to the textarea, a new line. */
  protected enter(event: Event): void {
    if ((event as KeyboardEvent).shiftKey) return;
    event.preventDefault();
    void this.send();
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
    this.session.markSeen(room.chatRoomId, this.newest);
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
        const el = this.threadBox()?.nativeElement;
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

  /** New messages after the newest shown: quiet from the timer, logged after a send. The thread follows them only when the reader is near the bottom. */
  private async poll(quiet: boolean): Promise<void> {
    const room = this.room();
    if (!room || !this.ready || this.openedFor !== room.chatRoomId || !this.session.hasSession() || (quiet && this.busy())) return;
    const res = await this.api.listMessages(room.chatRoomId, { afterPosition: this.newest }, quiet);
    if (!res.ok || this.openedFor !== room.chatRoomId || res.body.messages.length === 0) return;
    const shown = await this.shown(room, res.body.messages);
    if (this.openedFor !== room.chatRoomId) return;
    const follow = this.nearBottom();
    this.messages.update((list) => [...list.filter((m) => !shown.some((s) => s.messageId === m.messageId)), ...shown]);
    this.newest = Math.max(this.newest, shown[shown.length - 1].position);
    if (this.oldest === 0) this.oldest = shown[0].position;
    this.session.markSeen(room.chatRoomId, this.newest);
    if (follow) this.scrollToBottom();
  }

  /** The messages decrypted with the room key and split into pieces; the two reasons a text cannot show, as before. */
  private async shown(room: RoomItem, items: MessageItem[]): Promise<ShownMessage[]> {
    const hasKey = (await this.chat.roomKeyOf(room)) !== null;
    const me = this.session.anopodId();
    const list: ShownMessage[] = [];
    for (const m of items) {
      const text = (await this.chat.decryptMessage(room, m.message)) ?? (hasKey ? this.t().chatRoom.cannotDecrypt : this.t().chatRoom.noRoomKey);
      list.push({
        messageId: m.messageId,
        position: m.position,
        senderAnopodId: m.senderAnopodId,
        createdAt: m.createdAt,
        pieces: piecesOf(text),
        mine: m.senderAnopodId === me,
        pending: false,
      });
    }
    return list;
  }

  /**
   * The message shows at once as a pending bubble and the box empties; the
   * answer gives the bubble its id and position, and the poll that follows
   * brings in whatever else arrived. A refusal, or a key that fails, takes
   * the bubble away and puts the text back.
   */
  protected send(): Promise<void> {
    const text = this.messageText().trim();
    if (!text) return Promise.resolve();
    return this.run(async () => {
      const room = this.room();
      if (!room) throw new Error(this.t().chatRoom.notOpen);
      const key = await this.chat.roomKeyOf(room);
      if (!key) throw new Error(this.t().common.noRoomKey);
      const pending: ShownMessage = {
        messageId: `pending-${++this.pendingCount}`,
        position: 0,
        senderAnopodId: this.session.anopodId() ?? '',
        createdAt: new Date().toISOString(),
        pieces: piecesOf(text),
        mine: true,
        pending: true,
      };
      this.messages.update((list) => [...list, pending]);
      this.messageText.set('');
      this.scrollToBottom();
      let res: ApiResponse<{ messageId: string; position: number }>;
      try {
        res = await this.api.sendMessage(room.chatRoomId, await this.crypto.encryptText(key, text));
      } catch (err) {
        this.messages.update((list) => list.filter((m) => m !== pending));
        this.messageText.set(text);
        throw err;
      }
      if (!res.ok) {
        this.messages.update((list) => list.filter((m) => m !== pending));
        this.messageText.set(text);
        return res;
      }
      const sent: ShownMessage = { ...pending, messageId: res.body.messageId, position: res.body.position, pending: false };
      this.messages.update((list) => list.map((m) => (m === pending ? sent : m)));
      this.session.markSeen(room.chatRoomId, res.body.position);
      await this.poll(false);
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
      if (!room || !target) throw new Error(this.t().common.findUsernameFirst);
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
      if (!room) throw new Error(this.t().chatRoom.notOpen);
      const res = await this.api.leaveChatRoom(room.chatRoomId);
      if (res.ok) {
        this.session.roomKeys.delete(room.chatRoomId);
        await this.chat.refreshRooms();
        await this.router.navigateByUrl('/chat');
      }
      return res;
    });
  }

  /** True when the reader is within FOLLOW_PX of the thread's bottom, or the thread is not drawn. */
  private nearBottom(): boolean {
    const el = this.threadBox()?.nativeElement;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX;
  }

  private scrollToBottom(): void {
    afterNextRender(
      () => {
        const el = this.threadBox()?.nativeElement;
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

/** The local calendar day of a time, as a key. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.abs(Date.parse(toIso) - Date.parse(fromIso)) / 60_000;
}
