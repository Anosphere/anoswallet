import { Injectable, inject, signal } from '@angular/core';
import { millionthsToAnos } from '../amounts';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse } from './log.service';
import { InviteItem, MasterpodApiService, RoomItem, RoomListing, RoomMember, RoomsAnswer } from './masterpod-api.service';
import { Bytes } from './passkey.service';
import { SessionService } from './session.service';

/** A piece of a shown message: plain text, or an account id, which shows in code font with a copy button (wallet spec 8.5). */
export interface Piece {
  text: string;
  accountId: boolean;
}

/** Exactly 64 hex characters with no hex character on either side: how an account id looks in a message. */
export const ACCOUNT_ID_IN_TEXT = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;

/** The text split around its account ids; one plain piece when there is none. */
export function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(ACCOUNT_ID_IN_TEXT)) {
    if (match.index > last) pieces.push({ text: text.slice(last, match.index), accountId: false });
    pieces.push({ text: match[0], accountId: true });
    last = match.index + match[0].length;
  }
  if (last < text.length || pieces.length === 0) pieces.push({ text: text.slice(last), accountId: false });
  return pieces;
}

/** What a room is to its reader: a chat with one other person, a group, a public room, a listing's room. */
export type RoomKind = 'direct' | 'group' | 'public' | 'marketplace';

const DAY_MS = 86_400_000;

/**
 * What the chat pages share (wallet spec 8.2, Chat, and 8.3): the room keys
 * and their wraps for other pods, decrypting a message, a room's title and
 * kind, the order by latest activity, the short times of the list and the
 * day labels of a conversation, the rooms this tab asked to join, and the
 * refresh of the room list into the session. Since 2026-11-12 also the
 * chats about an attestor case, for the case pages (wallet spec 13.3): the
 * attestor's room with a person, the person's rooms and invites, Start
 * chat and Invite again.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The rooms this tab asked to join (public rooms, listings), so their button reads "Requested". */
  readonly requestedRooms = signal<ReadonlySet<string>>(new Set());

  markRequested(chatRoomId: string): void {
    this.requestedRooms.update((set) => new Set(set).add(chatRoomId));
  }

  /** /list-chat-rooms, quiet, into session.chatRooms; the answer, so a caller can report a refusal. */
  async refreshRooms(): Promise<ApiResponse<RoomsAnswer>> {
    const res = await this.api.listChatRooms(true);
    if (res.ok && this.session.hasSession()) this.session.chatRooms.set(res.body);
    return res;
  }

  // --- keys -----------------------------------------------------------------

  /** The room's key: the one kept in the session, else the room's hpkeKey unwrapped with the chat keys and kept; null without chat keys or when the unwrap fails. */
  async roomKeyOf(room: RoomItem): Promise<Bytes | null> {
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

  /** The room's key wrapped to another pod's chat keys, which /get-chat-public-keys supplies: for an invite or an approved join. */
  async wrapFor(chatRoomId: string, anopodId: string): Promise<string> {
    const room = this.session.chatRooms()?.rooms.find((r) => r.chatRoomId === chatRoomId);
    const roomKey = room ? await this.roomKeyOf(room) : this.session.roomKeys.get(chatRoomId);
    if (!roomKey) throw new Error(this.lang.words().common.noRoomKeyInTab);
    const keys = await this.api.getChatPublicKeys([anopodId]);
    const target = keys.ok ? keys.body.keys.find((k) => k.anopodId === anopodId) : undefined;
    if (!target) throw new Error(this.lang.words().common.podHasNoChatKeys);
    return this.crypto.toHex(await this.crypto.wrapRoomKey(roomKey, target.chatPublicKey, target.chatPublicKeyPq));
  }

  /** The message's text, or null when this tab has no key for the room or the ciphertext does not open. */
  async decryptMessage(room: RoomItem, message: string): Promise<string | null> {
    const key = await this.roomKeyOf(room);
    if (!key) return null;
    try {
      return await this.crypto.decryptText(key, message);
    } catch {
      return null;
    }
  }

  // --- how a room reads -----------------------------------------------------

  /**
   * The room's title, in the app's language: a public room's name; an old
   * listing room's "Sell 50 anos for THB"; a private room's other people, the
   * invited marked, or "Just you", and for a private room about a listing
   * (2026-11-06) the listing's words after them: "somchai · Selling 100 anos
   * for THB"; for a private room about an attestor case (2026-11-12) the
   * case's kind in words after them: "attestorjoy · Assisted transfer case".
   */
  title(room: RoomItem): string {
    const rooms = this.lang.words().rooms;
    if (room.type === 'public') return room.name ?? rooms.publicRoom;
    if (room.type === 'marketplace') {
      const listing = room.listing;
      if (!listing) return rooms.listingRoom;
      const anos = millionthsToAnos(listing.quantity);
      return listing.side === 'sell' ? rooms.sell(anos, listing.currency) : rooms.buy(anos, listing.currency);
    }
    const names = [...this.otherMembers(room).map((m) => m.username), ...room.invited.map((m) => rooms.invited(m.username))];
    const people = names.length > 0 ? names.join(', ') : rooms.justYou;
    if (room.caseKind) return `${people} · ${rooms.caseChat[room.caseKind]}`;
    return room.listing ? `${people} · ${this.listingWords(room.listing)}` : people;
  }

  /** A listing in a few words, in the app's language, for a room's title and a request (2026-11-06): "Selling 100 anos for THB". */
  listingWords(listing: RoomListing): string {
    const rooms = this.lang.words().rooms;
    const anos = millionthsToAnos(listing.quantity);
    return listing.side === 'sell' ? rooms.selling(anos, listing.currency) : rooms.buying(anos, listing.currency);
  }

  /** Direct for a private room with exactly one other person, member or invited; else group, public or marketplace. */
  kind(room: RoomItem): RoomKind {
    if (room.type !== 'private') return room.type;
    return this.otherMembers(room).length + room.invited.length === 1 ? 'direct' : 'group';
  }

  /** The one other person of a direct room, member or invited; null for every other room. */
  otherPerson(room: RoomItem): RoomMember | null {
    if (this.kind(room) !== 'direct') return null;
    return this.otherMembers(room)[0] ?? room.invited[0] ?? null;
  }

  /** The icon of a room that is not a direct chat. */
  icon(room: RoomItem): string {
    const kind = this.kind(room);
    return kind === 'public' ? 'public' : kind === 'marketplace' ? 'storefront' : 'group';
  }

  /** When the room was last active: its newest message, else its creation. */
  activityAt(room: RoomItem): string {
    return room.lastMessage?.createdAt ?? room.createdAt;
  }

  /** Newest activity first. */
  sorted(rooms: RoomItem[]): RoomItem[] {
    return [...rooms].sort((a, b) => this.activityAt(b).localeCompare(this.activityAt(a)));
  }

  /** The list's time, in the app's language (the language service's tag and day words): today the time, yesterday "Yesterday", within six days the weekday, else the date, with the year when it is another year. */
  shortWhen(iso: string): string {
    const date = new Date(iso);
    const days = daysAgo(date);
    if (days <= 0) return date.toLocaleTimeString(this.lang.tag(), { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return this.lang.words().dates.yesterday;
    if (days < 7) return date.toLocaleDateString(this.lang.tag(), { weekday: 'short' });
    return date.toLocaleDateString(this.lang.tag(), { day: 'numeric', month: 'short', year: sameYear(date) ? undefined : 'numeric' });
  }

  /** A group's time in a conversation: hours and minutes, in the app's language. */
  timeOf(iso: string): string {
    return new Date(iso).toLocaleTimeString(this.lang.tag(), { hour: '2-digit', minute: '2-digit' });
  }

  /** A conversation's day line, in the app's language: "Today", "Yesterday", else the date in full, with the year when it is another year. */
  dayLabel(iso: string): string {
    const date = new Date(iso);
    const days = daysAgo(date);
    if (days <= 0) return this.lang.words().dates.today;
    if (days === 1) return this.lang.words().dates.yesterday;
    return date.toLocaleDateString(this.lang.tag(), { day: 'numeric', month: 'long', year: sameYear(date) ? undefined : 'numeric' });
  }

  // --- the chats about a case (wallet spec 13.3, 2026-11-12) -------------------

  /**
   * The attestor's side: the room about this case that this pod created with
   * the person in it, a member first, else invited. When there is none: the
   * newest room about this case that this pod created with no member but
   * this pod and nobody invited, which is the room of a person who declined.
   * Else null. Live from session.chatRooms.
   */
  caseRoomWith(caseId: string, anopodId: string): RoomItem | null {
    const me = this.session.anopodId();
    const mine = (this.session.chatRooms()?.rooms ?? []).filter((r) => r.caseId === caseId && r.creatorAnopodId === me);
    const joined = mine.find((r) => r.members.some((m) => m.anopodId === anopodId));
    if (joined) return joined;
    const invited = mine.find((r) => r.invited.some((m) => m.anopodId === anopodId));
    if (invited) return invited;
    const empty = mine.filter((r) => r.invited.length === 0 && r.members.every((m) => m.anopodId === me));
    return empty.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  /** The person's side: the rooms about this case that this pod is in. */
  caseRoomsOf(caseId: string): RoomItem[] {
    return (this.session.chatRooms()?.rooms ?? []).filter((r) => r.caseId === caseId);
  }

  /** The person's side: the invites to this pod into a room about this case. */
  caseInvitesOf(caseId: string): InviteItem[] {
    return (this.session.chatRooms()?.invites ?? []).filter((i) => i.caseId === caseId);
  }

  /**
   * Start chat on a case, the attestor's button: the Message someone flow of
   * New chat, with the case. The person's chat public keys (read first, so a
   * person without them makes no room), a new room key wrapped to this pod,
   * /create-chat-room private with the caseId, the key kept, the person
   * invited with the key wrapped to theirs, the room list refreshed. The
   * answer is the refusal of the call that failed, else the invite's.
   */
  async startCaseChat(caseId: string, anopodId: string): Promise<ApiResponse<unknown>> {
    const chat = this.session.getChatKeys();
    if (!chat) throw new Error(this.lang.words().common.noChatKeys);
    const keys = await this.api.getChatPublicKeys([anopodId]);
    const theirs = keys.ok ? keys.body.keys.find((k) => k.anopodId === anopodId) : undefined;
    if (!theirs) throw new Error(this.lang.words().common.podHasNoChatKeys);
    const roomKey = this.crypto.newRoomKey();
    const ownKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
    const created = await this.api.createChatRoom('private', undefined, this.crypto.toHex(ownKey), undefined, caseId);
    if (!created.ok) return created;
    const chatRoomId = created.body.chatRoomId;
    this.session.roomKeys.set(chatRoomId, roomKey);
    const theirKey = this.crypto.toHex(await this.crypto.wrapRoomKey(roomKey, theirs.chatPublicKey, theirs.chatPublicKeyPq));
    const invited = await this.api.inviteToChatRoom(chatRoomId, anopodId, theirKey);
    await this.refreshRooms();
    return invited;
  }

  /** For a person who declined: invited again into the same room, with the room's key wrapped to theirs; the room list refreshed. */
  async inviteAgain(room: RoomItem, anopodId: string): Promise<ApiResponse<{ inviteId: string }>> {
    const theirKey = await this.wrapFor(room.chatRoomId, anopodId);
    const invited = await this.api.inviteToChatRoom(room.chatRoomId, anopodId, theirKey);
    await this.refreshRooms();
    return invited;
  }

  private otherMembers(room: RoomItem): RoomMember[] {
    const me = this.session.anopodId();
    return room.members.filter((m) => m.anopodId !== me);
  }
}

/** Whole days from the start of `date`'s day to the start of today, by the local clock. */
function daysAgo(date: Date): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((today - day) / DAY_MS);
}

function sameYear(date: Date): boolean {
  return date.getFullYear() === new Date().getFullYear();
}
