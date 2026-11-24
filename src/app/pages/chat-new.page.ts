import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { Router, RouterLink } from '@angular/router';
import { RoomPictureComponent } from '../components/room-picture.component';
import { LIKE_NAMED_ROOMS, PUBLIC_ROOMS_PAGE, ROOM_SEARCH_DEBOUNCE_MS } from '../constants';
import { ChatService } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
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
 *
 * Since 2026-11-22 the tabs stand in the order Message someone, Find
 * public rooms, New public room. Find public rooms has a search box, read
 * a moment after the last key, shows the rooms with the most members
 * first, PUBLIC_ROOMS_PAGE at a time, and has Show more under them while
 * the last read came back full. New public room shows, under its name
 * box, the public rooms whose name holds the typed one (the hint), at
 * most LIKE_NAMED_ROOMS; the hint never stops a creation.
 *
 * Since 2026-11-24 a chat about a listing (a marketplace chat) and a chat
 * about an attestor case do not count as the private chat the two of you
 * already have: Start chat passes them over, and makes a room when the
 * two of you have no other.
 */
@Component({
  selector: 'app-chat-new-page',
  imports: [NgTemplateOutlet, FormsModule, RouterLink, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatTabsModule, RoomPictureComponent],
  template: `
    <header class="head">
      <a mat-icon-button class="back" routerLink="/chat" [attr.aria-label]="t().common.backToChats"><mat-icon>arrow_back</mat-icon></a>
      <h2>{{ t().common.newChat }}</h2>
    </header>
    @if (!session.hasChatKeys()) {
      <p class="error note">{{ t().common.noChatKeysUnlock }}</p>
    }
    @if (error(); as text) {
      <p class="error note">{{ text }}</p>
    }
    <mat-tab-group (selectedIndexChange)="tabChanged($event)">
      <mat-tab [label]="t().chatNew.tabMessage">
        <div class="tab">
          <div class="form">
            <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().common.username }}</mat-label><input matInput [ngModel]="username()" (ngModelChange)="username.set($event)" (keyup.enter)="find()" /></mat-form-field>
            <button mat-stroked-button type="button" (click)="find()" [disabled]="busy() || !username().trim()">{{ t().common.find }}</button>
          </div>
          @if (found(); as person) {
            <div class="person">
              @if (person.selfie; as selfie) {
                <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" [alt]="t().common.selfie" />
              }
              <span class="texts">
                <span class="title">{{ person.firstName }} {{ person.lastName }}</span>
                <span class="line">{{ person.username }}</span>
              </span>
              <button mat-flat-button type="button" (click)="startChat()" [disabled]="busy() || isMe() || !session.hasChatKeys()">{{ t().chatNew.startChat }}</button>
            </div>
            @if (isMe()) {
              <p class="muted">{{ t().chatNew.thatIsYou }}</p>
            }
          }
        </div>
      </mat-tab>
      <mat-tab [label]="t().chatNew.tabFind">
        <div class="tab">
          <mat-form-field class="search" appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().chatNew.searchRooms }}</mat-label><input matInput [ngModel]="roomSearch()" (ngModelChange)="searchRooms($event)" autocomplete="off" /></mat-form-field>
          @if (findError(); as text) {
            <p class="error">{{ text }}</p>
          }
          @for (room of publicRooms(); track room.chatRoomId) {
            <ng-container [ngTemplateOutlet]="roomRow" [ngTemplateOutletContext]="{ $implicit: room }" />
          } @empty {
            @if (publicLoaded()) {
              <p class="muted">{{ foundFor() ? t().chatNew.noRoomsMatch : t().chatNew.noPublicRooms }}</p>
            }
          }
          @if (moreRooms()) {
            <button mat-button type="button" (click)="loadMoreRooms()" [disabled]="loadingRooms()">{{ t().chatNew.showMore }}</button>
          }
          <button mat-button type="button" (click)="loadPublicRooms()" [disabled]="loadingRooms()">{{ t().common.refresh }}</button>
        </div>
      </mat-tab>
      <mat-tab [label]="t().chatNew.tabPublic">
        <div class="tab">
          <div class="form">
            <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().common.name }}</mat-label><input matInput [ngModel]="roomName()" (ngModelChange)="nameTyped($event)" (keyup.enter)="createPublic()" /></mat-form-field>
            <button mat-flat-button type="button" (click)="createPublic()" [disabled]="busy() || !roomName().trim() || !session.hasChatKeys()">{{ t().common.create }}</button>
          </div>
          @if (likeNamed().length > 0) {
            <p class="muted hint">{{ t().chatNew.likeNamed }}</p>
            @for (room of likeNamed(); track room.chatRoomId) {
              <ng-container [ngTemplateOutlet]="roomRow" [ngTemplateOutletContext]="{ $implicit: room }" />
            }
          }
        </div>
      </mat-tab>
    </mat-tab-group>
    <ng-template #roomRow let-room>
      <div class="item">
        <app-room-picture [chatRoomId]="room.chatRoomId" [pictureAt]="room.pictureAt" />
        <span class="texts">
          <span class="title">{{ room.name }}</span>
          <span class="line">{{ t().chatNew.byAndMembers(room.creator.username, room.memberCount) }}</span>
        </span>
        @if (inRoom(room.chatRoomId)) {
          <a mat-stroked-button [routerLink]="['/chat', room.chatRoomId]">{{ t().chatNew.open }}</a>
        } @else if (chat.requestedRooms().has(room.chatRoomId)) {
          <button mat-stroked-button type="button" disabled>{{ t().chatNew.requested }}</button>
        } @else {
          <button mat-stroked-button type="button" (click)="requestToJoin(room.chatRoomId)" [disabled]="busy()">{{ t().chatNew.requestToJoin }}</button>
        }
      </div>
    </ng-template>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: auto; }
    .head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .head h2 { font-size: 1.1rem; font-weight: 500; margin: 0; }
    .back { display: none; }
    .tab { padding: 12px; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .search { width: 100%; }
    .hint { margin: 12px 0 0; }
    .person, .item { display: flex; align-items: center; gap: 12px; padding: 8px 0; flex-wrap: wrap; }
    .selfie { width: 48px; height: 48px; object-fit: cover; border-radius: 50%; }
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
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly username = signal('');
  protected readonly found = signal<Profile | null>(null);
  protected readonly isMe = computed(() => this.found()?.anopodId === this.session.anopodId());
  protected readonly roomName = signal('');
  protected readonly publicRooms = signal<PublicRoomItem[]>([]);
  /** What the search box of Find public rooms holds (2026-11-22). */
  protected readonly roomSearch = signal('');
  /** The search word the rooms on the screen were read for; empty for no search. */
  protected readonly foundFor = signal('');
  /** A read of the public rooms has come back with its rooms, or with none, so the line for an empty list may show. A refused read does not count. */
  protected readonly publicLoaded = signal(false);
  /** A read of the public rooms is running. */
  protected readonly loadingRooms = signal(false);
  /** The last read came back full, so more rooms may fit: Show more stands under the list. */
  protected readonly moreRooms = signal(false);
  /** A refused read of the public rooms, said in the tab. */
  protected readonly findError = signal<string | null>(null);
  /** New public room: the rooms whose name holds what the name box holds, the biggest first, at most LIKE_NAMED_ROOMS (2026-11-22). */
  protected readonly likeNamed = signal<PublicRoomItem[]>([]);
  /** The first reads counted, so an answer that a later read overtook is dropped. */
  private roomReads = 0;
  /** How many rooms the masterpod has handed out for the search word on the screen: where Show more goes on. */
  private roomsFetched = 0;
  /** The hint's reads counted, for the same reason. */
  private nameReads = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private nameTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      if (this.nameTimer !== null) clearTimeout(this.nameTimer);
    });
  }

  /** The public rooms are read when their tab opens, until a read has come back; after that only the search box, Show more and Refresh read. Find public rooms is the second tab since 2026-11-22; it was the third. */
  protected tabChanged(index: number): void {
    if (index === 1 && !this.publicLoaded()) void this.loadPublicRooms();
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
   * someone without chat keys makes no room). Since 2026-11-24 a room
   * about a listing or about an attestor case is passed over: a
   * marketplace chat or a case chat with the person is not that chat.
   */
  protected startChat(): Promise<void> {
    return this.run(async () => {
      const target = this.found();
      const me = this.session.anopodId();
      if (!target || me === null) throw new Error(this.t().common.findUsernameFirst);
      if (target.anopodId === me) throw new Error(this.t().chatNew.thatIsYou);
      const existing = (this.session.chatRooms()?.rooms ?? []).find((room) => room.type === 'private' && !room.listingId && !room.caseId && justUs(room, me, target.anopodId));
      if (existing) {
        await this.router.navigate(['/chat', existing.chatRoomId]);
        return null;
      }
      const chat = this.session.getChatKeys();
      if (!chat) throw new Error(this.t().common.noChatKeys);
      const keys = await this.api.getChatPublicKeys([target.anopodId]);
      const theirs = keys.ok ? keys.body.keys.find((k) => k.anopodId === target.anopodId) : undefined;
      if (!theirs) throw new Error(this.t().common.podHasNoChatKeys);
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
      if (!chat) throw new Error(this.t().common.noChatKeys);
      const roomKey = this.crypto.newRoomKey();
      const ownKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
      const res = await this.api.createChatRoom('public', this.roomName().trim(), this.crypto.toHex(ownKey));
      if (res.ok) {
        this.session.roomKeys.set(res.body.chatRoomId, roomKey);
        this.nameTyped('');
        await this.chat.refreshRooms();
        await this.router.navigate(['/chat', res.body.chatRoomId]);
      }
      return res;
    });
  }

  /** The search box changed (2026-11-22): the list is read again ROOM_SEARCH_DEBOUNCE_MS after the last key, quietly. */
  protected searchRooms(text: string): void {
    this.roomSearch.set(text);
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadPublicRooms(true), ROOM_SEARCH_DEBOUNCE_MS);
  }

  /** /list-public-chat-rooms for what the search box holds: the first PUBLIC_ROOMS_PAGE rooms, the biggest first, in place of the rooms shown. An answer that a later read overtook is dropped (2026-11-22). Only a read that came back marks the list as read (publicLoaded): a refused one does not, so it brings no line for an empty list. */
  protected async loadPublicRooms(quiet = false): Promise<void> {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    const read = ++this.roomReads;
    const search = this.roomSearch().trim();
    this.loadingRooms.set(true);
    this.findError.set(null);
    try {
      const res = await this.api.listPublicChatRooms({ search, limit: PUBLIC_ROOMS_PAGE }, quiet);
      if (read !== this.roomReads) return;
      if (res.ok) {
        this.publicRooms.set(res.body.rooms);
        this.foundFor.set(search);
        this.roomsFetched = res.body.rooms.length;
        this.moreRooms.set(res.body.rooms.length >= PUBLIC_ROOMS_PAGE);
        this.publicLoaded.set(true);
      } else {
        this.findError.set(reasonOf(res));
      }
    } catch (err) {
      if (read === this.roomReads) this.findError.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (read === this.roomReads) this.loadingRooms.set(false);
    }
  }

  /** Show more (2026-11-22): the next PUBLIC_ROOMS_PAGE rooms for the search word on the screen, added under the rooms shown. A room already shown is left out: the order goes by the number of members, which can move between two reads. The answer is dropped when a new first read was started meanwhile. */
  protected async loadMoreRooms(): Promise<void> {
    if (this.loadingRooms()) return;
    const read = this.roomReads;
    this.loadingRooms.set(true);
    this.findError.set(null);
    try {
      const res = await this.api.listPublicChatRooms({ search: this.foundFor(), limit: PUBLIC_ROOMS_PAGE, offset: this.roomsFetched });
      if (read !== this.roomReads) return;
      if (res.ok) {
        const shown = new Set(this.publicRooms().map((room) => room.chatRoomId));
        this.publicRooms.update((list) => [...list, ...res.body.rooms.filter((room) => !shown.has(room.chatRoomId))]);
        this.roomsFetched += res.body.rooms.length;
        this.moreRooms.set(res.body.rooms.length >= PUBLIC_ROOMS_PAGE);
      } else {
        this.findError.set(reasonOf(res));
      }
    } catch (err) {
      if (read === this.roomReads) this.findError.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (read === this.roomReads) this.loadingRooms.set(false);
    }
  }

  /** The name box of New public room changed (2026-11-22): ROOM_SEARCH_DEBOUNCE_MS after the last key the public rooms whose name holds what was typed are read, quietly, the biggest first, at most LIKE_NAMED_ROOMS. A read that fails shows nothing, and the hint never stops a creation. */
  protected nameTyped(text: string): void {
    this.roomName.set(text);
    if (this.nameTimer !== null) clearTimeout(this.nameTimer);
    this.nameTimer = null;
    const read = ++this.nameReads;
    const name = text.trim();
    if (!name) {
      this.likeNamed.set([]);
      return;
    }
    this.nameTimer = setTimeout(() => {
      void this.api.listPublicChatRooms({ search: name, limit: LIKE_NAMED_ROOMS }, true).then(
        (res) => {
          if (read === this.nameReads) this.likeNamed.set(res.ok ? res.body.rooms : []);
        },
        () => {
          if (read === this.nameReads) this.likeNamed.set([]);
        },
      );
    }, ROOM_SEARCH_DEBOUNCE_MS);
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
