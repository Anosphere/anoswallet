import { Injectable, computed, inject, signal } from '@angular/core';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { ApiResponse } from './log.service';
import { InviteItem, ListingFilters, ListingItem, MasterpodApiService, RoomItem } from './masterpod-api.service';
import { SessionService } from './session.service';

/** The order of Browse: newest first, or by the price per anos. */
export type SortKey = 'newest' | 'priceLow' | 'priceHigh';

/** The browse filters the masterpod applies (wallet spec 8.2, Marketplace): one side or both, a country, a currency, the order. */
export interface BrowseFilters {
  side: 'buy' | 'sell' | null;
  country: string | null;
  currency: string | null;
  sort: SortKey;
}

/** What someone else's listing is to this pod: no room of mine yet, the owner invited, the owner in, or the owner gone without accepting. */
export type ListingState = 'connect' | 'waiting' | 'open' | 'declined';

/** This pod's side in a chat about a listing. */
export type MySide = 'seller' | 'buyer';

/** The fields the side words and the roles need: a ListingItem or a RoomListing. */
export interface ListingLike {
  side: 'buy' | 'sell';
  owner: { anopodId: string };
}

/** The last country and currency picked on this device. */
export interface Remembered {
  country: string | null;
  currency: string | null;
}

const REMEMBERED_KEY = 'anopod-wallet.marketplace-filters';

/** Browse loads this many open listings at most; the ranges are applied on the phone over them. */
export const BROWSE_LIMIT = 200;

const SORTS: Record<SortKey, Pick<ListingFilters, 'sortBy' | 'sortDirection'>> = {
  newest: { sortBy: 'createdAt', sortDirection: 'desc' },
  priceLow: { sortBy: 'price', sortDirection: 'asc' },
  priceHigh: { sortBy: 'price', sortDirection: 'desc' },
};

/**
 * What the marketplace pages share (wallet spec 8.2, Marketplace, and 8.3;
 * 2026-11-06, section 11): the reads, the words of a listing's side and
 * this pod's role in a chat about it, the rooms and invites about a listing
 * out of session.chatRooms, the state of someone else's listing for this
 * pod, Connect (a private room about the listing, the owner invited, the
 * first message) and Connect again, and the country and currency this
 * device last picked.
 */
@Injectable({ providedIn: 'root' })
export class MarketplaceService {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly chat = inject(ChatService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The invites to this pod that carry a listing: people waiting on this pod's listings, for the Your listings row. */
  readonly waitingCount = computed(() => (this.session.chatRooms()?.invites ?? []).filter((i) => i.listingId !== null).length);

  /** The last country and currency, kept on this device under anopod-wallet.marketplace-filters; empty when the browser refuses. */
  readonly remembered = signal<Remembered>(readRemembered());

  // --- the reads --------------------------------------------------------------

  /** /list-listings: the open listings matching the filters, up to BROWSE_LIMIT. */
  load(filters: BrowseFilters): Promise<ApiResponse<{ listings: ListingItem[] }>> {
    const query: ListingFilters = { status: 'open', limit: BROWSE_LIMIT, ...SORTS[filters.sort] };
    if (filters.side) query.side = filters.side;
    if (filters.country) query.country = filters.country;
    if (filters.currency) query.currency = filters.currency;
    return this.api.listListings(query);
  }

  /** /get-listing: one listing, open or closed. */
  get(listingId: string): Promise<ApiResponse<{ listing: ListingItem }>> {
    return this.api.getListing(listingId);
  }

  /** /list-listings with mine: this pod's own listings, open and closed. */
  mine(): Promise<ApiResponse<{ listings: ListingItem[] }>> {
    return this.api.listListings({ mine: true, status: 'any', limit: BROWSE_LIMIT });
  }

  /** /close-listing. */
  close(listingId: string): Promise<ApiResponse<{ listingId: string; status: string }>> {
    return this.api.closeListing(listingId);
  }

  // --- words and roles ----------------------------------------------------------

  /** "Selling" or "Buying", from the owner's side, in the app's language. */
  sideWords(listing: { side: 'buy' | 'sell' }): string {
    const market = this.lang.words().market;
    return listing.side === 'sell' ? market.selling : market.buying;
  }

  /** This pod's side in a chat about the listing: the owner of a sell listing and the other person of a buy listing are the seller. */
  mySide(listing: ListingLike): MySide {
    const owner = listing.owner.anopodId === this.session.anopodId();
    return (listing.side === 'sell') === owner ? 'seller' : 'buyer';
  }

  /** The ready-made first message of Connect (decision 3 of the plan), in the sender's language (wallet spec 8.8). */
  firstWords(listing: { side: 'buy' | 'sell' }): string {
    const market = this.lang.words().market;
    return listing.side === 'sell' ? market.firstSell : market.firstBuy;
  }

  // --- the rooms and invites about a listing, live from session.chatRooms ------

  /** The private rooms about the listing that this pod is in. */
  roomsAbout(listingId: string): RoomItem[] {
    return (this.session.chatRooms()?.rooms ?? []).filter((r) => r.type === 'private' && r.listing?.listingId === listingId);
  }

  /** The room about the listing that this pod created, or null: its own connection. */
  myRoomAbout(listingId: string): RoomItem | null {
    const me = this.session.anopodId();
    return this.roomsAbout(listingId).find((r) => r.creatorAnopodId === me) ?? null;
  }

  /** The invites to this pod about the listing: the people waiting on the owner. */
  invitesAbout(listingId: string): InviteItem[] {
    return (this.session.chatRooms()?.invites ?? []).filter((i) => i.listingId === listingId);
  }

  /** Someone else's listing for this pod, from its own room about it: none yet, the owner invited, the owner a member, or neither. */
  stateOf(listing: ListingItem): ListingState {
    const room = this.myRoomAbout(listing.listingId);
    if (!room) return 'connect';
    const owner = listing.owner.anopodId;
    if (room.members.some((m) => m.anopodId === owner)) return 'open';
    if (room.invited.some((m) => m.anopodId === owner)) return 'waiting';
    return 'declined';
  }

  // --- Connect ------------------------------------------------------------------

  /**
   * The Message someone flow of New chat, with the listing: the owner's chat
   * public keys (read first, so an owner without them makes no room), a new
   * room key wrapped to this pod, /create-chat-room private with the
   * listingId, the key kept, the owner invited with the key wrapped to
   * theirs, the first message sent encrypted, the room list refreshed. The
   * answer is the first one that failed, else the message's.
   */
  async connect(listing: ListingItem, text: string): Promise<ApiResponse<unknown>> {
    const chat = this.session.getChatKeys();
    if (!chat) throw new Error(this.lang.words().common.noChatKeys);
    const owner = listing.owner.anopodId;
    const keys = await this.api.getChatPublicKeys([owner]);
    const theirs = keys.ok ? keys.body.keys.find((k) => k.anopodId === owner) : undefined;
    if (!theirs) throw new Error(this.lang.words().common.podHasNoChatKeys);
    const roomKey = this.crypto.newRoomKey();
    const ownKey = await this.crypto.wrapRoomKey(roomKey, this.crypto.toHex(chat.p256Public), this.crypto.toHex(chat.kemPublic));
    const created = await this.api.createChatRoom('private', undefined, this.crypto.toHex(ownKey), listing.listingId);
    if (!created.ok) return created;
    const chatRoomId = created.body.chatRoomId;
    this.session.roomKeys.set(chatRoomId, roomKey);
    const theirKey = this.crypto.toHex(await this.crypto.wrapRoomKey(roomKey, theirs.chatPublicKey, theirs.chatPublicKeyPq));
    const invited = await this.api.inviteToChatRoom(chatRoomId, owner, theirKey);
    if (!invited.ok) {
      await this.chat.refreshRooms();
      return invited;
    }
    const sent = await this.api.sendMessage(chatRoomId, await this.crypto.encryptText(roomKey, text));
    await this.chat.refreshRooms();
    return sent;
  }

  /** For a declined room: the owner invited again with the room's key wrapped to theirs, and the message into the same room. */
  async connectAgain(room: RoomItem, text: string): Promise<ApiResponse<unknown>> {
    const owner = room.listing?.owner.anopodId;
    if (!owner) throw new Error(this.lang.words().common.notAboutListing);
    const theirKey = await this.chat.wrapFor(room.chatRoomId, owner);
    const invited = await this.api.inviteToChatRoom(room.chatRoomId, owner, theirKey);
    if (!invited.ok) return invited;
    const roomKey = await this.chat.roomKeyOf(room);
    if (!roomKey) throw new Error(this.lang.words().common.noRoomKeyInTab);
    const sent = await this.api.sendMessage(room.chatRoomId, await this.crypto.encryptText(roomKey, text));
    await this.chat.refreshRooms();
    return sent;
  }

  // --- what this device remembers -----------------------------------------------

  /** A country or currency picked: kept, and written to this device. */
  remember(update: Partial<Remembered>): void {
    const next = { ...this.remembered(), ...update };
    this.remembered.set(next);
    try {
      localStorage.setItem(REMEMBERED_KEY, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage: the tab keeps its copy.
    }
  }
}

/** The remembered country and currency, empty when there are none or the browser refuses. */
function readRemembered(): Remembered {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? '{}');
    const map = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      country: typeof map['country'] === 'string' ? map['country'] : null,
      currency: typeof map['currency'] === 'string' ? map['currency'] : null,
    };
  } catch {
    return { country: null, currency: null };
  }
}
