import { Injectable, inject, signal } from '@angular/core';
import { CryptoService } from './crypto.service';
import { LanguageService } from './language.service';
import { reasonOf } from './log.service';
import { MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/** What settingsBlob holds (wallet spec 7): version 1; `protect` the Protect your passkey answer, absent until setup or the protect page recorded one. */
export interface WalletSettings {
  v: 1;
  protect?: 'on' | 'skipped';
}

/**
 * The small things the wallet remembers for the pod (wallet spec 4.7 and
 * 8.3; 2026-11-07, section 11): one encrypted JSON object on the
 * masterpod, read once per session and written whole. The Protect your
 * passkey answer is the first thing in it; a later thing is one more
 * field, with no masterpod change.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly session = inject(SessionService);
  private readonly api = inject(MasterpodApiService);
  private readonly crypto = inject(CryptoService);
  private readonly lang = inject(LanguageService);

  /** The settings as last read or saved, null until read. */
  readonly settings = signal<WalletSettings | null>(null);

  /**
   * /get-wallet-settings, quiet by default: the blob opened under the
   * encryption key. A null blob, a refusal (in the console, since the call
   * is quiet) or a blob that does not open gives { v: 1 }; without the
   * encryption key the read is skipped and the signal stays null.
   */
  async load(quiet = true): Promise<void> {
    const key = this.session.getEncryptionKey();
    if (!key) return;
    const res = await this.api.getWalletSettings(quiet);
    let settings: WalletSettings = { v: 1 };
    if (!res.ok) {
      console.error(`/get-wallet-settings: ${reasonOf(res)}`);
    } else if (res.body.settingsBlob !== null) {
      try {
        settings = await this.crypto.unwrapJson<WalletSettings>(this.crypto.fromHex(res.body.settingsBlob), key);
      } catch {
        settings = { v: 1 };
      }
    }
    this.settings.set(settings);
  }

  /**
   * The merged object { ...current, ...update, v: 1 } wrapped under the
   * encryption key to /set-wallet-settings, after a load when nothing was
   * read; the signal set on success. A refusal throws
   * "/set-wallet-settings: <reason>"; without the encryption key it throws.
   */
  async save(update: Partial<WalletSettings>): Promise<void> {
    const key = this.session.getEncryptionKey();
    if (!key) throw new Error(this.lang.words().common.noKeyInRam);
    if (this.settings() === null) await this.load();
    const merged: WalletSettings = { ...(this.settings() ?? { v: 1 }), ...update, v: 1 };
    const blob = this.crypto.toHex(await this.crypto.wrapJson(merged, key));
    const res = await this.api.setWalletSettings(blob);
    if (!res.ok) throw new Error(`/set-wallet-settings: ${reasonOf(res)}`);
    this.settings.set(merged);
  }
}
