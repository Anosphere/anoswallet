import { TextFieldModule } from '@angular/cdk/text-field';
import { Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { Router, RouterLink } from '@angular/router';
import { AvatarComponent } from '../components/avatar.component';
import { askConfirm } from '../components/confirm-dialog.component';
import { CopyButtonComponent } from '../components/copy-button.component';
import { FoundAccountId, PinnedListingComponent } from '../components/pinned-listing.component';
import { RoomPictureComponent } from '../components/room-picture.component';
import { MEMBERS_PAGE, MESSAGES_PAGE, MESSAGES_POLL_MS, ROOM_PICTURE_JPEG, ROOM_PICTURE_SIDE } from '../constants';
import { redrawSquare } from '../images';
import { ChatService, Piece, piecesOf } from '../services/chat.service';
import { CryptoService } from '../services/crypto.service';
import { LanguageService } from '../services/language.service';
import { ApiError, ApiResponse, reasonOf } from '../services/log.service';
import { MasterpodApiService, MessageItem, MessagesAnswer, Profile, RoomItem, RoomMember } from '../services/masterpod-api.service';
import { KeptChange, KeptMessage, KeptText, RoomCopiesService, RoomCopy } from '../services/room-copies.service';
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
  /** The text the bubble shows, as it was written (2026-11-24): what Edit puts into the message box. Null where there is no such text: a message that did not open, a message that was deleted, and one that waits. */
  text: string | null;
  /** The position of the edit whose text the bubble shows (2026-11-24); null for a message that shows its own text. With one, the bubble carries the word "edited", and "Seen" under it is counted from this position. */
  editPosition: number | null;
  /** True once a delete names the message (2026-11-24): the thread draws the grey line "This message was deleted" in its place. */
  deleted: boolean;
  /** True for a message that came without its text while the page holds no row that says what became of it (2026-11-24): the edit or the delete that names it is a row the next read brings. The thread does not draw the message until then. */
  waiting: boolean;
}

/** A text as the page holds it once decrypted (2026-11-24): the text, or the words that stand in its place when it did not open, and which of the two it is. */
interface Opened {
  text: string;
  opened: boolean;
}

/** The newest row that names a message, as the page keeps it (2026-11-24; wallet spec 4.19): a delete, or an edit with its text. An edit that came without its text is not kept: a newer row names the same message, and that row says how the message stands. */
type Change = { kind: 'delete'; position: number } | { kind: 'edit'; position: number; text: Opened };

/** What one answer of /list-messages held, decrypted (2026-11-24): its messages in the answer's order, each with its own text, null for one that came without; the edits and deletes that can be drawn, each with the message it names; and the lowest and the highest position of all its rows, drawn or not, 0 for an answer with no row. Since 2026-11-25 also `keyed`: whether the rows were opened with the room's key. A room's copy, which the browser keeps, is drawn as such rows too (rowsOf), and nothing of a read that was made without the key goes into a copy (put). */
interface RowsRead {
  messages: { row: MessageItem; own: Opened | null }[];
  changes: { target: string; change: Change }[];
  lowest: number;
  highest: number;
  keyed: boolean;
}

/** The edit that is going on (2026-11-24): the message, the text it had when Edit was tapped, and what the message box held then, which goes back into the box when the edit ends. */
interface Editing {
  messageId: string;
  text: string;
  draft: string;
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

/** What the thread draws: a day line, a group of bubbles, or a grey line: for the two traders of a marketplace chat (2026-11-19) in the place of a message the pinned card posted, and since 2026-11-24, for everyone, in the place of a message that was deleted. */
type ThreadItem = { kind: 'day'; key: string; label: string } | { kind: 'group'; key: string; group: Group } | { kind: 'notice'; key: string; text: string };

/** Messages this close in time by one sender share a group. */
const GROUP_MINUTES = 5;

/** A message that arrives scrolls the thread down only when the reader is this close to the bottom. */
const FOLLOW_PX = 120;

/** "Seen by" names the people who have seen a message up to this many of them; above it, it says how many they are. */
const SEEN_NAMES = 3;

/** Edit is in a message's menu for this many minutes after the message was sent, by this device's clock (2026-11-24). The masterpod decides by its own clock, and its number is the same (EDIT_MINUTES in its chat.service.js, masterpod spec 31). */
const EDIT_MINUTES = 15;

/** The read that follows a room's copy asks for at most this many rows (2026-11-25; forclaude/chat-rooms-kept-plan-1.md, section 4, point 3). It is the masterpod's own number for a request that names none (MESSAGES_DEFAULT_LIMIT in its chat.service.js), so the answer is the same. An answer that holds this many rows is full: there may be more, and the copy is dropped. */
const NEW_ROWS_LIMIT = 100;

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
 * members' seen positions came with /list-chat-rooms, every 5 seconds;
 * since 2026-11-24 (forclaude/chat-list-plan-1.md; wallet spec 4.17) this
 * page's own read of the messages brings them, every 3 seconds: every
 * member's when the conversation opens, afterwards only the positions
 * that changed (/list-messages with `seenSince`). They are written into
 * the room's entry of the chat list in memory, so the words are drawn as
 * before. While the
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
 * reader at the thread's end stays there when the strip comes up. The
 * two traders of a marketplace chat get no strip (2026-11-23, later the
 * same day): the pinned listing card does not give way to it, and on a
 * short phone the strip pushed their message box under the
 * conversation's lower edge. No suggestion is worked out for them, so
 * nothing is fetched and nothing moves while they type; they send a
 * sticker from the panel. A guest in such a chat, who has no card, has
 * the strip. Since 2026-11-24 (forclaude/chat-edit-delete-plan-1.md;
 * wallet spec 4.19) a person edits and deletes their own messages. A tap
 * on a message of this pod's own, a click on a computer, opens a small
 * menu at the bubble: Edit and Delete. Edit is in it for 15 minutes
 * after the message was sent, by this device's clock, and never for a
 * sticker. A long press stays the browser's own, which marks text; a tap
 * on the copy button of an account id opens no menu, and neither does a
 * click that ends a marking of text. No bubble has a menu in a chat
 * about a listing, in an old marketplace room or in a chat about an
 * attestor case, and nobody else's message has one anywhere. Edit puts
 * the message's text into the message box, under a line "Editing a
 * message" with a cross that stops the edit; Send saves it
 * (/edit-message), and the bubble keeps its place, shows the new text
 * and carries the small word "edited" where the tick stands. While a
 * message is edited the stickers button and the suggested stickers are
 * away, and Send with an unchanged text sends nothing and ends the
 * edit. Delete asks once, with the confirmation box (8.9), and then
 * (/delete-message) a grey line stands in the message's place, for
 * everyone: "This message was deleted". The masterpod changes no row for
 * either: an edit and a delete are rows of their own, which name the
 * message, and /list-messages hands them out among the messages. So the
 * thread's pages are pages of rows since that day, and a page of
 * MESSAGES_PAGE rows can show fewer messages. The page never draws such
 * a row as a bubble. It keeps, for each message, the newest row that
 * names it, and draws the message by it: with the edit's text, or as the
 * grey line. A message that came without its text while the page holds
 * no row that names it is not drawn until the next read brings that
 * row. This pod's own edit or delete is drawn at once, from the
 * masterpod's answer; everyone else's arrives with the 3-second read.
 * "Seen" under an edited message is counted from the edit. The
 * masterpod's refusal of an edit as too late shows above the message
 * box as "This message can no longer be edited.", and the text stays in
 * the box. Since 2026-11-25 (forclaude/chat-rooms-kept-plan-1.md; wallet
 * spec 8.2, Chat, and 8.3) the browser keeps a copy of the thread of
 * each room a person has opened (room-copies.service): in the page's
 * memory, and encrypted in the browser's own database. A conversation
 * that opens draws the room's copy at once, and then asks the masterpod
 * only for the rows after the copy's highest position, with the request
 * of the 3-second read. Until that day every opening emptied the thread
 * and read the room's newest MESSAGES_PAGE rows again; a room the
 * browser has no copy of still opens that way. An answer that comes
 * back full, NEW_ROWS_LIMIT rows, means that the room moved on too far:
 * the copy is dropped and the room is read as before, while the old
 * thread stays on the screen until the newest rows have come. The page
 * hands the open room's thread over as the room's copy each time an
 * answer of the masterpod changed it. While a room's messages are on
 * their way, the thread says "Loading the chat." where it said "No
 * messages yet.", which stays for a room that has none. With a copy on
 * the screen a read that fails leaves the messages readable under the
 * red line, the 3-second read asks again, and the red line of a read of
 * the messages that failed goes when a later one succeeds.
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
          <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().chatRoom.inviteByUsername }}</mat-label><input matInput [ngModel]="inviteName()" (ngModelChange)="inviteName.set($event)" (keyup.enter)="findInvitee()" autocapitalize="none" autocorrect="off" spellcheck="false" /></mat-form-field>
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
            <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>{{ t().chatRoom.searchMembers }}</mat-label><input matInput [ngModel]="memberSearch()" (ngModelChange)="searchMembers($event)" autocapitalize="none" autocorrect="off" spellcheck="false" /></mat-form-field>
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
                  <div class="bubble" [class.pending]="m.pending" [class.sticker]="pictureOf(m) !== null" (click)="tapped(m, $event)">
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
                    @if (m.mine || m.editPosition !== null) {
                      <span class="state">
                        @if (m.editPosition !== null) {
                          <span>{{ t().chatRoom.edited }}</span>
                        }
                        @if (m.mine) {
                          @if (m.pending) {
                            {{ t().chatRoom.sending }}
                          } @else {
                            <mat-icon class="tick">done</mat-icon>
                          }
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
          @if (arrival() === 'coming') {
            <p class="muted empty">{{ t().chatRoom.loading }}</p>
          } @else if (arrival() === 'here') {
            <p class="muted empty">{{ t().chatRoom.noMessages }}</p>
          }
        }
      </div>
      <span class="menu-anchor" #messageAnchor [matMenuTriggerFor]="messageMenu" [matMenuTriggerRestoreFocus]="false" aria-hidden="true"></span>
      <mat-menu #messageMenu="matMenu" xPosition="before">
        <ng-template matMenuContent let-id="id" let-edit="edit">
          @if (edit) {
            <button mat-menu-item type="button" (click)="startEdit(id)" [disabled]="busy()"><mat-icon>edit</mat-icon><span>{{ t().chatRoom.edit }}</span></button>
          }
          <button mat-menu-item type="button" (click)="deleteMessage(id)" [disabled]="busy()"><mat-icon>delete</mat-icon><span>{{ t().chatRoom.delete }}</span></button>
        </ng-template>
      </mat-menu>
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
      @if (editing()) {
        <div class="editing">
          <mat-icon>edit</mat-icon>
          <span>{{ t().chatRoom.editing }}</span>
          <button mat-icon-button type="button" (click)="stopEdit()" [disabled]="busy()" [attr.aria-label]="t().chatRoom.stopEditing"><mat-icon>close</mat-icon></button>
        </div>
      }
      <div class="composer">
        @if (stickerSets().length > 0 && !editing()) {
          <button mat-icon-button type="button" class="stickers-button" (click)="toggleStickers()" [attr.aria-label]="t().chatRoom.stickers" [attr.aria-expanded]="showStickers()"><mat-icon>mood</mat-icon></button>
        }
        <mat-form-field appearance="outline" class="grow" subscriptSizing="dynamic">
          <mat-label>{{ t().chatRoom.message }}</mat-label>
          <textarea matInput #messageBox cdkTextareaAutosize cdkAutosizeMinRows="1" cdkAutosizeMaxRows="5" [ngModel]="messageText()" (ngModelChange)="messageText.set($event)" (keydown.enter)="enter($event)" (focus)="closeStickers()"></textarea>
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
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }
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
    .bubble { padding: 8px 12px; border-radius: 16px; background: var(--mat-sys-surface-container); overflow-wrap: anywhere; -webkit-tap-highlight-color: transparent; }
    .group.mine .bubble { background: var(--mat-sys-primary-container); }
    .bubble.pending { opacity: 0.6; }
    .bubble code { font-size: 12px; word-break: break-all; }
    .bubble.sticker, .group.mine .bubble.sticker { display: flex; align-items: flex-end; padding: 0; background: none; }
    .bubble.sticker img { display: block; width: 148px; height: 128px; object-fit: contain; object-position: left bottom; }
    .group.mine .bubble.sticker img { object-position: right bottom; }
    .plain { white-space: pre-wrap; }
    .state { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; font-size: 11px; color: var(--mat-sys-on-surface-variant); vertical-align: bottom; }
    .tick { font-size: 14px; width: 14px; height: 14px; }
    .mark { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 0 8px 2px; }
    .sender { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 0 0 2px 8px; }
    .time { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin: 2px 8px 0; }
    .menu-anchor { position: absolute; visibility: hidden; pointer-events: none; }
    .editing { flex: none; display: flex; align-items: center; gap: 8px; padding: 0 4px 0 12px; border-top: 1px solid var(--mat-sys-outline-variant); font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .editing > mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .editing > span { flex: 1; min-width: 0; }
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
  /** The copies the browser keeps of the rooms' threads (2026-11-25; room-copies.service): this page hands the open room's thread over each time an answer of the masterpod changed it (keep), and takes the room's copy back when the room opens (open). */
  private readonly copies = inject(RoomCopiesService);
  private readonly injector = inject(Injector);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  private readonly threadBox = viewChild<ElementRef<HTMLElement>>('threadBox');
  private readonly membersBox = viewChild<ElementRef<HTMLElement>>('membersBox');
  /** The box before a delete is the wallet's confirmation box (2026-11-24; wallet spec 8.9). */
  private readonly dialog = inject(MatDialog);
  /** The page's own element (2026-11-24): the menu of a message is placed by its corner. */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The message box (2026-11-24): Edit puts the cursor into it. */
  private readonly messageBox = viewChild<ElementRef<HTMLTextAreaElement>>('messageBox');
  /** What the menu of a message opens from (2026-11-24): one element of the page that is not seen and takes no tap. A tap on a bubble lays it over that bubble and opens the menu, so the menu stands at the bubble. The same element read twice, as an element and as the menu's trigger. */
  private readonly messageAnchor = viewChild<ElementRef<HTMLElement>>('messageAnchor');
  private readonly messageTrigger = viewChild('messageAnchor', { read: MatMenuTrigger });

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
  /** Where the room's messages are (2026-11-25; forclaude/chat-rooms-kept-plan-1.md, section 4, point 2): `coming` from the moment a conversation opens until its thread is drawn, from the room's copy or from the masterpod's answer, and again while a room whose copy was dropped is read afresh; `here` once the thread is drawn; `failed` when the read of the room's newest rows failed. An empty thread says "Loading the chat." while they are coming and "No messages yet." once they are here, which is then a room that has none. After a read that failed it says neither: the red line says why. */
  protected readonly arrival = signal<'coming' | 'here' | 'failed'>('coming');
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
  /** The stickers suggested for what stands in the message box (2026-11-23, suggestedStickers in ../stickers): the strip above the message box draws them. None while the stickers panel is open: the panel then holds every sticker, and the thread keeps its room. None for the two traders of a marketplace chat either (2026-11-23, later): the pinned listing card does not give way to the strip, and on a short phone the strip pushed their message box under the conversation's lower edge. And none while a message is edited (2026-11-24): an edit is a text. */
  protected readonly suggested = computed(() => (!this.showStickers() && !this.trader() && !this.editing() ? suggestedStickers(this.stickers.sets(), this.messageText(), this.sentLately()) : []));
  /** True while the strip of suggestions shows (2026-11-23). */
  private readonly stripShown = computed(() => this.suggested().length > 0);
  protected readonly inviteName = signal('');
  protected readonly inviteTarget = signal<Profile | null>(null);
  protected readonly messageText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The edit that is going on, null when there is none (2026-11-24): while one is, a line above the message box says "Editing a message", Send saves the text as that message's new text, and the stickers button and the suggested stickers are away. */
  protected readonly editing = signal<Editing | null>(null);
  /** True in a chat where a person edits and deletes their own messages (2026-11-24; forclaude/chat-edit-delete-plan-1.md, decision 2): every chat but a chat about a listing, an old marketplace room and a chat about an attestor case, where the masterpod refuses both. Told by the `listingId`, the `type` and the `caseId` of the chat's entry. */
  private readonly changeable = computed(() => {
    const room = this.room();
    return room !== null && room.type !== 'marketplace' && !room.listingId && !room.caseId;
  });

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

  /** The messages as the thread draws them: a day line before each day, the messages of one sender within GROUP_MINUTES in one group, and for the two traders of a marketplace chat (2026-11-19) a grey line in the place of each message the pinned card posted, which ends the group before it. Since 2026-11-24 it also reads the day (chat.today): a day line is worded by today's date ("Today", "Yesterday"), so the thread is made again when the day changes; until then the room's entry was set anew every 5 seconds. Since 2026-11-24, too (forclaude/chat-edit-delete-plan-1.md), a message that was deleted is the same grey line, "This message was deleted", in the message's place and for everyone, the person who deleted it among them; and a message that waits for the row that names it is passed over. */
  protected readonly thread = computed<ThreadItem[]>(() => {
    const room = this.room();
    if (!room) return [];
    this.chat.today();
    const direct = this.chat.kind(room) === 'direct';
    const items: ThreadItem[] = [];
    let group: Group | null = null;
    let lastDay = '';
    for (const m of this.messages()) {
      if (m.waiting) continue;
      const day = dayKey(m.createdAt);
      if (day !== lastDay) {
        items.push({ kind: 'day', key: `day-${day}`, label: this.chat.dayLabel(m.createdAt) });
        lastDay = day;
        group = null;
      }
      if (m.deleted) {
        items.push({ kind: 'notice', key: m.messageId, text: this.t().chatRoom.messageDeleted });
        group = null;
        continue;
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
   * positions in the room's entry of the chat list in memory, which this
   * page's own read keeps fresh since 2026-11-24 (takeSeen; until then
   * they came with /list-chat-rooms); with more than one other member, "Seen
   * by" and the usernames of those who have, and above SEEN_NAMES of them
   * how many they are. "Sent" under the newest one when nobody has seen it
   * yet, a person who is only invited so far among them. A message drawn
   * as a grey line carries none. Empty in a room with nobody else in it
   * and nobody invited, and while no member carries a seen position, this
   * pod among them: a masterpod of before. Since 2026-11-24
   * (forclaude/chat-edit-delete-plan-1.md, section 4, point 5) a message
   * that was edited counts as seen by a member only once that member's
   * seen position has reached the edit's position, which is above the
   * message's own: "Seen" never stands under a text the other person has
   * not read, and an edited newest message reads "Sent" again until then.
   * A message that was deleted carries no word, as a grey line carries
   * none.
   */
  protected readonly marks = computed(() => {
    const marks = new Map<string, string>();
    const room = this.room();
    if (!room || room.members.every((m) => m.seenPosition === undefined)) return marks;
    const me = this.session.anopodId();
    const others = room.members.filter((m) => m.anopodId !== me);
    if (others.length === 0 && room.invited.length === 0) return marks;
    const mine = this.messages().filter((m) => m.mine && !m.pending && !m.notice && !m.deleted && !m.waiting);
    if (mine.length === 0) return marks;
    const words = this.t().chatRoom;
    const newest = mine[mine.length - 1];
    // The position a member must have read up to, to have seen the message as it stands: the newest edit's, else the message's own.
    const reach = (m: ShownMessage) => m.editPosition ?? m.position;
    const seen = [...mine].reverse().find((m) => others.some((o) => (o.seenPosition ?? 0) >= reach(m)));
    if (seen) {
      const readers = others.filter((o) => (o.seenPosition ?? 0) >= reach(seen)).map((o) => o.username);
      marks.set(seen.messageId, others.length === 1 ? words.seen : readers.length > SEEN_NAMES ? words.seenByCount(readers.length) : words.seenBy(readers.join(', ')));
    }
    if (seen !== newest) marks.set(newest.messageId, words.sent);
    return marks;
  });

  /** The room the thread shows, whether its opening read is done, and the positions of the oldest and newest shown. Since 2026-11-24 the two positions are the lowest and the highest of the rows the page has read, drawn or not: an edit and a delete are rows with a position of their own, and no bubble. Since 2026-11-25 `ready` is true as soon as a room's copy is drawn, before the read that follows it is answered, so the timer's read and a send work at once; and it is false again while a room whose copy was dropped is read afresh. The two positions are then the copy's until a read moves them. */
  private openedFor: string | null = null;
  private ready = false;
  private oldest = 0;
  private newest = 0;
  /** Counts the threads this page has begun (2026-11-25): raised when a conversation opens, and again when a room's copy is dropped after a full answer and the room is read afresh. The answer to a read that was asked for under an earlier number is dropped: its rows belong to a thread the page no longer shows. */
  private opening = 0;
  /** False once the thread holds rows of a read that was made without the room's key (2026-11-25; forclaude/chat-rooms-kept-plan-1.md, section 7): nothing of such a read is kept, so the page hands no copy over from then on, until a thread is begun anew. */
  private keepable = true;
  /** The red line that a read of the messages put up when it failed, for as long as that line may still be showing (2026-11-25; the same plan, section 4, point 7); null when there is none. The next such read that succeeds takes the line away, and only while the red line is still this one (readWorked). */
  private readError: string | null = null;
  /** For each message, by its id, the newest row that names it (2026-11-24; wallet spec 4.19): a delete, or the newest edit with its text. Kept for a message the page does not hold too: a row that names a message has a higher position than the message, so the page reads it first, and the message comes with a later read of older rows. Emptied when a conversation opens, and since 2026-11-25 when a room whose copy was dropped is read afresh. */
  private readonly changes = new Map<string, Change>();
  /** The newest position this page told the masterpod it has seen, for the room it shows; 0 when none. */
  private toldSeen = 0;
  /** The number this page sends as `seenSince` with its reads of the room's messages (2026-11-24; wallet spec 4.17): 0 when the room opens, which asks for every member who has seen anything, then the `seenSeq` of the last answer, which asks only for the positions that changed after it. */
  private seenSince = 0;
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

  /**
   * The room's newest page; whatever was shown before is dropped. Since
   * 2026-11-23 the list of the sets of stickers is asked for here, which
   * asks the masterpod only when this login has no list yet
   * (stickers.service.ts). Since 2026-11-24 the same read asks with
   * `seenSince` 0 for the seen position of every member who has seen
   * anything (takeSeen). Since 2026-11-24, too, the page is the room's
   * newest MESSAGES_PAGE rows, the edits and the deletes among them, so
   * fewer messages than that can show; an edit that was going on ends, and
   * the rows kept of the room before are dropped.
   *
   * Since 2026-11-25 (forclaude/chat-rooms-kept-plan-1.md, sections 3.2,
   * 3.3 and 7) the page first looks for the room's copy
   * (room-copies.service): in the page's memory, which answers at once,
   * else in the browser's database, one read and one decryption. With a
   * copy the page draws it through `put`, as it draws an answer, at the
   * thread's end, and is ready from that moment. Then it asks for the
   * rows after the copy's highest position: the request of the 3-second
   * read, with `limit` NEW_ROWS_LIMIT and `seenSince` 0. The answer goes
   * into the thread through `take`, as a 3-second read's does. Then the
   * room is marked seen up to the highest position and the masterpod is
   * told (tellSeen), also when the answer held no row. When that read
   * fails, the copy stays on the screen under the red line, and the
   * timer's read asks again. An answer that is full, NEW_ROWS_LIMIT rows,
   * means there may be more: the copy is dropped, the page stops being
   * ready, and the room's newest MESSAGES_PAGE rows are read as before
   * and take the place of the old thread when they have come. Without a
   * copy the room opens as before. The page hands the thread over as the
   * room's copy when the newest rows have come (keep).
   */
  private async open(room: RoomItem): Promise<void> {
    this.ready = false;
    this.opening += 1;
    this.endEdit();
    this.messages.set([]);
    this.changes.clear();
    this.oldest = 0;
    this.newest = 0;
    this.toldSeen = 0;
    this.seenSince = 0;
    this.olderArmed = true;
    this.keepable = true;
    this.canLoadOlder.set(false);
    this.showInvite.set(false);
    this.showMembers.set(false);
    this.showPicture.set(false);
    this.closeStickers();
    this.failedPictures.set(new Set());
    this.inviteTarget.set(null);
    this.setDisputeCase(null);
    this.error.set(null);
    this.readError = null;
    this.arrival.set('coming');
    void this.stickers.load();
    const copy = this.copies.held(room.chatRoomId) ?? (await this.copies.stored(room.chatRoomId, room.lastPosition));
    if (this.openedFor !== room.chatRoomId) return;
    if (copy !== null) {
      this.put(room, this.rowsOf(copy), false);
      this.oldest = copy.lowest;
      this.newest = copy.highest;
      this.canLoadOlder.set(copy.olderLeft);
      this.ready = true;
      this.arrival.set('here');
      this.scrollToBottom();
      const news = await this.api.listMessages(room.chatRoomId, { afterPosition: copy.highest, limit: NEW_ROWS_LIMIT, seenSince: 0 });
      if (this.openedFor !== room.chatRoomId) return;
      if (!news.ok) {
        this.readFailed(`/list-messages: ${reasonOf(news)}`);
        return;
      }
      if (news.body.messages.length < NEW_ROWS_LIMIT) {
        await this.take(room, news.body);
        if (this.openedFor !== room.chatRoomId) return;
        this.session.markSeen(room.chatRoomId, this.newest);
        void this.tellSeen();
        return;
      }
      // A full answer: the room moved on too far for its copy. The old thread stays on the screen until the newest rows have come.
      this.copies.drop(room.chatRoomId);
      this.ready = false;
      this.opening += 1;
      this.arrival.set('coming');
    }
    const res = await this.api.listMessages(room.chatRoomId, { beforePosition: room.lastPosition + 1, limit: MESSAGES_PAGE, seenSince: 0 });
    if (this.openedFor !== room.chatRoomId) return;
    if (!res.ok) {
      this.readFailed(`/list-messages: ${reasonOf(res)}`);
      this.arrival.set('failed');
      return;
    }
    this.takeSeen(room.chatRoomId, res.body);
    const read = await this.read(room, res.body.messages);
    if (this.openedFor !== room.chatRoomId) return;
    this.messages.set([]);
    this.changes.clear();
    this.keepable = true;
    this.put(room, read, false);
    this.oldest = read.lowest;
    this.newest = read.highest;
    this.canLoadOlder.set(res.body.messages.length === MESSAGES_PAGE);
    this.ready = true;
    this.arrival.set('here');
    this.session.markSeen(room.chatRoomId, this.newest);
    this.scrollToBottom();
    void this.tellSeen();
    this.keep();
  }

  /** The page before the oldest shown; the reader stays on the message they were looking at. Since 2026-11-24 the page is the MESSAGES_PAGE rows before the lowest position read, the edits and the deletes among them: a page of rows can hold fewer messages, or none, and the next page is then asked for from that page's lowest position. Since 2026-11-25 the thread is handed over as the room's copy afterwards (keep), so older messages that were loaded stay while the page lives; an answer that arrives after the thread was begun anew is dropped (opening); and a read that fails is noted, so that the red line it puts up goes when a later read of the messages succeeds (readError). */
  protected loadOlder(): Promise<void> {
    const room = this.room();
    if (!room || this.oldest === 0) return Promise.resolve();
    return this.run(async () => {
      const opening = this.opening;
      const res = await this.api.listMessages(room.chatRoomId, { beforePosition: this.oldest, limit: MESSAGES_PAGE });
      if (!res.ok) this.readError = reasonOf(res);
      if (!res.ok || this.openedFor !== room.chatRoomId || this.opening !== opening) return res;
      const read = await this.read(room, res.body.messages);
      if (read.lowest > 0) {
        await this.threadAtRest();
        if (this.openedFor !== room.chatRoomId || this.opening !== opening) return res;
        const el = this.threadBox()?.nativeElement;
        // How far the reader is from the thread's end; the same distance is set again once the older messages are drawn (2026-11-22). A browser that has kept the place by itself is then moved by nothing.
        const fromEnd = el ? el.scrollHeight - el.scrollTop : 0;
        this.oldest = read.lowest;
        this.put(room, read, true);
        afterNextRender(
          () => {
            if (el) el.scrollTop = el.scrollHeight - fromEnd;
          },
          { injector: this.injector },
        );
      }
      this.canLoadOlder.set(res.body.messages.length === MESSAGES_PAGE);
      this.keep();
      return res;
    });
  }

  /** New messages after the newest shown: quiet from the timer, logged after a send. The thread follows them only when the reader is near the bottom. Since 2026-11-24 the same read brings the members' seen positions that changed since the read before (takeSeen); they are taken before the return for an answer with no message. Since 2026-11-24, too, it brings the edits and the deletes written after the highest position read: this is how an edit or a delete by someone else reaches an open conversation, within MESSAGES_POLL_MS. Since 2026-11-25 what the answer brings is put into the page by `take`, which the read that follows a room's copy uses too (open); and an answer that arrives after the thread was begun anew is dropped (opening). */
  private async poll(quiet: boolean): Promise<void> {
    const room = this.room();
    if (!room || !this.ready || this.openedFor !== room.chatRoomId || !this.session.hasSession() || (quiet && this.busy())) return;
    const opening = this.opening;
    const res = await this.api.listMessages(room.chatRoomId, { afterPosition: this.newest, seenSince: this.seenSince }, quiet);
    if (!res.ok || this.openedFor !== room.chatRoomId || this.opening !== opening) return;
    await this.take(room, res.body);
  }

  /**
   * What an answer to a read of the rows after the highest position held
   * brings into the page (2026-11-25; until then these were the last
   * lines of `poll`): the answer of the 3-second read, of the read after
   * a send, an edit or a delete, and of the read that follows a room's
   * copy when a conversation opens (forclaude/chat-rooms-kept-plan-1.md,
   * section 3.2). The red line of an earlier read of the messages that
   * failed goes (readWorked). The members' seen positions are taken, also
   * from an answer with no row. The rows are opened and put into the
   * thread, which follows them only when the reader is near the bottom;
   * the highest position moves up; the room is marked seen on this
   * device; and the thread is handed over as the room's copy (keep).
   * Nothing is put when the thread was begun anew while the rows were
   * opened.
   */
  private async take(room: RoomItem, answer: MessagesAnswer): Promise<void> {
    this.readWorked();
    this.takeSeen(room.chatRoomId, answer);
    if (answer.messages.length === 0) return;
    const opening = this.opening;
    const read = await this.read(room, answer.messages);
    if (this.openedFor !== room.chatRoomId || this.opening !== opening) return;
    const follow = this.nearBottom();
    this.put(room, read, false);
    this.newest = Math.max(this.newest, read.highest);
    if (this.oldest === 0) this.oldest = read.lowest;
    this.session.markSeen(room.chatRoomId, this.newest);
    if (follow) this.scrollToBottom();
    this.keep();
  }

  /** A read of the messages failed, and its reason is the red line (2026-11-25): the line is noted, so that the next such read that succeeds takes it away (readWorked). */
  private readFailed(line: string): void {
    this.error.set(line);
    this.readError = line;
  }

  /** A read of the messages succeeded (2026-11-25; forclaude/chat-rooms-kept-plan-1.md, section 4, point 7): the red line that an earlier such read put up when it failed goes, and only while the red line is still that line. Until that day it stayed until the person's next action in the room. Such a line is put up by a conversation's opening and by Load older messages. */
  private readWorked(): void {
    if (this.readError !== null && this.error() === this.readError) this.error.set(null);
    this.readError = null;
  }

  /**
   * Hands the open room's thread, as the page holds it now, to the
   * browser's keeping as the room's copy (2026-11-25;
   * forclaude/chat-rooms-kept-plan-1.md, section 7; room-copies.service).
   * Called each time an answer of the masterpod changed the thread: after
   * a conversation's opening read, after a read that brought rows, after
   * a read of older rows, and after this pod's own send, edit or delete.
   *
   * The copy holds each message once, by its id, oldest first; a message
   * that is still being sent is left out. A message's text is its own
   * decrypted text. It is null for a message that an edit or a delete
   * names, since the text of before is not kept, and for one that came
   * without its text. A text that did not open is kept as that, never as
   * the sentence the thread shows for it. With them goes the newest row
   * that names each message, as `changes` has it, and the lowest and the
   * highest position the reads have covered: `newest` is never the
   * position of a message this pod has just sent, nor of its own edit or
   * delete, and the read that follows brings those rows again.
   *
   * Nothing is handed over while the page is not ready, and nothing once
   * the thread holds rows of a read that was made without the room's key
   * (keepable): the copy then stays as it was before that read.
   */
  private keep(): void {
    const chatRoomId = this.openedFor;
    if (chatRoomId === null || !this.ready || !this.keepable) return;
    const messages = new Map<string, KeptMessage>();
    for (const m of this.messages()) {
      if (m.pending || messages.has(m.messageId)) continue;
      const own: KeptText | null = this.changes.has(m.messageId) || m.waiting ? null : m.text === null ? { opened: false } : { opened: true, text: m.text };
      messages.set(m.messageId, { messageId: m.messageId, position: m.position, senderAnopodId: m.senderAnopodId, createdAt: m.createdAt, own });
    }
    this.copies.keep(chatRoomId, {
      messages: [...messages.values()].sort((a, b) => a.position - b.position),
      changes: [...this.changes].map(([target, change]) => ({ target, change: keptChange(change) })),
      lowest: this.oldest,
      highest: this.newest,
      olderLeft: this.canLoadOlder(),
    });
  }

  /** A room's copy as the rows of an answer, which `put` draws (2026-11-25): each message with its own text, and each edit and delete with the message it names. A text that did not open gets the sentence that says so, in the language of this moment. A copy holds nothing of a read without the room's key, so its rows count as opened with the key. */
  private rowsOf(copy: RoomCopy): RowsRead {
    const opened = (text: KeptText): Opened => (text.opened ? { text: text.text, opened: true } : { text: this.t().chatRoom.cannotDecrypt, opened: false });
    return {
      messages: copy.messages.map((m) => ({ row: { messageId: m.messageId, position: m.position, senderAnopodId: m.senderAnopodId, createdAt: m.createdAt, message: null }, own: m.own === null ? null : opened(m.own) })),
      changes: copy.changes.map(({ target, change }) => ({ target, change: change.kind === 'delete' ? change : { kind: change.kind, position: change.position, text: opened(change.text) } })),
      lowest: copy.lowest,
      highest: copy.highest,
      keyed: true,
    };
  }

  /**
   * What an answer of /list-messages says of the members' seen positions
   * (2026-11-24; wallet spec 4.17; the plan is
   * forclaude/chat-list-plan-1.md). `seen`, the members whose position
   * changed after the `seenSince` that was sent, goes into the room's
   * entry of the chat list in memory (chat.service's putSeen), where
   * `marks` reads it; `seenSeq` is the next `seenSince`. An answer of a
   * masterpod of before carries neither, and nothing changes: the
   * positions then still come with every answer of /list-chat-rooms.
   */
  private takeSeen(chatRoomId: string, answer: MessagesAnswer): void {
    if (answer.seen) this.chat.putSeen(chatRoomId, answer.seen);
    if (typeof answer.seenSeq === 'number') this.seenSince = answer.seenSeq;
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

  /**
   * The rows of one answer of /list-messages, decrypted with the room key
   * (2026-11-24; wallet spec 4.19; until then every row was a message, and
   * this was `shown`). A text that does not open is one of the two
   * sentences that say why, as before. A row is one of three things. A
   * message, with its own text, or with none when it came without: a
   * later row of the room names it then. An edit, kept with its text for
   * the message it names; an edit that came without its text is passed
   * over, since a newer row names the same message. A delete, kept for
   * the message it names. A row of a kind this wallet does not know, and
   * an edit or a delete that names no message, is passed over. Nothing of
   * the page is changed here: `put` does that, once the page still shows
   * the room the rows were read for. Since 2026-11-25 the answer also says
   * whether the room's key was there (`keyed`).
   */
  private async read(room: RoomItem, rows: MessageItem[]): Promise<RowsRead> {
    const hasKey = (await this.chat.roomKeyOf(room)) !== null;
    const open = async (message: string): Promise<Opened> => {
      const text = await this.chat.decryptMessage(room, message);
      return text === null ? { text: hasKey ? this.t().chatRoom.cannotDecrypt : this.t().chatRoom.noRoomKey, opened: false } : { text, opened: true };
    };
    const read: RowsRead = { messages: [], changes: [], lowest: 0, highest: 0, keyed: hasKey };
    for (const row of rows) {
      if (read.lowest === 0 || row.position < read.lowest) read.lowest = row.position;
      if (row.position > read.highest) read.highest = row.position;
      const kind = row.kind ?? null;
      const target = row.targetMessageId ?? null;
      if (kind === null) read.messages.push({ row, own: row.message === null ? null : await open(row.message) });
      else if (kind === 'delete' && target !== null) read.changes.push({ target, change: { kind, position: row.position } });
      else if (kind === 'edit' && target !== null && row.message !== null) read.changes.push({ target, change: { kind, position: row.position, text: await open(row.message) } });
    }
    return read;
  }

  /**
   * A message as the thread draws it now (2026-11-24; wallet spec 4.19),
   * by the rule the masterpod reads by too (its spec, 31.4): the message
   * is deleted when a delete names it; otherwise its text is the newest
   * edit's; otherwise its own. `change` is the newest row that names the
   * message, as the page keeps it, and `own` the message's own text, null
   * when its row came without. With neither, the message waits: it is not
   * drawn until a read brings the row that names it. For the two traders
   * of a marketplace chat (2026-11-19) the message also says what it is
   * when the pinned card posted it (`notice`, from tradeMessageKind), and
   * since 2026-11-23 which sticker its text names (`sticker`, from
   * stickerNamed in ../stickers); both are read from the text the bubble
   * shows.
   */
  private present(room: RoomItem, row: { messageId: string; position: number; senderAnopodId: string; createdAt: string }, own: Opened | null, change: Change | undefined): ShownMessage {
    const base = { messageId: row.messageId, position: row.position, senderAnopodId: row.senderAnopodId, createdAt: row.createdAt, mine: row.senderAnopodId === this.session.anopodId(), pending: false };
    const none = { pieces: [], notice: null, sticker: null, text: null, editPosition: null };
    if (change?.kind === 'delete') return { ...base, ...none, deleted: true, waiting: false };
    const shown = change ? change.text : own;
    if (shown === null) return { ...base, ...none, deleted: false, waiting: true };
    return {
      ...base,
      pieces: piecesOf(shown.text),
      notice: this.chat.isTrader(room) ? tradeMessageKind(shown.text) : null,
      sticker: stickerNamed(shown.text),
      text: shown.opened ? shown.text : null,
      editPosition: change ? change.position : null,
      deleted: false,
      waiting: false,
    };
  }

  /** Keeps `change` as the newest row that names the message `target`, when it is that (2026-11-24): a delete always, since no edit is ever written after one; an edit only while no delete is kept and its position is above the kept edit's. True when what is kept changed. The same row kept twice changes nothing, so an answer that arrives twice does no harm. */
  private keepChange(target: string, change: Change): boolean {
    const held = this.changes.get(target);
    if (held && (held.kind === 'delete' || (change.kind === 'edit' && change.position <= held.position))) return false;
    this.changes.set(target, change);
    return true;
  }

  /**
   * Puts what one answer of /list-messages held into the page (2026-11-24;
   * wallet spec 4.19). Its edits and deletes are kept first (keepChange).
   * Then its messages join the thread, each as it stands now (present):
   * at the thread's top for a page of older rows, else at its end, and in
   * the place of an entry with the same id, as before. A message the
   * thread already holds is drawn anew when one of the answer's rows
   * names it: that is how an edit or a delete by someone else changes a
   * bubble that is on the screen. Since 2026-11-25 a room's copy is drawn
   * here too, as the rows of an answer (open, rowsOf); and rows that were
   * read without the room's key end the handing over of copies for this
   * thread (keepable). Since that day, too, the thread is then put in the
   * order of the positions (inOrder), so a row that comes a second time
   * changes nothing. Until then such a message moved to the thread's end,
   * also when newer messages stood there already. With a copy on the
   * screen the page is ready before the opening read is answered, so the
   * timer's read or the read after a send can overtake that answer, which
   * then brings rows the thread already holds.
   */
  private put(room: RoomItem, read: RowsRead, older: boolean): void {
    if (!read.keyed) this.keepable = false;
    const named = new Set<string>();
    for (const { target, change } of read.changes) {
      if (this.keepChange(target, change)) named.add(target);
    }
    const fresh = read.messages.map(({ row, own }) => this.present(room, row, own, this.changes.get(row.messageId)));
    if (fresh.length === 0 && named.size === 0) return;
    const ids = new Set(fresh.map((m) => m.messageId));
    this.messages.update((list) => {
      const kept = list.filter((m) => !ids.has(m.messageId)).map((m) => (named.has(m.messageId) ? this.present(room, m, null, this.changes.get(m.messageId)) : m));
      return inOrder(older ? [...fresh, ...kept] : [...kept, ...fresh]);
    });
  }

  /** This pod's own edit or delete, drawn at once from the masterpod's 201 (2026-11-24): the row is kept as the newest that names the message, and the message is drawn anew. The read that follows brings the same row again, which changes nothing. Since 2026-11-25 the thread is then handed over as the room's copy (keep). */
  private drawChange(room: RoomItem, target: string, change: Change): void {
    if (!this.keepChange(target, change)) return;
    this.messages.update((list) => list.map((m) => (m.messageId === target ? this.present(room, m, null, change) : m)));
    this.keep();
  }

  /**
   * The message shows at once as a pending bubble and the box empties; the
   * answer gives the bubble its id and position, and the poll that follows
   * brings in whatever else arrived. A refusal, or a key that fails, takes
   * the bubble away and puts the text back. With a sticker (2026-11-23)
   * the message is that sticker's code, and send() leaves the message box
   * as it is. A sticker that went through is noted as sent lately
   * (rememberSticker in ../stickers). While a message is edited
   * (2026-11-24) Send saves the edit and sends no message (saveEdit).
   * Since 2026-11-25 the thread is handed over as the room's copy once
   * the answer has given the bubble its id (keep).
   */
  protected send(sticker: Sticker | null = null): Promise<void> {
    const edit = this.editing();
    if (edit && !sticker) return this.saveEdit(edit);
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
        text,
        editPosition: null,
        deleted: false,
        waiting: false,
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
      this.keep();
      await this.poll(false);
      void this.tellSeen();
      return res;
    });
  }

  /** True for a message that has a menu (2026-11-24; forclaude/chat-edit-delete-plan-1.md, section 7): the chat is one where editing and deleting are on (changeable), and the message is this pod's own, has been sent and is not deleted. So the menu shows only where the masterpod would say yes. */
  private canChange(m: ShownMessage): boolean {
    return this.changeable() && m.mine && !m.pending && !m.deleted && !m.waiting;
  }

  /** True when that menu has Edit (2026-11-24): the message is a text that opened, not a sticker, and was sent at most EDIT_MINUTES ago by this device's clock. The masterpod decides by its own clock: a device whose clock is off gets its refusal as a sentence (saveEdit). */
  private canEdit(m: ShownMessage): boolean {
    return this.canChange(m) && m.sticker === null && m.text !== null && Date.now() - Date.parse(m.createdAt) <= EDIT_MINUTES * 60_000;
  }

  /**
   * A tap on a bubble, a click on a computer (2026-11-24;
   * forclaude/chat-edit-delete-plan-1.md, decision 6). On a message of
   * this pod's own that has a menu (canChange) it opens that menu at the
   * bubble: Edit, when the message can be edited (canEdit), and Delete.
   * On every other bubble it does nothing, as before. No menu either for
   * a tap on the copy button of an account id, nor for a click that ends
   * a marking of text: the text is then still marked when the click
   * arrives. A long press is not a tap and stays the browser's own, which
   * marks text. The menu opens from the page's one anchor element, laid
   * over the part of the bubble that the thread shows.
   */
  protected tapped(m: ShownMessage, event: Event): void {
    if (!this.canChange(m) || this.busy()) return;
    const bubble = event.currentTarget;
    if (!(bubble instanceof HTMLElement)) return;
    if (event.target instanceof Element && event.target.closest('app-copy-button') !== null) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const trigger = this.messageTrigger();
    const anchor = this.messageAnchor()?.nativeElement;
    const thread = this.threadBox()?.nativeElement;
    if (!trigger || !anchor || !thread) return;
    const page = this.host.nativeElement.getBoundingClientRect();
    const frame = thread.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const top = Math.max(box.top, frame.top);
    const bottom = Math.min(box.bottom, frame.bottom);
    anchor.style.left = `${box.left - page.left}px`;
    anchor.style.top = `${top - page.top}px`;
    anchor.style.width = `${box.width}px`;
    anchor.style.height = `${Math.max(0, bottom - top)}px`;
    trigger.menuData = { id: m.messageId, edit: this.canEdit(m) };
    // A menu's trigger learns from the press of a mouse on it that a pointer opened the menu, and then draws no entry as a keyboard's choice. No finger can reach the anchor, so the press is said to it here; without it the menu opens with Edit drawn darker, as if it were picked.
    anchor.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, detail: 1 }));
    trigger.openMenu();
  }

  /**
   * The menu's Edit (2026-11-24): the message's text goes into the message
   * box, the cursor with it, and the line "Editing a message" stands
   * above the box until the edit ends. What the box held is kept and goes
   * back into it then (endEdit). The stickers panel closes, and a reader
   * at the thread's end stays there. Whether the message can still be
   * edited was told when the menu opened; the clock is not asked again
   * here, and the masterpod decides at the save.
   */
  protected startEdit(messageId: string): void {
    const m = this.messages().find((entry) => entry.messageId === messageId);
    if (!m || !this.canChange(m) || m.sticker !== null || m.text === null || this.busy()) return;
    const follow = this.nearBottom();
    const draft = this.editing()?.draft ?? this.messageText();
    this.editing.set({ messageId, text: m.text, draft });
    this.messageText.set(m.text);
    this.closeStickers();
    this.error.set(null);
    this.messageBox()?.nativeElement.focus();
    if (follow) this.scrollToBottom();
  }

  /** The cross of the line "Editing a message" (2026-11-24): the edit ends and nothing is sent. */
  protected stopEdit(): void {
    this.endEdit();
  }

  /** Ends the edit that is going on, if one is (2026-11-24): the line above the message box goes, and the box holds again what it held before Edit was tapped. */
  private endEdit(): void {
    const edit = this.editing();
    if (!edit) return;
    this.editing.set(null);
    this.messageText.set(edit.draft);
  }

  /**
   * Send while a message is edited (2026-11-24;
   * forclaude/chat-edit-delete-plan-1.md; wallet spec 4.19). An empty box
   * sends nothing, as for a message. An unchanged text sends nothing and
   * ends the edit. Otherwise the new text goes out encrypted with the
   * room key, as a message does, with /edit-message. From the masterpod's
   * 201 the bubble shows the new text and the word "edited" at once, in
   * its place, and the edit ends; the read that follows brings whatever
   * else arrived. The box keeps the text until that answer, so a refusal
   * loses nothing; when the person typed on meanwhile, the edit does not
   * end: the box keeps what they typed and the next Send saves it. The masterpod's refusal as too late, or because the
   * message was deleted meanwhile, shows as a sentence of the wallet's
   * own in the red line above the message box; the edit then ends and the
   * text stays in the box, so it is not lost. Every other refusal shows
   * as the page shows one, and the edit goes on.
   */
  private saveEdit(edit: Editing): Promise<void> {
    const text = this.messageText().trim();
    if (!text) return Promise.resolve();
    if (text === edit.text.trim()) {
      this.endEdit();
      return Promise.resolve();
    }
    return this.run(async () => {
      const room = this.room();
      if (!room) throw new Error(this.t().chatRoom.notOpen);
      const key = await this.chat.roomKeyOf(room);
      if (!key) throw new Error(this.t().common.noRoomKey);
      const res = await this.api.editMessage(room.chatRoomId, edit.messageId, await this.crypto.encryptText(key, text));
      if (this.openedFor !== room.chatRoomId) return res;
      if (!res.ok) {
        const sentence = this.refusedChange(res);
        if (sentence === null) return res;
        this.editing.set(null);
        await this.poll(false);
        throw new Error(sentence);
      }
      this.drawChange(room, edit.messageId, { kind: 'edit', position: res.body.position, text: { text, opened: true } });
      // The edit ends when the box still holds what was saved. A person who went on typing while the save was on its way is still editing: the box keeps what they typed, and the next Send saves that.
      if (this.messageText().trim() === text) this.endEdit();
      else this.editing.set({ ...edit, text });
      await this.poll(false);
      void this.tellSeen();
      return res;
    });
  }

  /**
   * The menu's Delete (2026-11-24; forclaude/chat-edit-delete-plan-1.md;
   * wallet spec 4.19). The wallet asks once, with its confirmation box
   * (8.9); the box's first button, and a step back in the browser's
   * history, delete nothing. After a yes /delete-message goes out, and
   * from the masterpod's 201 the grey line "This message was deleted"
   * stands in the message's place at once; an edit of that message that
   * was going on ends. A refusal because the message was deleted
   * meanwhile shows as a sentence of the wallet's own; every other
   * refusal as the page shows one.
   */
  protected async deleteMessage(messageId: string): Promise<void> {
    const room = this.room();
    const m = this.messages().find((entry) => entry.messageId === messageId);
    if (!room || !m || !this.canChange(m) || this.busy()) return;
    const words = this.t().chatRoom;
    const yes = await askConfirm(this.dialog, { title: words.deleteTitle, lines: [], notes: [words.deleteText], confirmLabel: words.delete, danger: true });
    if (!yes || this.openedFor !== room.chatRoomId) return;
    await this.run(async () => {
      const res = await this.api.deleteMessage(room.chatRoomId, messageId);
      if (this.openedFor !== room.chatRoomId) return res;
      if (!res.ok) {
        const sentence = this.refusedChange(res);
        if (sentence === null) return res;
        await this.poll(false);
        throw new Error(sentence);
      }
      if (this.editing()?.messageId === messageId) this.endEdit();
      this.drawChange(room, messageId, { kind: 'delete', position: res.body.position });
      await this.poll(false);
      void this.tellSeen();
      return res;
    });
  }

  /** The wallet's own sentence for the two refusals of /edit-message and /delete-message that a person can meet through the menu (2026-11-24; forclaude/chat-edit-delete-plan-1.md, section 7): `409 too late to edit`, when the 15 minutes passed by the masterpod's clock, and `409 message deleted`, when the message was deleted meanwhile, from another device of the same person. Null for every other answer, which shows as the page shows a refusal. */
  private refusedChange(res: ApiResponse<unknown>): string | null {
    if (res.ok || res.status !== 409) return null;
    const reason = (res.body as Partial<ApiError> | null)?.error;
    if (reason === 'too late to edit') return this.t().chatRoom.tooLateToEdit;
    if (reason === 'message deleted') return this.t().chatRoom.alreadyDeleted;
    return null;
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
    this.readError = null;
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

/** The thread in the order of the positions, a bubble that is still being sent last (2026-11-25; forclaude/chat-rooms-kept-plan-1.md, section 7: a row that comes twice changes nothing). A thread that is in that order already is answered as it is. */
function inOrder(list: ShownMessage[]): ShownMessage[] {
  const at = (m: ShownMessage) => (m.pending ? Number.MAX_SAFE_INTEGER : m.position);
  return list.every((m, i) => i === 0 || at(list[i - 1]) <= at(m)) ? list : [...list].sort((a, b) => at(a) - at(b));
}

/** The newest row that names a message, as a room's copy holds it (2026-11-25; room-copies.service): the page's own, with the text of an edit kept as the text, or as "did not open". */
function keptChange(change: Change): KeptChange {
  if (change.kind === 'delete') return change;
  return { kind: change.kind, position: change.position, text: change.text.opened ? { opened: true, text: change.text.text } : { opened: false } };
}
