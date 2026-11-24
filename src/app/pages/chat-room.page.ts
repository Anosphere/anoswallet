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
import { RoomPictureComponent } from '../components/room-picture.component';
import { MEMBERS_PAGE, MESSAGES_PAGE, MESSAGES_POLL_MS, ROOM_PICTURE_JPEG, ROOM_PICTURE_SIDE } from '../constants';
import { redrawSquare } from '../images';
import { ChatService, Piece, piecesOf } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, MessageItem, Profile, RoomItem, RoomMember } from '../services/masterpod-api.service';
import { RoomPictureCacheService } from '../services/room-picture-cache.service';
import { SessionService } from '../services/session.service';
import { StickersService } from '../services/stickers.service';
import { Sticker, Suggestion, recentStickers, rememberSticker, stickerCode, stickerNamed, stickerSrc, suggestedStickers } from '../stickers';
import { TradeMessageKind, tradeMessageKind } from '../trade-messages';
import { REVIEW_STATUSES } from './attesting.page';

/** A decrypted message of the room, split into its pieces; `pending` while this pod's own message is on its way. */
interface ShownMessage {
  messageId: string;
  position: number;
  senderAnopodId: string;
  createdAt: string;
  pieces: Piece[];
  mine: boolean;
  pending: boolean;
  /** For the two traders of a marketplace chat (2026-11-19): what the message is when the pinned card posted it, and the thread then draws a grey line in its place; null for every other message, and always for a guest and in every other room. */
  notice: TradeMessageKind | null;
  /** The sticker the message's text names (2026-11-23, ../stickers): its whole text is a sticker's code; null for every other message. The thread draws that sticker's picture where the bubble would stand, from the code alone (pictureOf). */
  sticker: Sticker | null;
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

/** What the thread draws: a day line, a group of bubbles, or, for the two traders of a marketplace chat (2026-11-19), a grey line in the place of a message the pinned card posted. */
type ThreadItem = { kind: 'day'; key: string; label: string } | { kind: 'group'; key: string; group: Group } | { kind: 'notice'; key: string; text: string };

/** Messages this close in time by one sender share a group. */
const GROUP_MINUTES = 5;

/** A message that arrives scrolls the thread down only when the reader is this close to the bottom. */
const FOLLOW_PX = 120;

/** "Seen by" names the people who have seen a message up to this many of them; above it, it says how many they are. */
const SEEN_NAMES = 3;

/** Older messages load by themselves when the reader comes this close to the top of the thread (2026-11-22). */
const OLDER_PX = 300;

/** The Members list draws its next rows when the reader comes this close to its end (2026-11-22). */
const MORE_MEMBERS_PX = 200;

/** The Members list has its search box when the room has more than this many people, members and invited together (2026-11-22). A smaller room's list is then as high as before: in a chat with the pinned listing card on a short phone the box's 65 pixels would push the list out of sight. */
const SEARCH_ABOVE = 10;

/** Older messages are drawn only once the thread has not scrolled for this many milliseconds (2026-11-22), and is found still at rest REST_CHECK_MS later. */
const REST_MS = 150;
const REST_CHECK_MS = 40;

/**
 * One conversation (wallet spec 8.2, Chat), at /chat/:chatRoomId inside the
 * chat page's pane: a header with the back arrow (on a phone), the avatar
 * or icon, the title, the members and a menu (Invite someone for the
 * creator of a private or public room, Invite an attestor for the two
 * traders of a marketplace chat while its trade is in dispute and an
 * attestor has a case open on it, Members, Leave for a member who is not
 * the creator); the thread, opened at the room's newest MESSAGES_PAGE
 * messages with Load older messages on top while a page came back full,
 * polled every 3 seconds after the newest shown position, the messages
 * grouped by sender and five minutes with a day line between days; the
 * message box that grows to five lines (Enter sends, Shift+Enter a new
 * line) and the round Send. A sent message shows at once as a pale bubble
 * marked "Sending" and gets its tick from the answer. Room keys come from
 * ChatService; an account id in a message shows in code font with a copy
 * button (8.5). The room is marked seen when it opens and when new
 * messages show. A private room about a listing shows its two traders the
 * pinned listing card (8.7) between the header and the thread, fed with
 * the account ids found in the messages (2026-11-06); anyone else in such
 * a room is a guest and gets no card (2026-11-12). The card tells the page
 * the open dispute case of the chat's trade, and with one the menu has
 * Invite an attestor: a panel with the attestors on that case, each with
 * Invite, which brings the attestor into the chat, where they read
 * everything (2026-11-12). The two traders of such a chat read each of
 * the three messages the card posts (trade-messages.ts) as a short grey
 * line with no account id: "You sent your account for this trade." or
 * "mai sent their account for this trade." for the buyer's account,
 * "Trade update. Look at the box at the top of this chat." for a trade
 * started or released; and for them an account id in any other message
 * has no copy button. A guest reads the messages as they are, with the
 * copy button (2026-11-19, forclaude/wallet-chat-and-passkey-plan-1.md).
 * Under this pod's own messages stands a word (2026-11-19, the same
 * plan): "Seen" under the newest one that another member has seen, "Seen
 * by" with the usernames when the room has more than one other member,
 * and "Sent" under the newest one while nobody has seen it yet. The
 * members' seen positions come with /list-chat-rooms. While the
 * conversation is on the screen the page tells the masterpod how far
 * this pod has read (/mark-messages-seen, masterpod spec 21): after
 * opening, after each poll and after a send, and never from a hidden
 * tab. The seen mark of the sentence further up is another thing: this
 * device's own list, for the unread dot. Since 2026-11-22 the Members
 * list is at most half the conversation high and its rows scroll inside
 * it; it draws MEMBERS_PAGE people, the members before the invited, and
 * as many more each time the reader comes near its end; and in a room of
 * more than SEARCH_ABOVE people a box on top of it, Search members,
 * narrows it to the usernames that hold what was typed. Since that day,
 * too, older messages load by themselves when the reader comes within
 * OLDER_PX of the thread's top, and Load older messages stays for a
 * thread that does not fill its frame and after a read that failed; they
 * are drawn once the thread is at rest, and the reader's place is kept
 * by the distance to the thread's end. Since 2026-11-22, too
 * (forclaude/public-rooms-plan-1.md), a public room that has a picture
 * shows it at the conversation's top, round, where the kind's icon stood
 * (<app-room-picture>, wallet spec 8.6); and for the creator of a public
 * room the menu has Room picture, under Members. It opens a panel under
 * the header, or closes it: the picture at 72 pixels, one sentence on
 * what the picture is and who sees it, and a file box. A picked photo is
 * sent at once, as the middle of it in a square of at most
 * ROOM_PICTURE_SIDE pixels (/set-chat-room-picture, masterpod spec 27);
 * the creator can put another in its place the same way, and cannot take
 * the picture away. Since 2026-11-23
 * (forclaude/stickers-database-plan-1.md; wallet spec 4.16) a message
 * whose whole text is a sticker's code (../stickers) shows as that
 * sticker's picture, with no bubble around it. The picture's address is
 * made of the code alone, so a sticker is drawn whether or not the
 * wallet has the list of the sets; where the picture cannot be fetched,
 * the word "Sticker" stands in a bubble in its place, until the
 * conversation is opened again. The list of the sets is asked of the
 * masterpod once after each login, when a conversation is first opened
 * (stickers.service.ts). While that list holds at least one set, a
 * stickers button, a smiling face, stands in front of the message box.
 * It opens a panel under the message box, or closes it. At the panel's
 * top stands a row of small pictures, one for each set: the set's first
 * sticker. Under the row stand the stickers of the set that was tapped,
 * and no other set's pictures are on the page. Once a sticker has been
 * sent from this phone, a clock stands first in the row: the stickers
 * sent lately, the newest first, as the phone keeps them. A tap on a
 * sticker sends it at once, and the panel stays open. A tap into the
 * message box closes the panel. While the panel is open, the pinned
 * listing card of a marketplace chat is out of sight, so that the
 * messages keep their room; it is back, as it was, when the panel
 * closes. While a person types and the panel is closed, a strip above
 * the message box shows the stickers that fit the end of the text, at
 * most four (suggestedStickers in ../stickers); a tap on one sends it
 * and takes the word that brought it up out of the message box. The
 * cursor stays in the message box through that tap (the button's
 * mousedown is told not to move it), so a phone's keyboard stays up and
 * the person can go on typing. Without that, Safari on an iPhone took
 * the cursor out of the box at the tap, and, as the tapped sticker left
 * the page with its strip, marked a word of the top bar as selected. A
 * reader at the thread's end stays there when the strip comes up.
 */
@Component({
  selector: 'app-chat-room-page',
  imports: [FormsModule, RouterLink, TextFieldModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatMenuModule, AvatarComponent, CopyButtonComponent, PinnedListingComponent, RoomPictureComponent],
  template: `
    @if (room(); as room) {
      <header class="head">
        <a mat-icon-button class="back" routerLink="/chat" [attr.aria-label]="t().common.backToChats"><mat-icon>arrow_back</mat-icon></a>
        @if (chat.otherPerson(room); as other) {
          <app-avatar [anopodId]="other.anopodId" [username]="other.username" />
        } @else {
          <app-room-picture [chatRoomId]="room.chatRoomId" [pictureAt]="room.pictureAt" [icon]="chat.icon(room)" />
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
          @if (chat.isTrader(room) && disputeCaseId() !== null) {
            <button mat-menu-item type="button" (click)="toggleAttestors()" [disabled]="busy()"><mat-icon>fact_check</mat-icon><span>{{ t().chatRoom.inviteAttestor }}</span></button>
          }
          <button mat-menu-item type="button" (click)="toggleMembers()"><mat-icon>group</mat-icon><span>{{ t().chatRoom.members }}</span></button>
          @if (isCreator() && room.type === 'public') {
            <button mat-menu-item type="button" (click)="showPicture.set(!showPicture())"><mat-icon>image</mat-icon><span>{{ t().chatRoom.roomPicture }}</span></button>
          }
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
      @if (showPicture()) {
        <div class="panel form">
          <app-room-picture [chatRoomId]="room.chatRoomId" [pictureAt]="room.pictureAt" [size]="72" />
          <span class="muted picture-what">{{ t().chatRoom.pictureWhat }}</span>
          <input type="file" accept="image/*" (change)="pictureChosen($event)" [disabled]="busy()" />
        </div>
      }
      @if (showAttestors()) {
        <div class="panel members">
          <span class="muted">{{ t().chatRoom.attestorReads }}</span>
          @for (attestor of attestors(); track attestor.anopodId) {
            <span class="member">
              <app-avatar [anopodId]="attestor.anopodId" [username]="attestor.username" /> {{ attestor.username }}
              <button mat-flat-button type="button" (click)="inviteAttestor(attestor)" [disabled]="busy()">{{ t().chatRoom.invite }}</button>
            </span>
          } @empty {
            <span class="muted">{{ t().chatRoom.attestorsIn }}</span>
          }
        </div>
      }
      @if (showMembers()) {
        <div class="panel people">
          @if (searchable()) {
            <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().chatRoom.searchMembers }}</mat-label><input matInput [ngModel]="memberSearch()" (ngModelChange)="searchMembers($event)" /></mat-form-field>
          }
          <div class="members" #membersBox>
            @for (m of shownMembers(); track m.anopodId) {
              <span class="member"><app-avatar [anopodId]="m.anopodId" [username]="m.username" [size]="28" /> {{ m.username }}</span>
            }
            @for (m of shownInvited(); track m.anopodId) {
              <span class="member"><app-avatar [anopodId]="m.anopodId" [username]="m.username" [size]="28" /> {{ m.username }} <span class="muted">{{ t().chatRoom.invited }}</span></span>
            }
            @if (nobodyFound()) {
              <span class="muted">{{ t().chatRoom.noMembersFound }}</span>
            }
          </div>
        </div>
      }
      @if (chat.isTrader(room)) {
        <app-pinned-listing [class.away]="showStickers()" [room]="room" [accountIds]="accountIds()" (disputeCase)="setDisputeCase($event)" />
      }
      <div class="thread" #threadBox>
        @if (canLoadOlder()) {
          <button mat-button type="button" class="older" (click)="loadOlder()" [disabled]="busy()">{{ t().chatRoom.loadOlder }}</button>
        }
        @for (item of thread(); track item.key) {
          @if (item.kind === 'day') {
            <div class="day"><span>{{ item.label }}</span></div>
          } @else if (item.kind === 'notice') {
            <div class="notice"><span>{{ item.text }}</span></div>
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
                  <div class="bubble" [class.pending]="m.pending" [class.sticker]="pictureOf(m) !== null">
                    @if (pictureOf(m); as picture) {
                      <img [src]="picture" [alt]="t().chatRoom.sticker" width="148" height="128" (error)="pictureFailed(picture)" />
                    } @else if (m.sticker) {
                      <span class="text">{{ t().chatRoom.sticker }}</span>
                    } @else {
                      <span class="text">
                        @for (piece of m.pieces; track $index) {
                          @if (piece.accountId) {
                            <code>{{ piece.text }}</code>
                            @if (!trader()) {
                              <app-copy-button [text]="piece.text" [label]="t().common.copyAccountId" />
                            }
                          } @else {
                            <span class="plain">{{ piece.text }}</span>
                          }
                        }
                      </span>
                    }
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
                  @if (marks().get(m.messageId); as mark) {
                    <span class="mark">{{ mark }}</span>
                  }
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
      @if (suggested().length > 0) {
        <div class="suggested">
          @for (s of suggested(); track s.sticker.set + '/' + s.sticker.number) {
            <button type="button" class="cell" (mousedown)="$event.preventDefault()" (click)="sendSuggested(s)" [disabled]="busy()" [attr.aria-label]="t().chatRoom.sticker"><img [src]="stickerSrc(s.sticker)" alt="" /></button>
          }
        </div>
      }
      <div class="composer">
        @if (stickerSets().length > 0) {
          <button mat-icon-button type="button" class="stickers-button" (click)="toggleStickers()" [attr.aria-label]="t().chatRoom.stickers" [attr.aria-expanded]="showStickers()"><mat-icon>mood</mat-icon></button>
        }
        <mat-form-field appearance="outline" class="grow" subscriptSizing="dynamic">
          <mat-label>{{ t().chatRoom.message }}</mat-label>
          <textarea matInput cdkTextareaAutosize cdkAutosizeMinRows="1" cdkAutosizeMaxRows="5" [ngModel]="messageText()" (ngModelChange)="messageText.set($event)" (keydown.enter)="enter($event)" (focus)="closeStickers()"></textarea>
        </mat-form-field>
        <button mat-mini-fab type="button" class="send" (click)="send()" [disabled]="busy() || !messageText().trim()" [attr.aria-label]="t().common.send"><mat-icon>send</mat-icon></button>
      </div>
      @if (showStickers()) {
        <div class="stickers">
          <div class="sets">
            @if (recentShown().length > 0) {
              <button type="button" class="set" [class.on]="stickerTab() === ''" (click)="pickStickerTab('')" [attr.aria-label]="t().chatRoom.stickersSentLately"><mat-icon>schedule</mat-icon></button>
            }
            @for (set of stickerSets(); track set.name) {
              <button type="button" class="set" [class.on]="stickerTab() === set.name" (click)="pickStickerTab(set.name)" [attr.aria-label]="t().chatRoom.stickerSet"><img [src]="set.src" alt="" /></button>
            }
          </div>
          <div class="grid" #stickerGrid>
            @for (sticker of tabStickers(); track sticker.set + '/' + sticker.number) {
              <button type="button" class="cell" (click)="tapSticker(sticker)" [disabled]="busy()" [attr.aria-label]="t().chatRoom.sticker"><img [src]="stickerSrc(sticker)" alt="" /></button>
            }
          </div>
        </div>
      }
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
    .panel { padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .picture-what { flex: 1; min-width: 200px; }
    .form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .members { display: flex; flex-direction: column; gap: 6px; }
    .member { display: inline-flex; align-items: center; gap: 8px; }
    .people { flex: none; display: flex; flex-direction: column; gap: 8px; max-height: 50%; }
    .people .members { flex: 1; min-height: 0; overflow-y: auto; }
    .selfie { width: 40px; height: 40px; object-fit: cover; border-radius: 50%; }
    .thread { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
    .older { align-self: center; }
    .day { display: flex; justify-content: center; margin: 8px 0 0; }
    .day span { font-size: 12px; color: var(--mat-sys-on-surface-variant); background: var(--mat-sys-surface-container); border-radius: 10px; padding: 2px 10px; }
    .notice { display: flex; justify-content: center; }
    .notice span { font-size: 12px; color: var(--mat-sys-on-surface-variant); text-align: center; }
    .group { display: flex; align-items: flex-end; gap: 8px; max-width: 80%; align-self: flex-start; }
    .group.mine { align-self: flex-end; }
    .face { margin-bottom: 18px; }
    .bubbles { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
    .group.mine .bubbles { align-items: flex-end; }
    .bubble { padding: 8px 12px; border-radius: 16px; background: var(--mat-sys-surface-container); overflow-wrap: anywhere; }
    .group.mine .bubble { background: var(--mat-sys-primary-container); }
    .bubble.pending { opacity: 0.6; }
    .bubble code { font-size: 12px; word-break: break-all; }
    .bubble.sticker, .group.mine .bubble.sticker { display: flex; align-items: flex-end; padding: 0; background: none; }
    .bubble.sticker img { display: block; width: 148px; height: 128px; object-fit: contain; object-position: left bottom; }
    .group.mine .bubble.sticker img { object-position: right bottom; }
    .plain { white-space: pre-wrap; }
    .state { display: inline-flex; align-items: center; margin-left: 6px; font-size: 11px; color: var(--mat-sys-on-surface-variant); vertical-align: bottom; }
    .tick { font-size: 14px; width: 14px; height: 14px; }
    .mark { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 0 8px 2px; }
    .sender { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 0 0 2px 8px; }
    .time { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 2px 8px 0; }
    .composer { display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .grow { flex: 1; min-width: 0; }
    .send { flex: none; margin-bottom: 4px; }
    .stickers-button { flex: none; margin-bottom: 4px; }
    .suggested { flex: none; display: flex; gap: 4px; overflow-x: auto; padding: 4px 12px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .suggested .cell { flex: none; width: 72px; }
    .stickers { flex: 0 1 284px; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--mat-sys-outline-variant); }
    .sets { flex: none; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; padding: 6px 0 2px 12px; }
    .sets::after { content: ''; flex: none; width: 8px; }
    .set { flex: 0 0 calc(100% / 6.5 - 4px); height: 44px; display: flex; align-items: center; justify-content: center; border: 0; padding: 3px; border-radius: 10px; background: none; color: var(--mat-sys-on-surface-variant); cursor: pointer; }
    .set.on { background: var(--mat-sys-surface-container-high); }
    .set img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); align-content: start; gap: 4px; padding: 8px 12px; }
    .cell { aspect-ratio: 37 / 32; border: 0; padding: 4px; border-radius: 12px; background: none; cursor: pointer; }
    .cell img { display: block; width: 100%; height: 100%; object-fit: contain; }
    app-pinned-listing.away { display: none; }
    .note { padding: 12px; margin: 0; }
    .empty { text-align: center; margin: auto; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 839px) {
      .back { display: inline-flex; }
    }
    @media (max-height: 640px) {
      .stickers { flex-basis: 202px; }
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
  private readonly pictures = inject(RoomPictureCacheService);
  private readonly injector = inject(Injector);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  private readonly threadBox = viewChild<ElementRef<HTMLElement>>('threadBox');
  private readonly membersBox = viewChild<ElementRef<HTMLElement>>('membersBox');

  /** True once the room list has arrived; the room is the one of the route, null when the pod is not in it. */
  protected readonly loaded = computed(() => this.session.chatRooms() !== null);
  protected readonly room = computed(() => this.session.chatRooms()?.rooms.find((r) => r.chatRoomId === this.chatRoomId()) ?? null);
  protected readonly isCreator = computed(() => this.room()?.creatorAnopodId === this.session.anopodId());
  protected readonly canInvite = computed(() => this.isCreator() && this.room()?.type !== 'marketplace');
  /** True for the two traders of a marketplace chat (2026-11-19): they read the card's messages as grey lines, and an account id in a message has no copy button. */
  protected readonly trader = computed(() => {
    const room = this.room();
    return room !== null && this.chat.isTrader(room);
  });
  protected readonly messages = signal<ShownMessage[]>([]);
  protected readonly canLoadOlder = signal(false);
  protected readonly showInvite = signal(false);
  protected readonly showMembers = signal(false);
  /** The menu's Room picture opens the panel, or closes it (2026-11-22). */
  protected readonly showPicture = signal(false);
  /** The list of the sets of stickers, asked of the masterpod once after each login (2026-11-23, stickers.service.ts). */
  private readonly stickers = inject(StickersService);
  /** The row of sets at the top of the stickers panel (2026-11-23, ../stickers): each set's name and its small picture, which is the set's first sticker (a set of the list has at least one). Empty while this login's list has not arrived and while the masterpod has no set: the message box then has no stickers button. */
  protected readonly stickerSets = computed(() => this.stickers.sets().map((set) => ({ name: set.name, src: stickerSrc({ set: set.name, number: set.stickers[0].number }) })));
  protected readonly stickerSrc = stickerSrc;
  private readonly stickerGrid = viewChild<ElementRef<HTMLElement>>('stickerGrid');
  /** The addresses of the stickers' pictures that failed to load in the thread since the conversation was opened (2026-11-23): the thread writes the word "Sticker" in a bubble in the place of each. Emptied when a conversation opens, so every picture is tried again then. */
  private readonly failedPictures = signal<ReadonlySet<string>>(new Set());
  /** The stickers button opens the panel under the message box, or closes it (2026-11-23). */
  protected readonly showStickers = signal(false);
  /** Which part of the panel shows (2026-11-23): a set's name, or '' for the stickers sent lately. */
  protected readonly stickerTab = signal('');
  /** The stickers sent lately from this phone, the newest first, as they stood when the panel was opened (2026-11-23). The clock stands in the row of sets only while this holds a sticker. A sticker sent while the panel is open joins it at the next opening, so that nothing moves under a finger. */
  protected readonly recentShown = signal<Sticker[]>([]);
  /** The stickers of the part that shows: the ones sent lately, or the tapped set's in the set's own order. */
  protected readonly tabStickers = computed<Sticker[]>(() => {
    const tab = this.stickerTab();
    if (tab === '') return this.recentShown();
    return (this.stickers.sets().find((set) => set.name === tab)?.stickers ?? []).map((entry) => ({ set: tab, number: entry.number }));
  });
  /** The stickers sent lately from this phone, the newest first (2026-11-23): read when this login's list arrives, when the stickers panel opens and after every sticker this page sends. The suggestions put them first. */
  private readonly sentLately = signal<Sticker[]>([]);
  /** The stickers suggested for what stands in the message box (2026-11-23, suggestedStickers in ../stickers): the strip above the message box draws them. None while the stickers panel is open: the panel then holds every sticker, and the thread keeps its room. */
  protected readonly suggested = computed(() => (!this.showStickers() ? suggestedStickers(this.stickers.sets(), this.messageText(), this.sentLately()) : []));
  /** True while the strip of suggestions shows (2026-11-23). */
  private readonly stripShown = computed(() => this.suggested().length > 0);
  protected readonly inviteName = signal('');
  protected readonly inviteTarget = signal<Profile | null>(null);
  protected readonly messageText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True when the room has more than SEARCH_ABOVE people, members and invited together: the Members list then has its search box (2026-11-22). */
  protected readonly searchable = computed(() => {
    const room = this.room();
    return room !== null && room.members.length + room.invited.length > SEARCH_ABOVE;
  });
  /** What the search box of the Members list holds (2026-11-22). */
  protected readonly memberSearch = signal('');
  /** How many rows the Members list draws: MEMBERS_PAGE when it opens and after each change of the search box, and MEMBERS_PAGE more each time the reader comes near its end (2026-11-22). */
  private readonly membersShown = signal(MEMBERS_PAGE);
  /** The room's members and its invited whose username holds what the search box holds, capitals aside; all of them while the box is empty, and in a room that has no search box (2026-11-22). */
  private readonly foundPeople = computed(() => {
    const room = this.room();
    const text = this.searchable() ? this.memberSearch().trim().toLowerCase() : '';
    const holds = (m: RoomMember) => text === '' || m.username.toLowerCase().includes(text);
    return { members: room ? room.members.filter(holds) : [], invited: room ? room.invited.filter(holds) : [] };
  });
  /** The rows the Members list draws (2026-11-22): the first membersShown of the found people, the members before the invited. */
  protected readonly shownMembers = computed(() => this.foundPeople().members.slice(0, this.membersShown()));
  protected readonly shownInvited = computed(() => this.foundPeople().invited.slice(0, Math.max(0, this.membersShown() - this.foundPeople().members.length)));
  /** True when the search box holds something that no member's and no invited person's username holds: the list then says so (2026-11-22). */
  protected readonly nobodyFound = computed(() => this.foundPeople().members.length + this.foundPeople().invited.length === 0);

  /** The open dispute case of the chat's trade, as the pinned card tells it (2026-11-12): null when the chat's trade is not in dispute or no attestor has a case open on it, and emptied when the room changes. "Invite an attestor" shows only with one. */
  protected readonly disputeCaseId = signal<string | null>(null);
  protected readonly showAttestors = signal(false);
  /** The attestors the masterpod names on the dispute case (the dispute's `attestors` of /list-my-cases), as read when the attestors panel was last opened. */
  private readonly namedAttestors = signal<RoomMember[]>([]);
  /** The attestors on the dispute case who can be invited: the ones the masterpod names and, with them, the ones who have a chat with this pod about the case, each once, without those who are a member of this room or invited to it. */
  protected readonly attestors = computed<RoomMember[]>(() => {
    const room = this.room();
    const caseId = this.disputeCaseId();
    if (!room || caseId === null) return [];
    const here = new Set([...room.members, ...room.invited].map((m) => m.anopodId));
    const found = new Map<string, RoomMember>();
    for (const attestor of [...this.namedAttestors(), ...this.chat.caseAttestors(caseId)]) {
      if (!here.has(attestor.anopodId) && !found.has(attestor.anopodId)) found.set(attestor.anopodId, attestor);
    }
    return [...found.values()];
  });

  /** The messages as the thread draws them: a day line before each day, the messages of one sender within GROUP_MINUTES in one group, and for the two traders of a marketplace chat (2026-11-19) a grey line in the place of each message the pinned card posted, which ends the group before it. */
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
      if (m.notice) {
        items.push({ kind: 'notice', key: m.messageId, text: this.noticeText(room, m) });
        group = null;
        continue;
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

  /**
   * The word under this pod's own messages (2026-11-19), by message id.
   * "Seen" under the newest one that another member has seen, by the seen
   * positions of /list-chat-rooms; with more than one other member, "Seen
   * by" and the usernames of those who have, and above SEEN_NAMES of them
   * how many they are. "Sent" under the newest one when nobody has seen it
   * yet, a person who is only invited so far among them. A message drawn
   * as a grey line carries none. Empty in a room with nobody else in it
   * and nobody invited, and while no member carries a seen position, this
   * pod among them: a masterpod of before.
   */
  protected readonly marks = computed(() => {
    const marks = new Map<string, string>();
    const room = this.room();
    if (!room || room.members.every((m) => m.seenPosition === undefined)) return marks;
    const me = this.session.anopodId();
    const others = room.members.filter((m) => m.anopodId !== me);
    if (others.length === 0 && room.invited.length === 0) return marks;
    const mine = this.messages().filter((m) => m.mine && !m.pending && !m.notice);
    if (mine.length === 0) return marks;
    const words = this.t().chatRoom;
    const newest = mine[mine.length - 1];
    const seen = [...mine].reverse().find((m) => others.some((o) => (o.seenPosition ?? 0) >= m.position));
    if (seen) {
      const readers = others.filter((o) => (o.seenPosition ?? 0) >= seen.position).map((o) => o.username);
      marks.set(seen.messageId, others.length === 1 ? words.seen : readers.length > SEEN_NAMES ? words.seenByCount(readers.length) : words.seenBy(readers.join(', ')));
    }
    if (seen !== newest) marks.set(newest.messageId, words.sent);
    return marks;
  });

  /** The room the thread shows, whether its opening read is done, and the positions of the oldest and newest shown. */
  private openedFor: string | null = null;
  private ready = false;
  private oldest = 0;
  private newest = 0;
  /** The newest position this page told the masterpod it has seen, for the room it shows; 0 when none. */
  private toldSeen = 0;
  /** True once the masterpod answered 404 to /mark-messages-seen: a masterpod of before. This page then tells nothing more for as long as it lives. */
  private seenOff = false;
  private pendingCount = 0;
  /** True while the next arrival near the top of the thread loads older messages (2026-11-22): set when the room opens and each time the reader is further than OLDER_PX from the top, cleared when such a load starts. So a load that fails is not asked for again until the reader has left the top and come back. */
  private olderArmed = true;
  /** When the thread last scrolled, by the page's clock (performance.now); 0 before its first scroll (2026-11-22). */
  private scrolledAt = 0;

  constructor() {
    // The route's room, once the list has it: opened when it changes.
    effect(() => {
      const room = this.room();
      if (!room || room.chatRoomId === this.openedFor) return;
      this.openedFor = room.chatRoomId;
      untracked(() => void this.open(room));
    });
    const timer = setInterval(() => void this.poll(true).then(() => this.tellSeen()), MESSAGES_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // The thread and the Members list are listened to as they scroll (2026-11-22), each while it is drawn. The listeners are the browser's own, not the template's, so a scroll alone draws nothing again.
    effect((onCleanup) => {
      const el = this.threadBox()?.nativeElement;
      if (!el) return;
      const scrolled = () => this.threadScrolled(el);
      el.addEventListener('scroll', scrolled, { passive: true });
      onCleanup(() => el.removeEventListener('scroll', scrolled));
    });
    effect((onCleanup) => {
      const el = this.membersBox()?.nativeElement;
      if (!el) return;
      const scrolled = () => this.membersScrolled(el);
      el.addEventListener('scroll', scrolled, { passive: true });
      onCleanup(() => el.removeEventListener('scroll', scrolled));
    });
    // The strip of suggestions takes its height from the thread (2026-11-23). A reader who is at the thread's end when the strip comes up stays there.
    effect(() => {
      if (!this.stripShown()) return;
      untracked(() => {
        if (this.nearBottom()) this.scrollToBottom();
      });
    });
    // This login's list of the sets of stickers arrived (2026-11-23, stickers.service.ts): the stickers sent lately from this phone are read, since only the ones the list has count.
    effect(() => {
      const sets = this.stickers.sets();
      untracked(() => this.sentLately.set(recentStickers(sets)));
    });
  }

  /** The menu's Members opens the list, or closes it. It opens with an empty search box and its first MEMBERS_PAGE rows (2026-11-22). */
  protected toggleMembers(): void {
    this.memberSearch.set('');
    this.membersShown.set(MEMBERS_PAGE);
    this.showMembers.set(!this.showMembers());
  }

  /** The search box of the Members list changed (2026-11-22): the list starts again at its top with the first MEMBERS_PAGE of the people found. */
  protected searchMembers(text: string): void {
    this.memberSearch.set(text);
    this.membersShown.set(MEMBERS_PAGE);
    const el = this.membersBox()?.nativeElement;
    if (el) el.scrollTop = 0;
  }

  /** The Members list scrolled (2026-11-22): within MORE_MEMBERS_PX of its end it draws MEMBERS_PAGE more rows, while people are left to draw. */
  private membersScrolled(el: HTMLElement): void {
    if (el.scrollHeight - el.scrollTop - el.clientHeight > MORE_MEMBERS_PX) return;
    const found = this.foundPeople();
    if (this.membersShown() < found.members.length + found.invited.length) this.membersShown.update((shown) => shown + MEMBERS_PAGE);
  }

  /** The thread scrolled (2026-11-22): when the reader comes within OLDER_PX of its top, the page does what Load older messages does, once per arrival there (olderArmed). Not while another action runs: the next scroll near the top asks again. */
  private threadScrolled(el: HTMLElement): void {
    this.scrolledAt = performance.now();
    if (el.scrollTop > OLDER_PX) {
      this.olderArmed = true;
      return;
    }
    if (!this.olderArmed || !this.canLoadOlder() || this.busy()) return;
    this.olderArmed = false;
    void this.loadOlder();
  }

  /**
   * Ends once the thread is at rest (2026-11-22): it has not scrolled for
   * REST_MS, and has still not scrolled REST_CHECK_MS after that was first
   * found, so a scroll that the browser had not yet told the page of is
   * waited for too. Older messages are drawn only then. While a thread
   * still glides after a flick, Safari on iOS 27 goes on gliding from the
   * place it had before they were drawn: the reader lands 50 messages
   * further back, still near the top, and the next page loads at once.
   */
  private async threadAtRest(): Promise<void> {
    let found = false;
    for (;;) {
      const still = performance.now() - this.scrolledAt;
      if (still < REST_MS) {
        found = false;
        await new Promise((done) => setTimeout(done, REST_MS - still));
      } else if (found) {
        return;
      } else {
        found = true;
        await new Promise((done) => setTimeout(done, REST_CHECK_MS));
      }
    }
  }

  protected senderName(room: RoomItem, anopodId: string): string {
    return room.members.find((m) => m.anopodId === anopodId)?.username ?? anopodId.slice(0, 8);
  }

  /** The members' usernames, then the invited as "(invited)". */
  protected membersLine(room: RoomItem): string {
    return [...room.members.map((m) => m.username), ...room.invited.map((m) => this.t().rooms.invited(m.username))].join(', ');
  }

  /** The grey line a trader reads in place of a message the pinned card posted (2026-11-19): for the buyer's account, who sent it; for the news of the trade, where to look. It never says that anos are in escrow: only the card's status box says that, and it reads the validators. */
  private noticeText(room: RoomItem, m: ShownMessage): string {
    const words = this.t().chatRoom;
    if (m.notice === 'trade') return words.tradeUpdate;
    return m.mine ? words.youSentAccount : words.theySentAccount(this.senderName(room, m.senderAnopodId));
  }

  /** Enter sends; Shift+Enter is left to the textarea, a new line. */
  protected enter(event: Event): void {
    if ((event as KeyboardEvent).shiftKey) return;
    event.preventDefault();
    void this.send();
  }

  /** The address of the picture the thread draws for a message (2026-11-23): the message is a sticker (`sticker`), and its picture has not failed to load since the conversation was opened. Null for every other message, and for a sticker whose picture failed: the thread then writes the word "Sticker" in a bubble. */
  protected pictureOf(m: ShownMessage): string | null {
    if (!m.sticker) return null;
    const src = stickerSrc(m.sticker);
    return this.failedPictures().has(src) ? null : src;
  }

  /** A sticker's picture in the thread could not be fetched, or is no picture (2026-11-23): the word "Sticker" takes its place, in every message that is that sticker. */
  protected pictureFailed(src: string): void {
    this.failedPictures.update((failed) => new Set(failed).add(src));
  }

  /** The stickers button (2026-11-23): opens the panel under the message box, or closes it. Opening takes the cursor out of the message box, so a phone's keyboard goes away and the panel stands in its place; a reader who was at the thread's end stays there. The first opening shows the stickers sent lately when this phone has some, and the first set when it has none; a later opening shows the part that was left, and the first set when the set that was left is not in the list. */
  protected toggleStickers(): void {
    if (this.showStickers()) {
      this.closeStickers();
      return;
    }
    const sets = this.stickers.sets();
    if (sets.length === 0) return;
    const follow = this.nearBottom();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const recent = recentStickers(sets);
    this.sentLately.set(recent);
    this.recentShown.set(recent);
    const tab = this.stickerTab();
    if (tab === '' ? recent.length === 0 : !sets.some((set) => set.name === tab)) this.stickerTab.set(sets[0].name);
    this.showStickers.set(true);
    if (follow) this.scrollToBottom();
  }

  /** Closes the stickers panel (2026-11-23): by the stickers button, by a tap into the message box, and when the room changes. */
  protected closeStickers(): void {
    this.showStickers.set(false);
  }

  /** A tap in the row of sets (2026-11-23): the panel shows that set's stickers, or the ones sent lately for the clock, from their first row. */
  protected pickStickerTab(tab: string): void {
    this.stickerTab.set(tab);
    this.stickerGrid()?.nativeElement.scrollTo({ top: 0 });
  }

  /** A tap on a sticker in the panel sends it at once (2026-11-23). Nothing while another action runs. */
  protected tapSticker(sticker: Sticker): void {
    if (this.busy()) return;
    void this.send(sticker);
  }

  /** A tap on a suggested sticker (2026-11-23) sends it, and the word that brought it up leaves the message box; whatever stood in front of that word stays. Nothing while another action runs. */
  protected sendSuggested(suggestion: Suggestion): void {
    if (this.busy()) return;
    const text = this.messageText();
    this.messageText.set(text.slice(0, text.length - suggestion.cut));
    void this.send(suggestion.sticker);
  }

  /** The room's newest page; whatever was shown before is dropped. Since 2026-11-23 the list of the sets of stickers is asked for here, which asks the masterpod only when this login has no list yet (stickers.service.ts). */
  private async open(room: RoomItem): Promise<void> {
    this.ready = false;
    this.messages.set([]);
    this.oldest = 0;
    this.newest = 0;
    this.toldSeen = 0;
    this.olderArmed = true;
    this.canLoadOlder.set(false);
    this.showInvite.set(false);
    this.showMembers.set(false);
    this.showPicture.set(false);
    this.closeStickers();
    this.failedPictures.set(new Set());
    this.inviteTarget.set(null);
    this.setDisputeCase(null);
    this.error.set(null);
    void this.stickers.load();
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
    void this.tellSeen();
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
        await this.threadAtRest();
        if (this.openedFor !== room.chatRoomId) return res;
        const el = this.threadBox()?.nativeElement;
        // How far the reader is from the thread's end; the same distance is set again once the older messages are drawn (2026-11-22). A browser that has kept the place by itself is then moved by nothing.
        const fromEnd = el ? el.scrollHeight - el.scrollTop : 0;
        this.oldest = shown[0].position;
        this.messages.update((list) => [...shown, ...list.filter((m) => !shown.some((s) => s.messageId === m.messageId))]);
        afterNextRender(
          () => {
            if (el) el.scrollTop = el.scrollHeight - fromEnd;
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

  /**
   * Tells the masterpod how far this pod has read in the room (2026-11-19,
   * masterpod spec 21): the newest position shown, when it is above what
   * this page told before, and only while the page is on the screen
   * (document.visibilityState is visible), so a chat left open in a
   * hidden tab does not say Seen. A call that fails is made again at the
   * timer's next tick. A 404, a masterpod of before, ends the telling.
   */
  private async tellSeen(): Promise<void> {
    const room = this.room();
    if (!room || !this.ready || this.seenOff || this.openedFor !== room.chatRoomId) return;
    if (document.visibilityState !== 'visible' || this.newest <= this.toldSeen) return;
    const position = this.newest;
    this.toldSeen = position;
    const res = await this.api.markMessagesSeen(room.chatRoomId, position);
    if (res.ok) return;
    if (res.status === 404) this.seenOff = true;
    else if (this.openedFor === room.chatRoomId && this.toldSeen === position) this.toldSeen = 0;
  }

  /** The messages decrypted with the room key and split into pieces; the two reasons a text cannot show, as before. For the two traders of a marketplace chat (2026-11-19) each message also says what it is when the pinned card posted it (`notice`, from tradeMessageKind); null for every other message. Since 2026-11-23 each message also says which sticker its text names (`sticker`, from stickerNamed in ../stickers); null for every other message. */
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
        notice: this.chat.isTrader(room) ? tradeMessageKind(text) : null,
        sticker: stickerNamed(text),
      });
    }
    return list;
  }

  /**
   * The message shows at once as a pending bubble and the box empties; the
   * answer gives the bubble its id and position, and the poll that follows
   * brings in whatever else arrived. A refusal, or a key that fails, takes
   * the bubble away and puts the text back. With a sticker (2026-11-23)
   * the message is that sticker's code, and send() leaves the message box
   * as it is. A sticker that went through is noted as sent lately
   * (rememberSticker in ../stickers).
   */
  protected send(sticker: Sticker | null = null): Promise<void> {
    const text = sticker ? stickerCode(sticker) : this.messageText().trim();
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
        notice: null,
        sticker,
      };
      this.messages.update((list) => [...list, pending]);
      if (!sticker) this.messageText.set('');
      this.scrollToBottom();
      let res: ApiResponse<{ messageId: string; position: number }>;
      try {
        res = await this.api.sendMessage(room.chatRoomId, await this.crypto.encryptText(key, text));
      } catch (err) {
        this.messages.update((list) => list.filter((m) => m !== pending));
        if (!sticker) this.messageText.set(text);
        throw err;
      }
      if (!res.ok) {
        this.messages.update((list) => list.filter((m) => m !== pending));
        if (!sticker) this.messageText.set(text);
        return res;
      }
      const sent: ShownMessage = { ...pending, messageId: res.body.messageId, position: res.body.position, pending: false };
      if (sticker) {
        rememberSticker(sticker);
        this.sentLately.set(recentStickers(this.stickers.sets()));
      }
      this.messages.update((list) => list.map((m) => (m === pending ? sent : m)));
      this.session.markSeen(room.chatRoomId, res.body.position);
      await this.poll(false);
      void this.tellSeen();
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

  /** The pinned card tells the open dispute case of the chat's trade, or null for none (2026-11-12); without one "Invite an attestor" goes, and its panel closes with it. */
  protected setDisputeCase(caseId: string | null): void {
    this.disputeCaseId.set(caseId);
    if (caseId === null) this.showAttestors.set(false);
  }

  /**
   * "Invite an attestor" (wallet spec 8.2, Chat; 2026-11-12), for both
   * traders of a marketplace chat while its trade is in dispute and an
   * attestor has a case open on it. A click while the panel shows closes
   * it. Opening it reads /list-my-cases, quiet, and takes the dispute with
   * the card's case id: when that case is no longer open or in review, the
   * case id is emptied and the entry goes; otherwise the attestors the
   * masterpod names on the case are kept and the panel shows them. A
   * masterpod of before names none, which reads as an empty list.
   */
  protected toggleAttestors(): Promise<void> {
    if (this.showAttestors()) {
      this.showAttestors.set(false);
      return Promise.resolve();
    }
    return this.run(async () => {
      const caseId = this.disputeCaseId();
      const res = await this.api.listMyCases(true);
      if (!res.ok || this.disputeCaseId() !== caseId) return res;
      const dispute = res.body.disputes.find((d) => d.caseId === caseId);
      if (!dispute || !REVIEW_STATUSES.includes(dispute.status)) {
        this.setDisputeCase(null);
        return res;
      }
      this.namedAttestors.set(dispute.attestors ?? []);
      this.showAttestors.set(true);
      return res;
    });
  }

  /** An attestor on the dispute case is invited into this chat, where they read everything: the room's key wrapped to their chat keys, /invite-to-chat-room, and the room list refreshed, so the attestor shows as invited and leaves the panel's list. Either trader may, the one who did not start the chat too (masterpod 18). */
  protected inviteAttestor(attestor: RoomMember): Promise<void> {
    return this.run(async () => {
      const room = this.room();
      if (!room) throw new Error(this.t().chatRoom.notOpen);
      const hpkeKey = await this.chat.wrapFor(room.chatRoomId, attestor.anopodId);
      const res = await this.api.inviteToChatRoom(room.chatRoomId, attestor.anopodId, hpkeKey);
      await this.chat.refreshRooms();
      return res;
    });
  }

  /** A picture picked for this public room (2026-11-22): the middle of it as a square of at most ROOM_PICTURE_SIDE pixels, a fresh JPEG (redrawSquare in ../images), sent with /set-chat-room-picture; then the room list is read again, so every place shows it. A file the browser cannot read as a picture is refused, never sent as it is. */
  protected pictureChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const room = this.room();
    if (!file || !room) return Promise.resolve();
    return this.run(async () => {
      const square = await redrawSquare(file, ROOM_PICTURE_SIDE, ROOM_PICTURE_JPEG);
      if (!square) throw new Error(this.t().camera.unreadable);
      const picture = { contentType: 'image/jpeg', image: this.crypto.toBase64(new Uint8Array(await square.arrayBuffer())) };
      const res = await this.api.setChatRoomPicture(room.chatRoomId, picture);
      if (res.ok) {
        this.pictures.put(room.chatRoomId, res.body.pictureAt, picture);
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
