import { Injectable, Signal, WritableSignal, inject, signal } from '@angular/core';
import { ROOM_PICTURE_READS_AT_ONCE, ROOM_PICTURE_RETRY_MS } from '../constants';
import { IMAGE_CONTENT_TYPES } from '../images';
import { Image, MasterpodApiService } from './masterpod-api.service';

type Entry = WritableSignal<string | null | undefined>;

/**
 * The pictures of public rooms (wallet spec 8.3 and 8.6; 2026-11-22): one
 * /get-chat-room-picture per room and per pictureAt for the tab's life,
 * quiet, as a signal that is undefined while the read runs, null when the
 * room has no picture the wallet can show, else the picture as a data URL
 * for an <img>. pictureAt is when the picture was last set, as the room
 * lists give it: a new picture has a new one, so it is read again. A read
 * that fails for another reason than 404 answers null and is forgotten
 * ROOM_PICTURE_RETRY_MS later, so a picture that is drawn anew after that
 * is asked for again. It is not forgotten at once: the draw that follows a
 * failure would ask again right away, for as long as the masterpod fails.
 * At most ROOM_PICTURE_READS_AT_ONCE reads are in flight at a time; the
 * others wait in a queue, oldest ask first. The tab's life ends at a load
 * of the page, and since 2026-11-22 Lock loads it (app.ts), so the
 * pictures are read again after a Lock.
 */
@Injectable({ providedIn: 'root' })
export class RoomPictureCacheService {
  private readonly api = inject(MasterpodApiService);
  private readonly cache = new Map<string, Entry>();
  /** The entries whose read has not started yet. */
  private readonly queue: { key: string; chatRoomId: string; entry: Entry }[] = [];
  private inFlight = 0;

  picture(chatRoomId: string, pictureAt: string): Signal<string | null | undefined> {
    const key = `${chatRoomId} ${pictureAt}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = signal<string | null | undefined>(undefined);
      this.cache.set(key, entry);
      this.queue.push({ key, chatRoomId, entry });
      this.pump();
    }
    return entry.asReadonly();
  }

  /** The picture this tab has just set, kept under its pictureAt so that it is not read back. */
  put(chatRoomId: string, pictureAt: string, picture: Image): void {
    const key = `${chatRoomId} ${pictureAt}`;
    const entry = this.cache.get(key);
    if (entry) entry.set(dataUrl(picture));
    else this.cache.set(key, signal<string | null | undefined>(dataUrl(picture)));
  }

  /** Starts reads from the front of the queue while fewer than ROOM_PICTURE_READS_AT_ONCE are in flight. */
  private pump(): void {
    while (this.inFlight < ROOM_PICTURE_READS_AT_ONCE && this.queue.length > 0) {
      const { key, chatRoomId, entry } = this.queue.shift() as { key: string; chatRoomId: string; entry: Entry };
      this.inFlight += 1;
      void this.load(key, chatRoomId, entry);
    }
  }

  private async load(key: string, chatRoomId: string, entry: Entry): Promise<void> {
    let picture: string | null = null;
    let failed = false;
    try {
      const res = await this.api.getChatRoomPicture(chatRoomId);
      if (res.ok) picture = dataUrl(res.body.picture);
      else failed = res.status !== 404;
    } catch {
      failed = true;
    }
    entry.set(picture);
    if (failed) setTimeout(() => this.cache.delete(key), ROOM_PICTURE_RETRY_MS);
    this.inFlight -= 1;
    this.pump();
  }
}

/** The picture as a data URL, or null when its type is not one of the three the wallet shows (../images): the type a server names is never passed on unchecked. */
function dataUrl(picture: Image): string | null {
  return IMAGE_CONTENT_TYPES.includes(picture.contentType) ? `data:${picture.contentType};base64,${picture.image}` : null;
}
