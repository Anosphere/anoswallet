import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { ChatService } from '../services/chat.service';
import { LanguageService } from '../services/language.service';
import { ApiResponse, reasonOf } from '../services/log.service';
import { Profile, RoomItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';

/** The person of a case as its page has them: the pod and its username. */
type Person = Pick<Profile, 'anopodId' | 'username'>;

/**
 * The attestor's Start chat button on a case page (wallet spec 8.7 and
 * 13.3), under the person's facts on the trade case, the dispute case (one
 * for the seller, one for the buyer) and the recovery case. It reads the
 * chat this pod has with the person about the case (ChatService
 * caseRoomWith, live from session.chatRooms). No chat yet: Start chat,
 * while the case is open, which makes a private room about the case and
 * invites the person. The person invited: Open chat, to the conversation,
 * and "somchai has not accepted the chat yet.". The person in the chat:
 * Open chat. The person in neither: "somchai did not accept the chat."
 * and, while the case is open, Invite again, into the same room. The two
 * buttons that write are off while one of them runs and without chat keys
 * ("No chat keys in this tab: unlock again."). A refusal shows in red
 * under the button: the masterpod's 403 not an attestor as "This anoPod is
 * not an attestor.", the rest as the masterpod says it.
 */
@Component({
  selector: 'app-case-chat-start',
  imports: [RouterLink, MatButtonModule],
  template: `
    @if (person(); as who) {
      <div class="row">
        @if (room(); as room) {
          @if (inRoom(room, who)) {
            <a mat-stroked-button [routerLink]="['/chat', room.chatRoomId]">{{ t().common.openChat }}</a>
            @if (!joined(room, who)) {
              <span class="muted">{{ t().caseChat.notAccepted(who.username) }}</span>
            }
          } @else {
            <span class="muted">{{ t().caseChat.declined(who.username) }}</span>
            @if (open()) {
              <button mat-stroked-button type="button" (click)="again(room, who)" [disabled]="busy() || !session.hasChatKeys()">{{ t().caseChat.inviteAgain }}</button>
            }
          }
        } @else if (open()) {
          <button mat-stroked-button type="button" (click)="start(who)" [disabled]="busy() || !session.hasChatKeys()">{{ t().caseChat.start }}</button>
        }
      </div>
      @if (writes(who) && !session.hasChatKeys()) {
        <p class="error">{{ t().common.noChatKeysUnlock }}</p>
      }
      @if (error(); as text) {
        <p class="error">{{ text }}</p>
      }
    }
  `,
  styles: `
    :host { display: block; margin-top: 8px; }
    .row { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); margin: 8px 0 0; }
  `,
})
export class CaseChatStartComponent {
  /** The case the chat is about. */
  readonly caseId = input.required<string>();
  /** The person the chat is with: the profile the case page has, or null, which draws nothing. */
  readonly person = input.required<Person | null>();
  /** False on a closed case: no new chat and no new invite; Open chat stays. */
  readonly open = input.required<boolean>();

  protected readonly session = inject(SessionService);
  private readonly chat = inject(ChatService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** The chat this pod has with the person about the case, or null. */
  protected readonly room = computed(() => {
    const who = this.person();
    return who ? this.chat.caseRoomWith(this.caseId(), who.anopodId) : null;
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True when the person is a member of the room. */
  protected joined(room: RoomItem, who: Person): boolean {
    return room.members.some((m) => m.anopodId === who.anopodId);
  }

  /** True when the person is a member of the room or invited to it; false for the room of a person who declined. */
  protected inRoom(room: RoomItem, who: Person): boolean {
    return this.joined(room, who) || room.invited.some((m) => m.anopodId === who.anopodId);
  }

  /** True while one of the two buttons that write shows: Start chat, or Invite again. */
  protected writes(who: Person): boolean {
    const room = this.room();
    return this.open() && (room === null || !this.inRoom(room, who));
  }

  protected start(who: Person): Promise<void> {
    return this.run(() => this.chat.startCaseChat(this.caseId(), who.anopodId));
  }

  protected again(room: RoomItem, who: Person): Promise<void> {
    return this.run(() => this.chat.inviteAgain(room, who.anopodId));
  }

  private async run(action: () => Promise<ApiResponse<unknown>>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await action();
      if (!res.ok) this.error.set(this.refusal(res));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** A refusal in words: the masterpod's 403 not an attestor as the attesting pages say it, the rest as the masterpod says it. */
  private refusal(res: ApiResponse<unknown>): string {
    const reason = reasonOf(res);
    return res.status === 403 && /not an attestor/.test(reason) ? this.t().attesting.notAttestor : reason;
  }
}
