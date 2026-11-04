import { Injectable, computed, inject, signal } from '@angular/core';
import { LogService, reasonOf } from './log.service';

/** The three editions of the app (wallet spec 12.1, 13.1): the wallet, or the same app with the moderator or the attestor section switched on. */
export type Edition = 'wallet' | 'moderator' | 'attestor';

/** What GET /api/config answers: the two counts, the threshold, the edition and the relying-party id; the browser never sees an address. */
export interface WalletConfig {
  validators: number;
  keyholders: number;
  shareThreshold: number;
  defaultValidator: number;
  edition: Edition;
  /** The relying-party id of both passkey ceremonies: the proxy's RP_ID. */
  rpId: string;
}

/** The wallet's configuration, fetched from the proxy once (wallet spec 8.3). */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly log = inject(LogService);
  private loading: Promise<WalletConfig> | null = null;

  /** The configuration once loaded. */
  readonly config = signal<WalletConfig | null>(null);

  /** True in the moderator edition (wallet spec 12.1), once the configuration is loaded. */
  readonly moderatorEdition = computed(() => this.config()?.edition === 'moderator');

  /** True in the attestor edition (wallet spec 13.1), once the configuration is loaded. */
  readonly attestorEdition = computed(() => this.config()?.edition === 'attestor');

  /** GET /api/config, once; later calls share the first. */
  load(): Promise<WalletConfig> {
    this.loading ??= this.fetch().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async fetch(): Promise<WalletConfig> {
    const res = await this.log.get<WalletConfig>('/api/config');
    if (!res.ok) throw new Error(`/api/config: ${reasonOf(res)}`);
    this.config.set(res.body);
    return res.body;
  }
}
