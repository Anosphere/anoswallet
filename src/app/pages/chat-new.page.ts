import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { Router, RouterLink } from '@angular/router';
import { ChatService } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, Profile, PublicRoomItem, RoomItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/**
 * New chat (wallet spec 8.2, Chat), at /chat/new inside the chat page's
 * pane, three tabs. Message someone: a username, Find, the person with
 * their selfie, Start chat, which opens the private chat the two of you
 * already have or makes one (a new room key wrapped to this pod's chat keys
 * for the room, and to the person's for the invite). New public room: a
 * name, Create. Find public rooms: the list with Open, Requested or Request
 * to join.
 */
@Component({
  selector: 'app-chat-new-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatTabsModule],
  template: `
    <header class="head">
      <a mat-icon-button class="back" routerLink="/chat" aria-label="Back to chats"><mat-icon>arrow_back</mat-icon></a>
      <h2>New chat</h2>
    </header>
    @if (!session.hasChatKeys()) {
      <p class="error note">No chat keys in this tab: unlock again.</p>
    }
    @if (error(); as text) {
      <p class="error note">{{ text }}</p>
    }
    <mat-tab-group (selectedIndexChange)="tabChanged($event)">
      <mat-tab label="Message someone">
        <div class="tab">
          <div class="form">
            <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>Username</mat-label><input matInput [ngModel]="username()" (ngModelChange)="username.set($event)" (keyup.enter)="find()" /></mat-form-field>
            <button mat-stroked-button type="button" (click)="find()" [disabled]="busy() || !username().trim()">Find</button>
          </div>
          @if (found(); as person) {
            <div class="person">
              @if (person.selfie; as selfie) {
                <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" alt="selfie" />
              }
              <span class="texts">
                <span class="title">{{ person.firstName }} {{ person.lastName }}</span>
                <span class="line">{{ person.username }}</span>
              </span>
              <button mat-flat-button type="button" (click)="startChat()" [disabled]="busy() || isMe() || !session.hasChatKeys()">Start chat</button>
            </div>
            @if (isMe()) {
              <p class="muted">That is you.</p>
            }
          }
        </div>
      </mat-tab>
      <mat-tab label="New public room">
        <div class="tab form">
          <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>Name</mat-label><input matInput [ngModel]="roomName()" (ngModelChange)="roomName.set($event)" (keyup.enter)="createPublic()" /></mat-form-field>
          <button mat-flat-button type="button" (click)="createPublic()" [disabled]="busy() || !roomName().trim() || !session.hasChatKeys()">Create</button>
        </div>
      </mat-tab>
      <mat-tab label="Find public rooms">
        <div class="tab">
          @for (room of publicRooms(); track room.chatRoomId) {
            <div class="item">
              <span class="disc"><mat-icon>public</mat-icon></span>
              <span class="texts">
                <span class="title">{{ room.name }}</span>
                <span class="line">by {{ room.creator.username }} · {{ room.memberCount }} {{ room.memberCount === 1 ? 'member' : 'members' }}</span>
              </span>
              @if (inRoom(room.chatRoomId)) {
                <a mat-stroked-button [routerLink]="['/chat', room.chatRoomId]">Open</a>
              } @else if (chat.requestedRooms().has(room.chatRoomId)) {
                <button mat-stroked-button type="button" disabled>Requested</button>
              } @else {
                <button mat-stroked-button type="button" (click)="requestToJoin(room.chatRoomId)" [disabled]="busy()">Request to join</button>
              }
            </div>
          } @empty {
            <p class="muted">No public rooms yet.</p>
          }
          <button mat-button type="button" (click)="loadPublicRooms()" [disabled]="busy()">Refresh</button>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: auto; }
    .head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .head h2 { font-size: 1.1rem; font-weight: 500; margin: 0; }
    .back { display: none; }
    .tab { padding: 12px; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .person, .item { display: flex; align-items: center; gap: 12px; padding: 8px 0; flex-wrap: wrap; }
    .selfie { width: 48px; height: 48px; object-fit: cover; border-radius: 50%; }
    .disc { width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface-variant); flex: none; }
    .texts { flex: 1; min-width: 140px; display: flex; flex-direction: column; }
    .title { font-weight: 500; }
    .line { font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .note { padding: 8px 12px; margin: 0; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .back { display: inline-flex; }
    }
  `,
})
export class ChatNewPage {
  protected readonly session = inject(SessionService);
  protected readonly chat = inject(ChatService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);

  protected readonly username = signal('');
  protected readonly found = signal<Profile | null>(null);
  protected readonly isMe = computed(() => this.found()?.anopodId === this.session.anopodId());
  protected readonly roomName = signal('');
  protected readonly publicRooms = signal<PublicRoomItem[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private publicLoaded = false;

  /** The public rooms load the first time their tab opens. */
  protected tabChanged(index: number): void {
    if (index === 2 && !this.publicLoaded) void this.loadPublicRooms();
  }

  protected find(): Promise<void> {
    return this.run(async () => {
      const res = await this.api.searchUsernames(this.username().trim().toLowerCase());
      this.found.set(res.ok ? res.body : null);
      return res;
    });
  }

  /**
   * The private chat with the found person: the one that already has just
   * the two of you, else a new room (its key wrapped to this pod's chat
   * keys) with the person invited (the key wrapped to theirs, read first so
   * someone without chat keys makes no room).
   */
  protected startChat(): Promise<void> {
    return this.run(async () => {
      const target = this.found();
      const me = this.session.anopodId();
      if (!target || me === null) throw new Error('Find the username first');
      if (target.anopodId === me) throw new Error('That is you.');
      const existing = (this.session.chatRooms()?.rooms ?? []).find((room) => room.type === 'private' && justUs(room, me, target.anopodId));
      if (existing) {
        await this.router.navigate(['/chat', existing.chatRoomId]);
        return null;
      }
      const chat = this.session.getChatKeys();
      if (!chat) throw new Error('No chat keys in this tab');
      const keys = await this.api.getChatPublicKeys([target.anopodId]);
      const theirs = keys.ok ? keys.body.keys.find((k) => k.anopodId === target.anopodId) : undefined;
      if (!theirs) throw new Error('That anoPod has no chat keys (setup not complete)');
      const roomKey = this.crypto.newRoomKey();
      const ownKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
      const created = await this.api.createChatRoom('private', undefined, this.crypto.toHex(ownKey));
      if (!created.ok) return created;
      this.session.roomKeys.set(created.body.chatRoomId, roomKey);
      const theirKey = this.crypto.toHex(await this.crypto.wrapRoomKey(roomKey, theirs.chatPublicKey, theirs.chatPublicKeyPq));
      const invited = await this.api.inviteToChatRoom(created.body.chatRoomId, target.anopodId, theirKey);
      await this.chat.refreshRooms();
      if (invited.ok) {
        this.username.set('');
        this.found.set(null);
        await this.router.navigate(['/chat', created.body.chatRoomId]);
      }
      return invited;
    });
  }

  /** A public room with a fresh room key, wrapped to this pod's own chat keys; it opens. */
  protected createPublic(): Promise<void> {
    return this.run(async () => {
      const chat = this.session.getChatKeys();
      if (!chat) throw new Error('No chat keys in this tab');
      const roomKey = this.crypto.newRoomKey();
      const ownKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
      const res = await this.api.createChatRoom('public', this.roomName().trim(), this.crypto.toHex(ownKey));
      if (res.ok) {
        this.session.roomKeys.set(res.body.chatRoomId, roomKey);
        this.roomName.set('');
        await this.chat.refreshRooms();
        await this.router.navigate(['/chat', res.body.chatRoomId]);
      }
      return res;
    });
  }

  protected loadPublicRooms(): Promise<void> {
    return this.run(async () => {
      const res = await this.api.listPublicChatRooms();
      if (res.ok) {
        this.publicRooms.set(res.body.rooms);
        this.publicLoaded = true;
      }
      return res;
    });
  }

  /** True when this pod is in the room already. */
  protected inRoom(chatRoomId: string): boolean {
    return this.session.chatRooms()?.rooms.some((r) => r.chatRoomId === chatRoomId) ?? false;
  }

  protected requestToJoin(chatRoomId: string): Promise<void> {
    return this.run(async () => {
      const res = await this.api.requestToJoin(chatRoomId);
      if (res.ok) this.chat.markRequested(chatRoomId);
      return res;
    });
  }

  private async run(action: () => Promise<ApiResponse<unknown> | null>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await action();
      if (res && !res.ok) this.error.set(reasonOf(res));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** True when the room's members and invited are exactly `me` and `other`. */
function justUs(room: RoomItem, me: string, other: string): boolean {
  const ids = [...room.members, ...room.invited].map((m) => m.anopodId);
  return ids.length === 2 && ids.includes(me) && ids.includes(other);
}
