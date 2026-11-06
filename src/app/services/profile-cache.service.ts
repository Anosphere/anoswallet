import { Injectable, Signal, WritableSignal, inject, signal } from '@angular/core';
import { MasterpodApiService, Profile } from './masterpod-api.service';

/**
 * Profiles by anopod id for the avatars (wallet spec 8.3 and 8.6): one
 * /get-anopod-profile per id for the tab's life, quiet, as a signal that is
 * undefined while the read runs, null when the masterpod has no such pod,
 * else the profile with its selfie. A read that fails for another reason
 * answers null and is forgotten, so the next ask tries again.
 */
@Injectable({ providedIn: 'root' })
export class ProfileCacheService {
  private readonly api = inject(MasterpodApiService);
  private readonly cache = new Map<string, WritableSignal<Profile | null | undefined>>();

  profile(anopodId: string): Signal<Profile | null | undefined> {
    let entry = this.cache.get(anopodId);
    if (!entry) {
      entry = signal<Profile | null | undefined>(undefined);
      this.cache.set(anopodId, entry);
      void this.load(anopodId, entry);
    }
    return entry.asReadonly();
  }

  private async load(anopodId: string, entry: WritableSignal<Profile | null | undefined>): Promise<void> {
    const res = await this.api.getAnopodProfile(anopodId, true);
    entry.set(res.ok ? res.body : null);
    if (!res.ok && res.status !== 404) this.cache.delete(anopodId);
  }
}
