import { Injectable, Signal, WritableSignal, inject, signal } from '@angular/core';
import { PROFILE_READS_AT_ONCE } from '../constants';
import { MasterpodApiService, Profile } from './masterpod-api.service';

/**
 * Profiles by anopod id for the avatars (wallet spec 8.3 and 8.6): one
 * /get-anopod-profile per id for the tab's life, quiet, as a signal that is
 * undefined while the read runs, null when the masterpod has no such pod,
 * else the profile with its selfie. A read that fails for another reason
 * answers null and is forgotten, so the next ask tries again. At most
 * PROFILE_READS_AT_ONCE reads are in flight at a time (2026-11-08); the
 * other ids wait in a queue, oldest ask first, so a page with many faces
 * gets them a few at a time and one huge picture delays only its own card.
 */
@Injectable({ providedIn: 'root' })
export class ProfileCacheService {
  private readonly api = inject(MasterpodApiService);
  private readonly cache = new Map<string, WritableSignal<Profile | null | undefined>>();
  /** The entries whose read has not started yet. */
  private readonly queue: { anopodId: string; entry: WritableSignal<Profile | null | undefined> }[] = [];
  private inFlight = 0;

  profile(anopodId: string): Signal<Profile | null | undefined> {
    let entry = this.cache.get(anopodId);
    if (!entry) {
      entry = signal<Profile | null | undefined>(undefined);
      this.cache.set(anopodId, entry);
      this.queue.push({ anopodId, entry });
      this.pump();
    }
    return entry.asReadonly();
  }

  /** Starts reads from the front of the queue while fewer than PROFILE_READS_AT_ONCE are in flight. */
  private pump(): void {
    while (this.inFlight < PROFILE_READS_AT_ONCE && this.queue.length > 0) {
      const { anopodId, entry } = this.queue.shift() as { anopodId: string; entry: WritableSignal<Profile | null | undefined> };
      this.inFlight += 1;
      void this.load(anopodId, entry);
    }
  }

  private async load(anopodId: string, entry: WritableSignal<Profile | null | undefined>): Promise<void> {
    try {
      const res = await this.api.getAnopodProfile(anopodId, true);
      entry.set(res.ok ? res.body : null);
      if (!res.ok && res.status !== 404) this.cache.delete(anopodId);
    } finally {
      this.inFlight -= 1;
      this.pump();
    }
  }
}
