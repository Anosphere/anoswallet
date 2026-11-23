import { Component, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RoomPictureCacheService } from '../services/room-picture-cache.service';

/**
 * A room's round mark (wallet spec 8.6; 2026-11-22): the picture of a public
 * room when it has one, else a round grey disc with the icon of the room's
 * kind, as the chat pages drew it before. The picture comes from
 * RoomPictureCacheService, one read per room and pictureAt per tab. While it
 * loads, and when it cannot be shown, the disc stands. In the chat list, at
 * the conversation's top and in its Room picture panel, and in the rows of
 * Find public rooms and New public room.
 */
@Component({
  selector: 'app-room-picture',
  imports: [MatIconModule],
  template: `
    @if (src(); as url) {
      <img class="picture" [src]="url" alt="" [style.width.px]="size()" [style.height.px]="size()" />
    } @else {
      <span class="disc" [style.width.px]="size()" [style.height.px]="size()"><mat-icon>{{ icon() }}</mat-icon></span>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; }
    .picture { border-radius: 50%; object-fit: cover; }
    .disc { border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-surface-container-high); color: var(--mat-sys-on-surface-variant); }
  `,
})
export class RoomPictureComponent {
  /** Which room. */
  readonly chatRoomId = input.required<string>();
  /** When the room's picture was last set, as the room lists give it; null or absent for a room without one. */
  readonly pictureAt = input<string | null | undefined>(null);
  /** The icon of the disc: public, group or storefront (chat.service's icon). */
  readonly icon = input('public');
  /** Width and height in pixels. */
  readonly size = input(40);

  private readonly pictures = inject(RoomPictureCacheService);
  protected readonly src = computed(() => {
    const at = this.pictureAt();
    return at ? (this.pictures.picture(this.chatRoomId(), at)() ?? null) : null;
  });
}
