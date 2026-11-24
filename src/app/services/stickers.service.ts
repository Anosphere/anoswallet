import { Injectable, computed, inject } from '@angular/core';
import { readStickerSets } from '../stickers';
import { MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/**
 * The stickers' list (wallet spec 4.16 and 8.3; 2026-11-23,
 * forclaude/stickers-database-plan-1.md): every set of stickers the
 * masterpod has, in the order of the row of sets, each with its stickers
 * in their order and each sticker with its tag words. Text only: no
 * picture travels with it.
 *
 * The wallet asks for it once after each login, when a conversation is
 * first opened: /list-stickers, a signed ask like every chat ask, and
 * quiet. The conversation page calls load() each time it opens a room,
 * and load() asks only while this login has no list. The answer is kept
 * in the session (session.stickerSets), which a login's end empties. So
 * nothing is asked again before the next login, and there is no timer. A
 * read that is refused or not answered keeps nothing: the next
 * conversation that is opened asks again.
 *
 * The list is for what the wallet offers: the stickers button, the
 * stickers under the message box, and the suggestions while a person
 * types. A sticker that arrives in a message is drawn without it
 * (../stickers). While the list has not arrived, and while the masterpod
 * has no set, `sets` is empty: the chat then has no stickers button and
 * suggests nothing, and looks as it did before the stickers.
 */
@Injectable({ providedIn: 'root' })
export class StickersService {
  private readonly api = inject(MasterpodApiService);
  private readonly session = inject(SessionService);
  private reading = false;

  /** Every set of this login's list, in the order of the row of sets. Empty until the list has arrived, and while the masterpod has no set. */
  readonly sets = computed(() => this.session.stickerSets() ?? []);

  /** Asks the masterpod for the list, unless this login has it already or an ask is on its way. A refusal, no answer and an answer that is no list change nothing. An answer that comes once the login it was asked for has ended is dropped. */
  async load(): Promise<void> {
    const anopodId = this.session.anopodId();
    if (anopodId === null || this.reading || this.session.stickerSets() !== null) return;
    this.reading = true;
    try {
      const res = await this.api.listStickers();
      const sets = res.ok ? readStickerSets(res.body) : null;
      if (sets !== null && this.session.anopodId() === anopodId) this.session.stickerSets.set(sets);
    } catch {
      // No answer: the next conversation that is opened asks again.
    } finally {
      this.reading = false;
    }
  }
}
