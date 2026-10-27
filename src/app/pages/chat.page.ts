import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSelectModule } from '@angular/material/select';
import { MESSAGES_POLL_MS } from '../constants';
import { CryptoService } from '../services/crypto.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { InviteItem, JoinRequestItem, MasterpodApiService, Profile, PublicRoomItem, RoomItem } from '../services/masterpod-api.service';
import { Bytes } from '../services/passkey.service';
import { SessionService } from '../services/session.service';

/** A decrypted message of the selected room. */
interface ShownMessage {
  position: number;
  senderAnopodId: string;
  text: string;
  mine: boolean;
}

/**
 * Chat (wallet spec 8.2): the masterpod test app's chat section on Material:
 * rooms, invites by username, the join inbox, public rooms, messages polled
 * every 3 seconds. Room keys are unwrapped with the chat keys and kept in the
 * session for the tab's life.
 */
@Component({
  selector: 'app-chat-page',
  imports: [FormsModule, MatCardModule, MatButtonModule, MatListModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatExpansionModule],
  template: `
    <div class="chat">
      <mat-card appearance="outlined" class="rooms">
        <mat-card-header>
          <mat-card-title>Rooms</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          @if (!session.hasChatKeys()) {
            <p class="error">No chat keys in this tab: complete setup or unlock again.</p>
          }
          @if (error(); as text) { <p class="error">{{ text }}</p> }
          <mat-nav-list>
            @for (room of rooms(); track room.chatRoomId) {
              <a mat-list-item [activated]="room.chatRoomId === selectedRoomId()" (click)="selectRoom(room.chatRoomId)">
                <mat-icon matListItemIcon>{{ room.type === 'public' ? 'public' : room.type === 'marketplace' ? 'storefront' : 'lock' }}</mat-icon>
                <span matListItemTitle>{{ room.name ?? (room.type === 'marketplace' ? 'Listing room' : 'Private room') }}</span>
                <span matListItemLine>@for (m of room.members; track m.anopodId) {{{ m.username }} }</span>
              </a>
            } @empty {
              <p class="muted">No rooms yet.</p>
            }
          </mat-nav-list>
          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>New room</mat-panel-title></mat-expansion-panel-header>
            <div class="form">
              <mat-form-field appearance="outline"><mat-label>Type</mat-label>
                <mat-select [value]="roomType()" (valueChange)="roomType.set($event)"><mat-option value="private">private</mat-option><mat-option value="public">public</mat-option></mat-select>
              </mat-form-field>
              @if (roomType() === 'public') {
                <mat-form-field appearance="outline"><mat-label>Name</mat-label><input matInput [ngModel]="roomName()" (ngModelChange)="roomName.set($event)" /></mat-form-field>
              }
              <button mat-flat-button type="button" (click)="createRoom()" [disabled]="busy() || !session.hasChatKeys() || (roomType() === 'public' && !roomName().trim())">Create</button>
            </div>
          </mat-expansion-panel>
          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>Invites to me ({{ invites().length }})</mat-panel-title></mat-expansion-panel-header>
            @for (invite of invites(); track invite.inviteId) {
              <div class="form">
                <span>{{ invite.type }} {{ invite.name ?? '' }} from <code>{{ invite.from.username }}</code></span>
                <button mat-stroked-button type="button" (click)="acceptInvite(invite)" [disabled]="busy()">Accept</button>
                <button mat-button type="button" (click)="declineInvite(invite)" [disabled]="busy()">Decline</button>
              </div>
            } @empty { <p class="muted">None.</p> }
          </mat-expansion-panel>
          <mat-expansion-panel>
            <mat-expansion-panel-header><mat-panel-title>Join requests on my rooms ({{ joinRequests().length }})</mat-panel-title></mat-expansion-panel-header>
            @for (request of joinRequests(); track request.joinRequestId) {
              <div class="form">
                <span><code>{{ request.from.username }}</code> asks to join {{ roomLabel(request.chatRoomId) }}</span>
                <button mat-stroked-button type="button" (click)="approveJoin(request)" [disabled]="busy()">Approve</button>
                <button mat-button type="button" (click)="declineJoin(request)" [disabled]="busy()">Decline</button>
              </div>
            } @empty { <p class="muted">None.</p> }
          </mat-expansion-panel>
          <mat-expansion-panel (opened)="loadPublicRooms()">
            <mat-expansion-panel-header><mat-panel-title>Public rooms</mat-panel-title></mat-expansion-panel-header>
            @for (room of publicRooms(); track room.chatRoomId) {
              <div class="form">
                <span>{{ room.name }} by <code>{{ room.creator.username }}</code> · {{ room.memberCount }} members</span>
                <button mat-stroked-button type="button" (click)="requestToJoin(room.chatRoomId)" [disabled]="busy()">Request to join</button>
              </div>
            } @empty { <p class="muted">None.</p> }
            <button mat-button type="button" (click)="loadPublicRooms()" [disabled]="busy()">Refresh</button>
          </mat-expansion-panel>
        </mat-card-content>
        <mat-card-actions>
          <button mat-button type="button" (click)="loadRooms()" [disabled]="busy()">Refresh rooms</button>
        </mat-card-actions>
      </mat-card>

      <mat-card appearance="outlined" class="messages">
        @if (selectedRoom(); as room) {
          <mat-card-header>
            <mat-card-title>{{ room.name ?? (room.type === 'marketplace' ? 'Listing room' : 'Private room') }}</mat-card-title>
            <mat-card-subtitle>@for (m of room.members; track m.anopodId) {{{ m.username }} } · messages every 3 s</mat-card-subtitle>
          </mat-card-header>
          <mat-card-content>
            @if (isCreatorOfSelected() && room.type !== 'marketplace') {
              <div class="form">
                <mat-form-field appearance="outline"><mat-label>Invite by username</mat-label><input matInput [ngModel]="inviteName()" (ngModelChange)="inviteName.set($event)" (keyup.enter)="findInvitee()" /></mat-form-field>
                <button mat-stroked-button type="button" (click)="findInvitee()" [disabled]="busy() || !inviteName().trim()">Find</button>
                @if (inviteTarget(); as found) {
                  <span>{{ found.firstName }} {{ found.lastName }} <code>{{ found.username }}</code></span>
                  @if (found.selfie; as selfie) { <img class="selfie" [src]="'data:' + selfie.contentType + ';base64,' + selfie.image" alt="selfie" /> }
                  <button mat-flat-button type="button" (click)="invite()" [disabled]="busy()">Invite</button>
                }
              </div>
            }
            <div class="thread">
              @for (m of messages(); track m.position) {
                <div class="bubble" [class.mine]="m.mine">
                  <span class="sender">{{ senderName(room, m.senderAnopodId) }}</span>
                  <span>{{ m.text }}</span>
                </div>
              } @empty {
                <p class="muted">No messages yet.</p>
              }
            </div>
            <div class="form">
              <mat-form-field appearance="outline" class="grow"><mat-label>Message</mat-label><input matInput [ngModel]="messageText()" (ngModelChange)="messageText.set($event)" (keyup.enter)="sendMessage()" /></mat-form-field>
              <button mat-flat-button type="button" (click)="sendMessage()" [disabled]="busy() || !messageText().trim()">Send</button>
              @if (!isCreatorOfSelected()) {
                <button mat-button type="button" (click)="leaveRoom()" [disabled]="busy()">Leave</button>
              }
            </div>
          </mat-card-content>
        } @else {
          <mat-card-content><p class="muted">Select a room.</p></mat-card-content>
        }
      </mat-card>
    </div>
  `,
  styles: `
    .chat { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
    .rooms { flex: 1 1 320px; }
    .messages { flex: 2 1 420px; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
    .grow { flex: 1; min-width: 200px; }
    .thread { display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow: auto; padding: 8px 0; }
    .bubble { display: flex; flex-direction: column; max-width: 80%; padding: 8px 12px; border-radius: 12px; background: var(--mat-sys-surface-container); align-self: flex-start; }
    .bubble.mine { align-self: flex-end; background: var(--mat-sys-primary-container); }
    .sender { font-size: 11px; color: var(--mat-sys-on-surface-variant); }
    .selfie { width: 40px; height: 40px; object-fit: cover; border-radius: 50%; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
  `,
})
export class ChatPage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);

  protected readonly rooms = signal<RoomItem[]>([]);
  protected readonly invites = signal<InviteItem[]>([]);
  protected readonly joinRequests = signal<JoinRequestItem[]>([]);
  protected readonly publicRooms = signal<PublicRoomItem[]>([]);
  protected readonly selectedRoomId = signal<string | null>(null);
  protected readonly selectedRoom = computed(() => this.rooms().find((r) => r.chatRoomId === this.selectedRoomId()) ?? null);
  protected readonly isCreatorOfSelected = computed(() => this.selectedRoom()?.creatorAnopodId === this.session.anopodId());
  protected readonly roomType = signal<'private' | 'public'>('private');
  protected readonly roomName = signal('');
  protected readonly inviteName = signal('');
  protected readonly inviteTarget = signal<Profile | null>(null);
  protected readonly messages = signal<ShownMessage[]>([]);
  protected readonly messageText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private lastPosition = 0;

  constructor() {
    void this.loadRooms();
    const timer = setInterval(() => void this.pollMessages(), MESSAGES_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected roomLabel(chatRoomId: string): string {
    const room = this.rooms().find((r) => r.chatRoomId === chatRoomId);
    return room?.name ?? (room?.type === 'marketplace' ? 'the listing room' : 'the private room');
  }

  protected senderName(room: RoomItem, anopodId: string): string {
    return room.members.find((m) => m.anopodId === anopodId)?.username ?? anopodId.slice(0, 8);
  }

  /** The caller's rooms, invites and join requests; each room's key is unwrapped once and kept. */
  protected async loadRooms(): Promise<void> {
    const res = await this.api.listChatRooms(true);
    if (!res.ok) {
      this.error.set(`/list-chat-rooms: ${reasonOf(res)}`);
      return;
    }
    this.error.set(null);
    this.rooms.set(res.body.rooms);
    this.invites.set(res.body.invites);
    this.joinRequests.set(res.body.joinRequests);
    for (const room of res.body.rooms) await this.roomKeyOf(room);
    if (this.selectedRoomId() !== null && !res.body.rooms.some((r) => r.chatRoomId === this.selectedRoomId())) {
      this.selectedRoomId.set(null);
      this.messages.set([]);
    }
  }

  private async roomKeyOf(room: RoomItem): Promise<Bytes | null> {
    const cached = this.session.roomKeys.get(room.chatRoomId);
    if (cached) return cached;
    const chat = this.session.getChatKeys();
    if (!chat) return null;
    try {
      const key = await this.crypto.unwrapRoomKey(this.crypto.fromHex(room.hpkeKey), chat);
      this.session.roomKeys.set(room.chatRoomId, key);
      return key;
    } catch (err) {
      console.error(`room ${room.chatRoomId}: cannot unwrap the room key`, err);
      return null;
    }
  }

  /** A new room with a fresh room key, wrapped to this pod's own chat keys. */
  protected createRoom(): Promise<void> {
    return this.run(async () => {
      const chat = this.session.getChatKeys();
      if (!chat) throw new Error('No chat keys in this tab');
      const roomKey = this.crypto.newRoomKey();
      const hpkeKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
      const type = this.roomType();
      const res = await this.api.createChatRoom(type, type === 'public' ? this.roomName().trim() : undefined, this.crypto.toHex(hpkeKey));
      if (res.ok) {
        this.session.roomKeys.set(res.body.chatRoomId, roomKey);
        this.roomName.set('');
        await this.loadRooms();
        this.selectRoom(res.body.chatRoomId);
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

  /** The selected room's key wrapped to the found pod's chat keys, fetched from the server. */
  protected invite(): Promise<void> {
    return this.run(async () => {
      const room = this.selectedRoom();
      const target = this.inviteTarget();
      if (!room || !target) throw new Error('Select a room and find the username first');
      const hpkeKey = await this.wrapFor(room.chatRoomId, target.anopodId);
      const res = await this.api.inviteToChatRoom(room.chatRoomId, target.anopodId, hpkeKey);
      if (res.ok) {
        this.inviteName.set('');
        this.inviteTarget.set(null);
      }
      return res;
    });
  }

  protected acceptInvite(invite: InviteItem): Promise<void> {
    return this.run(async () => {
      const res = await this.api.acceptInvite(invite.inviteId);
      await this.loadRooms();
      if (res.ok) this.selectRoom(res.body.chatRoomId);
      return res;
    });
  }

  protected declineInvite(invite: InviteItem): Promise<void> {
    return this.run(async () => {
      const res = await this.api.declineInvite(invite.inviteId);
      await this.loadRooms();
      return res;
    });
  }

  protected loadPublicRooms(): Promise<void> {
    return this.run(async () => {
      const res = await this.api.listPublicChatRooms();
      if (res.ok) this.publicRooms.set(res.body.rooms);
      return res;
    });
  }

  protected requestToJoin(chatRoomId: string): Promise<void> {
    return this.run(() => this.api.requestToJoin(chatRoomId));
  }

  protected approveJoin(request: JoinRequestItem): Promise<void> {
    return this.run(async () => {
      const hpkeKey = await this.wrapFor(request.chatRoomId, request.from.anopodId);
      const res = await this.api.approveJoin(request.joinRequestId, hpkeKey);
      await this.loadRooms();
      return res;
    });
  }

  protected declineJoin(request: JoinRequestItem): Promise<void> {
    return this.run(async () => {
      const res = await this.api.declineJoin(request.joinRequestId);
      await this.loadRooms();
      return res;
    });
  }

  protected leaveRoom(): Promise<void> {
    const room = this.selectedRoom();
    if (!room) return Promise.resolve();
    return this.run(async () => {
      const res = await this.api.leaveChatRoom(room.chatRoomId);
      if (res.ok) {
        this.session.roomKeys.delete(room.chatRoomId);
        this.selectedRoomId.set(null);
        this.messages.set([]);
      }
      await this.loadRooms();
      return res;
    });
  }

  protected selectRoom(chatRoomId: string): void {
    this.selectedRoomId.set(chatRoomId);
    this.messages.set([]);
    this.lastPosition = 0;
    void this.pollMessages(false);
  }

  /** New messages of the selected room, after the last position seen, decrypted with the room key. */
  private async pollMessages(quiet = true): Promise<void> {
    const room = this.selectedRoom();
    if (!room || !this.session.hasSession() || (quiet && this.busy())) return;
    const key = await this.roomKeyOf(room);
    const res = await this.api.listMessages(room.chatRoomId, this.lastPosition, quiet);
    if (!res.ok || this.selectedRoomId() !== room.chatRoomId) return;
    const shown: ShownMessage[] = [];
    for (const m of res.body.messages) {
      let text = '(no room key)';
      if (key) {
        try {
          text = await this.crypto.decryptText(key, m.message);
        } catch {
          text = '(cannot decrypt)';
        }
      }
      shown.push({ position: m.position, senderAnopodId: m.senderAnopodId, text, mine: m.senderAnopodId === this.session.anopodId() });
      this.lastPosition = Math.max(this.lastPosition, m.position);
    }
    if (shown.length > 0) this.messages.update((list) => [...list, ...shown]);
  }

  protected sendMessage(): Promise<void> {
    return this.run(async () => {
      const room = this.selectedRoom();
      if (!room) throw new Error('Select a room first');
      const key = await this.roomKeyOf(room);
      if (!key) throw new Error('No room key for this room');
      const res = await this.api.sendMessage(room.chatRoomId, await this.crypto.encryptText(key, this.messageText().trim()));
      if (res.ok) {
        this.messageText.set('');
        await this.pollMessages(false);
      }
      return res;
    });
  }

  /** The room's key wrapped to another pod's chat keys, which /get-chat-public-keys supplies. */
  private async wrapFor(chatRoomId: string, anopodId: string): Promise<string> {
    const room = this.rooms().find((r) => r.chatRoomId === chatRoomId);
    const roomKey = room ? await this.roomKeyOf(room) : this.session.roomKeys.get(chatRoomId);
    if (!roomKey) throw new Error('No room key for this room in this tab');
    const keys = await this.api.getChatPublicKeys([anopodId]);
    const target = keys.ok ? keys.body.keys.find((k) => k.anopodId === anopodId) : undefined;
    if (!target) throw new Error('That anoPod has no chat keys (setup not complete)');
    return this.crypto.toHex(await this.crypto.wrapRoomKey(roomKey, target.chatPublicKey, target.chatPublicKeyPq));
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
