import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { millionthsToAnos } from '../amounts';
import { countryName } from '../countries';
import { formatPrice, totalOf } from '../prices';
import { ChatService } from '../services/chat.service';
import { LanguageService } from '../services/language.service';
import { MarketplaceService } from '../services/marketplace.service';
import { ListingItem } from '../services/masterpod-api.service';
import { SessionService } from '../services/session.service';
import { AvatarComponent } from './avatar.component';

/**
 * The card of a listing (wallet spec 8.7), on Browse and Your listings:
 * the price first, in bold ("35.50 THB per anos"); then the side, the
 * quantity and the total ("Selling 100 anos · 3,550 THB"); then the
 * owner's avatar (8.6), username, country and when it was posted. Small
 * labels when so: Yours, Closed, Waiting (this pod's room about it, the
 * owner not yet in), Chat open (the owner in). The card is a link to the
 * listing's page.
 */
@Component({
  selector: 'app-listing-card',
  imports: [RouterLink, AvatarComponent],
  template: `
    <a class="card" [routerLink]="['/marketplace', listing().listingId]">
      <span class="top">
        <span class="price">{{ priceLine() }}</span>
        <span class="labels">
          @for (label of labels(); track label) {
            <span class="label">{{ label }}</span>
          }
        </span>
      </span>
      <span class="line">{{ market.sideWords(listing()) }} {{ anos() }} anos · {{ total() }}</span>
      <span class="who">
        <app-avatar [anopodId]="listing().owner.anopodId" [username]="listing().owner.username" [size]="24" />
        <span class="name">{{ listing().owner.username }}</span>
        <span class="muted">· {{ country() }} · {{ chat.shortWhen(listing().createdAt) }}</span>
      </span>
    </a>
  `,
  styles: `
    :host { display: block; }
    .card { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; background: var(--mat-sys-surface); color: inherit; text-decoration: none; }
    .card:hover { background: var(--mat-sys-surface-container); }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .price { font-weight: 700; font-size: 1.1rem; }
    .labels { display: flex; gap: 4px; flex: none; }
    .label { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; background: var(--mat-sys-secondary-container); color: var(--mat-sys-on-secondary-container); white-space: nowrap; }
    .line { font-size: 15px; }
    .who { display: flex; align-items: center; gap: 6px; font-size: 13px; min-width: 0; }
    .name { font-weight: 500; }
    .muted { color: var(--mat-sys-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `,
})
export class ListingCardComponent {
  readonly listing = input.required<ListingItem>();

  protected readonly market = inject(MarketplaceService);
  protected readonly chat = inject(ChatService);
  private readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);

  protected readonly priceLine = computed(() => `${formatPrice(this.listing().price, this.listing().currency)} per anos`);
  protected readonly anos = computed(() => millionthsToAnos(this.listing().quantity));
  protected readonly total = computed(() => formatPrice(totalOf(this.listing().quantity, this.listing().price), this.listing().currency, 0));
  protected readonly country = computed(() => countryName(this.listing().country, this.lang.tag()));

  /** Yours, Closed, and for someone else's listing Waiting or Chat open, from this pod's room about it. */
  protected readonly labels = computed(() => {
    const listing = this.listing();
    const labels: string[] = [];
    const mine = listing.owner.anopodId === this.session.anopodId();
    if (mine) labels.push('Yours');
    if (listing.status === 'closed') labels.push('Closed');
    if (!mine) {
      const state = this.market.stateOf(listing);
      if (state === 'waiting') labels.push('Waiting');
      if (state === 'open') labels.push('Chat open');
    }
    return labels;
  });
}
