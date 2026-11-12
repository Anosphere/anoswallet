import { Component, computed, inject, input } from '@angular/core';
import { ProfileCacheService } from '../services/profile-cache.service';

/**
 * The avatar (wallet spec 8.6): a round selfie when the pod's profile has
 * one, else a round disc in the primary-container colour with the first
 * letter of the username. The profile comes from ProfileCacheService, one
 * read per pod per tab. In the chat list, the conversation header, the
 * members panel and the chat requests; since 2026-11-06 on the listing
 * cards, the listing page, the people who connected, the pinned listing
 * card and Home; since 2026-11-08 on the Vouch requests page and the DAO
 * proposal page; since 2026-11-12 in the person's chats about a case, on
 * My case and My recovery case, and beside each attestor in the
 * conversation's "Invite an attestor" panel.
 */
@Component({
  selector: 'app-avatar',
  template: `
    @if (selfie(); as src) {
      <img class="face" [src]="src" [alt]="username()" [style.width.px]="size()" [style.height.px]="size()" />
    } @else {
      <span class="letter" [style.width.px]="size()" [style.height.px]="size()" [style.font-size.px]="size() * 0.45">{{ letter() }}</span>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; }
    .face { border-radius: 50%; object-fit: cover; }
    .letter { border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); font-weight: 500; text-transform: uppercase; }
  `,
})
export class AvatarComponent {
  /** Whose face. */
  readonly anopodId = input.required<string>();
  /** Their username, for the letter and the alt text. */
  readonly username = input('');
  /** Width and height in pixels. */
  readonly size = input(40);

  private readonly profiles = inject(ProfileCacheService);
  private readonly profile = computed(() => this.profiles.profile(this.anopodId())());
  protected readonly selfie = computed(() => {
    const selfie = this.profile()?.selfie;
    return selfie ? `data:${selfie.contentType};base64,${selfie.image}` : null;
  });
  protected readonly letter = computed(() => (this.username() || this.profile()?.username || '?').slice(0, 1));
}
