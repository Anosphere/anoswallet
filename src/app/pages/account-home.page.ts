import { Component, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';
import { SoundService } from '../services/sound.service';

/**
 * The Account page (wallet spec 8.2), at /account: a plain list under its
 * title, one row per thing, each with an icon, a title and one line. Five
 * rows: Account recovery, which opens the Account recovery page
 * (/account/recovery); since 2026-11-18, Passkeys, which opens the
 * Passkeys page (/account/passkeys); since 2026-11-18, Public ledger id,
 * which opens the Public ledger id page (/account/ledger-id); since
 * 2026-11-19, Sound, the switch of the wallet's one sound
 * (sound.service.ts; wallet spec 8.1); and, since 2026-11-21, Security
 * alerts, which opens the Security alerts page (/account/alerts). The
 * fourth row is a button where the others are links, and it opens no
 * page: its title reads "Sound: on" or "Sound: off", and a tap turns the
 * sound off or on, on this phone or computer. Turning it on plays the
 * sound once. A new row goes under the last one. The page reads nothing.
 * Until 2026-11-18 it carried the two recovery rows itself, under a
 * subtitle and a sentence about recovery.
 */
@Component({
  selector: 'app-account-home-page',
  imports: [RouterLink, MatCardModule, MatListModule, MatIconModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.yourAccount }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <mat-nav-list>
          <a mat-list-item routerLink="/account/recovery">
            <mat-icon matListItemIcon>lock_reset</mat-icon>
            <span matListItemTitle>{{ t().common.accountRecovery }}</span>
            <span matListItemLine>{{ t().accountHome.recoveryLine }}</span>
          </a>
          <a mat-list-item routerLink="/account/passkeys">
            <mat-icon matListItemIcon>key</mat-icon>
            <span matListItemTitle>{{ t().accountHome.passkeysTitle }}</span>
            <span matListItemLine>{{ t().accountHome.passkeysLine }}</span>
          </a>
          <a mat-list-item routerLink="/account/ledger-id">
            <mat-icon matListItemIcon>fingerprint</mat-icon>
            <span matListItemTitle>{{ t().accountHome.ledgerIdTitle }}</span>
            <span matListItemLine>{{ t().accountHome.ledgerIdLine }}</span>
          </a>
          <button mat-list-item type="button" (click)="sound.setOn(!sound.on())">
            <mat-icon matListItemIcon>{{ sound.on() ? 'volume_up' : 'volume_off' }}</mat-icon>
            <span matListItemTitle>{{ sound.on() ? t().accountHome.soundOn : t().accountHome.soundOff }}</span>
            <span matListItemLine>{{ t().accountHome.soundLine }}</span>
          </button>
          <a mat-list-item routerLink="/account/alerts">
            <mat-icon matListItemIcon>notifications_active</mat-icon>
            <span matListItemTitle>{{ t().accountHome.alertsTitle }}</span>
            <span matListItemLine>{{ t().accountHome.alertsLine }}</span>
          </a>
        </mat-nav-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    /* A Material list row has a fixed height and cuts its line at the row's width; here a row grows with its line and the line wraps onto a second one, so nothing is cut on a phone, and a row whose line fits keeps its 64px. */
    a[mat-list-item], button[mat-list-item] { height: auto; min-height: 64px; padding-bottom: 6px; }
    a[mat-list-item] [matListItemLine], button[mat-list-item] [matListItemLine] { white-space: normal; }
    /* Material takes the browser's own button look off a button row only inside an action list; this row stands in a nav list, so the page does it, with Material's own reset for a button row, word for word. Without it a browser draws an outline around the row and puts its words in the middle. */
    button[mat-list-item] { background: none; color: inherit; border: none; font: inherit; outline: inherit; -webkit-tap-highlight-color: transparent; text-align: start; }
  `,
})
export class AccountHomePage {
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  protected readonly sound = inject(SoundService);
}
