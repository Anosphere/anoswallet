import { Injectable, inject, signal } from '@angular/core';
import { millionthsToAnos } from '../amounts';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse } from './log.service';
import { InviteItem, MasterpodApiService, RoomItem, RoomListing, RoomMember, RoomNews, RoomsAnswer, RoomsRead, SeenItem } from './masterpod-api.service';
import { Bytes } from './passkey.service';
import { RoomCopiesService } from './room-copies.service';
import { SessionService } from './session.service';

/** A piece of a shown message: plain text, or an account id, which shows in code font with a copy button (wallet spec 8.5), the button not for the two traders of a marketplace chat (2026-11-19). */
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

/** True for a room that /list-chat-rooms sent whole; false for the three fields of a room of which only the newest message is new (2026-11-24). */
function isWhole(entry: RoomItem | RoomNews): entry is RoomItem {
  return 'type' in entry;
}

/**
 * A room that /list-chat-rooms sent whole, as it goes into the list in
 * memory in the place of the entry the list holds for it (2026-11-24): a
 * member's seen position does not fall. An answer of /list-chat-rooms can
 * arrive after a newer answer of the open conversation's own read, and
 * that read hands out a position only once, when it has changed. The
 * masterpod itself never lowers one.
 */
function keepSeen(room: RoomItem, held: RoomItem | undefined): RoomItem {
  if (!held) return room;
  const before = new Map(held.members.map((member) => [member.anopodId, member.seenPosition]));
  let kept = false;
  const members = room.members.map((member) => {
    const was = before.get(member.anopodId);
    if (was === undefined || member.seenPosition === undefined || was <= member.seenPosition) return member;
    kept = true;
    return { ...member, seenPosition: was };
  });
  return kept ? { ...room, members } : room;
}

/** `held` with each of `news` in it: in the place of the entry with the same id, else at the end, where the masterpod's list has the newest. The same list when nothing came. */
function putEach<T>(held: T[], news: T[], idOf: (item: T) => string): T[] {
  if (news.length === 0) return held;
  const list = [...held];
  for (const item of news) {
    const index = list.findIndex((entry) => idOf(entry) === idOf(item));
    if (index === -1) list.push(item);
    else list[index] = item;
  }
  return list;
}

/**
 * The list in memory with an answer to a read with `since` put into it
 * (2026-11-24; wallet spec 4.17). A room that came whole takes the place
 * of the one the list holds, or is added at the front, where the
 * masterpod's list has the newest room; several new rooms stay in the
 * answer's order, the newest first. Three fields change that room's
 * newest message. An invite or a join request is added at the end.
 * `unknown` says that three fields came for a room the list does not
 * hold. The same list, not a copy, when the answer holds nothing.
 */
function withNews(list: RoomsAnswer, answer: RoomsRead): { list: RoomsAnswer; unknown: boolean } {
  if (answer.rooms.length + answer.invites.length + answer.joinRequests.length === 0) return { list, unknown: false };
  const rooms = [...list.rooms];
  const places = new Map(rooms.map((room, index) => [room.chatRoomId, index]));
  const added: RoomItem[] = [];
  let unknown = false;
  for (const entry of answer.rooms) {
    const index = places.get(entry.chatRoomId);
    if (isWhole(entry)) {
      if (index === undefined) added.push(entry);
      else rooms[index] = keepSeen(entry, rooms[index]);
    } else if (index === undefined) {
      unknown = true;
    } else {
      rooms[index] = { ...rooms[index], lastMessage: entry.lastMessage, lastPosition: entry.lastPosition };
    }
  }
  return {
    list: {
      rooms: [...added, ...rooms],
      invites: putEach(list.invites, answer.invites, (invite) => invite.inviteId),
      joinRequests: putEach(list.joinRequests, answer.joinRequests, (request) => request.joinRequestId),
    },
    unknown,
  };
}

/**
 * What the chat pages share (wallet spec 8.2, Chat, and 8.3): the room keys
 * and their wraps for other pods, decrypting a message, a room's title and
 * kind, the order by latest activity, the short times of the list and the
 * day labels of a conversation, the rooms this tab asked to join, and the
 * refresh of the room list into the session. Since 2026-11-12 also the
 * chats about an attestor case, for the case pages (wallet spec 13.3): the
 * attestor's room with a person, the person's rooms and invites, Start
 * chat and Invite again. And, for the attestor in a marketplace chat
 * (wallet spec 8.2, Chat; 2026-11-12): whether this pod is one of the two
 * traders of such a chat, the other trader, and the attestors who have a
 * chat with this pod about a case. And since 2026-11-19
 * (forclaude/wallet-chat-and-passkey-plan-1.md) a listing chat's trade in
 * a few words from the reader's own side (tradeWords), which the room's
 * title carries. And since 2026-11-24 (forclaude/chat-list-plan-1.md;
 * wallet spec 4.17) the chat list in memory is kept here: the read of the
 * whole list (refreshRooms), the read of what is new only, which the shell
 * makes every 5 seconds (refreshNews), and the members' seen positions
 * that the open conversation's read brings (putSeen); and the calendar
 * day as a signal (today), which that 5-second read moves, for the words
 * of the chat that depend on today's date. And since 2026-11-25
 * (forclaude/chat-rooms-kept-plan-1.md; wallet spec 8.3) a whole chat
 * list that arrives takes away the copy the browser keeps of every room
 * that is not in it (putWhole; room-copies.service).
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);
  /** The copies the browser keeps of the rooms' threads (2026-11-25): a whole chat list tells it which rooms there are (putWhole). */
  private readonly copies = inject(RoomCopiesService);

  /** The rooms this tab asked to join (public rooms, listings), so their button reads "Requested". */
  readonly requestedRooms = signal<ReadonlySet<string>>(new Set());

  markRequested(chatRoomId: string): void {
    this.requestedRooms.update((set) => new Set(set).add(chatRoomId));
  }

  /**
   * The local calendar day, as a signal (2026-11-24; wallet spec 4.17). The
   * chat list words a row's time by today's date ("14:32", "Yesterday"),
   * and a conversation writes "Today" and "Yesterday" over its days. Both
   * read this signal, so those words are drawn again when the day changes.
   * Every read of what is new looks at the clock (refreshNews, the shell's
   * read of every 5 seconds). Until 2026-11-24 the chat list in memory was
   * set anew every 5 seconds, which drew those words again as a side
   * effect; the list is now set only when something in it changed.
   */
  readonly today = signal(dayOf(new Date()));

  /**
   * /list-chat-rooms for the whole list, quiet, into session.chatRooms; the
   * answer, so a caller can report a refusal. The read after a person's own
   * action, which can take things out of the list, and the first read after
   * a page load or a login. Since 2026-11-24 the answer's `seq` is kept as
   * the list's number (putWhole).
   */
  async refreshRooms(): Promise<ApiResponse<RoomsRead>> {
    const res = await this.api.listChatRooms(true);
    if (res.ok && this.session.hasSession()) this.putWhole(res.body);
    return res;
  }

  /**
   * /list-chat-rooms for what is new only (2026-11-24; wallet spec 4.17;
   * the plan is forclaude/chat-list-plan-1.md): the shell's read of every 5
   * seconds and the Chat page's opening. The request carries the list's
   * number as `since`, and what comes back is put into the list in memory
   * (withNews); when nothing came, the list is not set anew. Then the list
   * is counted. The whole list is read, once (refreshRooms), when a count
   * differs from the answer's `counts`, since something was taken away that
   * no answer names; when three fields came for a room the list does not
   * hold; and when the answer's `seq` is below the `since` that was sent.
   * Otherwise the answer's `seq` is the list's next number. While the list
   * has no number, the first read of a login among them, this is the read
   * of the whole list. An answer without `seq`, from a masterpod of before,
   * is the whole list and is taken as that. An answer is put in only while
   * the list's number is still the `since` it was asked with: a read of
   * the whole list that came in between has more, and the next read brings
   * whatever this one held. The answer is the last read's, so a caller can
   * report a refusal. Every call also looks at the clock, for the words
   * that depend on today's date (today).
   */
  async refreshNews(): Promise<ApiResponse<RoomsRead>> {
    this.today.set(dayOf(new Date()));
    const since = this.session.chatRoomsSeq;
    if (since === null) return this.refreshRooms();
    const res = await this.api.listChatRooms(true, since);
    if (!res.ok || !this.session.hasSession()) return res;
    const answer = res.body;
    if (typeof answer.seq !== 'number' || !answer.counts) {
      this.putWhole(answer);
      return res;
    }
    const list = this.session.chatRooms();
    if (list === null || this.session.chatRoomsSeq !== since) return res;
    if (answer.seq < since) return this.refreshRooms();
    const news = withNews(list, answer);
    if (news.list !== list) this.session.chatRooms.set(news.list);
    const counted = news.list.rooms.length === answer.counts.rooms && news.list.invites.length === answer.counts.invites && news.list.joinRequests.length === answer.counts.joinRequests;
    if (news.unknown || !counted) return this.refreshRooms();
    this.session.chatRoomsSeq = answer.seq;
    return res;
  }

  /**
   * The members' seen positions that the open conversation's read brought
   * (2026-11-24; wallet spec 4.17; /list-messages with `seenSince`),
   * written into that room's entry of the list in memory, where the
   * conversation reads them for "Seen" and "Seen by". A position is only
   * ever raised. An entry for a pod that the list does not hold as a
   * member of the room is passed over: that room comes whole with the next
   * read of the list. The list is set anew only when a position rose.
   */
  putSeen(chatRoomId: string, seen: SeenItem[]): void {
    const list = this.session.chatRooms();
    const index = list ? list.rooms.findIndex((room) => room.chatRoomId === chatRoomId) : -1;
    if (!list || index === -1 || seen.length === 0) return;
    const positions = new Map(seen.map((item) => [item.anopodId, item.seenPosition]));
    let raised = false;
    const members = list.rooms[index].members.map((member) => {
      const position = positions.get(member.anopodId);
      if (position === undefined || position <= (member.seenPosition ?? 0)) return member;
      raised = true;
      return { ...member, seenPosition: position };
    });
    if (!raised) return;
    const rooms = [...list.rooms];
    rooms[index] = { ...rooms[index], members };
    this.session.chatRooms.set({ ...list, rooms });
  }

  /** A whole list from /list-chat-rooms becomes the list in memory, and its `seq` the list's number: null when the answer carries none, a masterpod of before, so the next read asks for the whole list again. Where the list already holds a room, a member's seen position does not fall (keepSeen). Since 2026-11-25 (forclaude/chat-rooms-kept-plan-1.md, section 3.3) the copy the browser keeps of a room's thread is deleted for every room that is not in the list: a room the person left, on this phone or on another. */
  private putWhole(answer: RoomsRead): void {
    const held = new Map((this.session.chatRooms()?.rooms ?? []).map((room) => [room.chatRoomId, room]));
    const rooms = answer.rooms.filter(isWhole).map((room) => keepSeen(room, held.get(room.chatRoomId)));
    this.session.chatRooms.set({
      rooms,
      invites: answer.invites,
      joinRequests: answer.joinRequests,
    });
    this.session.chatRoomsSeq = typeof answer.seq === 'number' ? answer.seq : null;
    this.copies.keepOnly(new Set(rooms.map((room) => room.chatRoomId)));
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

  /** The message's text, or null when this tab has no key for the room or the ciphertext does not open. Since 2026-11-24 also null for a row that came without ciphertext (wallet spec 4.19): a message that was edited or deleted, whose text the masterpod no longer hands out. */
  async decryptMessage(room: RoomItem, message: string | null): Promise<string | null> {
    if (message === null) return null;
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
   * (2026-11-06) the trade in a few words after them, from the reader's own
   * side since 2026-11-19 (tradeWords): "mai · You are selling 100 anos",
   * where it read "mai · Selling 100 anos for THB"; for a private room
   * about an attestor case (2026-11-12) the case's kind in words after
   * them: "attestorjoy · Assisted transfer case".
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
    return room.listing ? `${people} · ${this.tradeWords(room)}` : people;
  }

  /** A listing in a few words, in the app's language (2026-11-06): "Selling 100 anos for THB". Since 2026-11-19 for a request, and for a room's title only where tradeWords finds no seller. */
  listingWords(listing: RoomListing): string {
    const rooms = this.lang.words().rooms;
    const anos = millionthsToAnos(listing.quantity);
    return listing.side === 'sell' ? rooms.selling(anos, listing.currency) : rooms.buying(anos, listing.currency);
  }

  /**
   * A listing chat's trade in a few words from the reader's own side
   * (2026-11-19): "You are selling 100 anos" for the seller, "You are
   * buying 100 anos" for the buyer, and for a guest, who is neither, "mai
   * is selling 100 anos" with the seller's username. The seller is the
   * owner of a sell listing and the other trader of a buy listing, as in
   * marketplace.service's mySide. Empty for a room without a listing.
   */
  tradeWords(room: RoomItem): string {
    const listing = room.listing;
    if (!listing) return '';
    const rooms = this.lang.words().rooms;
    const anos = millionthsToAnos(listing.quantity);
    if (this.isTrader(room)) {
      const owner = listing.owner.anopodId === this.session.anopodId();
      return (listing.side === 'sell') === owner ? rooms.youSelling(anos) : rooms.youBuying(anos);
    }
    const seller =
      listing.side === 'sell'
        ? listing.owner.username
        : [...room.members, ...room.invited].find((m) => m.anopodId === room.creatorAnopodId)?.username;
    return seller ? rooms.theySelling(seller, anos) : this.listingWords(listing);
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

  /**
   * Whether this pod is one of the two traders of a marketplace chat
   * (2026-11-12): a private room about a listing, and this pod is the
   * room's creator, the person who pressed Connect, or the listing's owner.
   * Anyone else in such a room is a guest, as an attestor invited into it is.
   */
  isTrader(room: RoomItem): boolean {
    const me = this.session.anopodId();
    return room.type === 'private' && !!room.listing && (room.creatorAnopodId === me || room.listing.owner.anopodId === me);
  }

  /** For a trader of a marketplace chat (isTrader), the other of the two, the creator or the listing's owner, found among the room's members and its invited; null when that person is in neither, and for every other room. */
  otherTrader(room: RoomItem): RoomMember | null {
    if (!this.isTrader(room) || !room.listing) return null;
    const other = room.creatorAnopodId === this.session.anopodId() ? room.listing.owner.anopodId : room.creatorAnopodId;
    return room.members.find((m) => m.anopodId === other) ?? room.invited.find((m) => m.anopodId === other) ?? null;
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
   * The person's side: the attestors who have a chat with this pod about
   * this case (2026-11-12), for the invite into the marketplace chat of a
   * disputed trade. From this pod's rooms about the case that another pod
   * created, that creator as the room lists its members (id and username),
   * each once: only an attestor makes a room about a case.
   */
  caseAttestors(caseId: string): RoomMember[] {
    const me = this.session.anopodId();
    const attestors = new Map<string, RoomMember>();
    for (const room of this.caseRoomsOf(caseId)) {
      if (room.creatorAnopodId === me) continue;
      const creator = room.members.find((m) => m.anopodId === room.creatorAnopodId);
      if (creator && !attestors.has(creator.anopodId)) attestors.set(creator.anopodId, creator);
    }
    return [...attestors.values()];
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

/** The local calendar day of a time, as a key: the value of ChatService.today. */
function dayOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
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
