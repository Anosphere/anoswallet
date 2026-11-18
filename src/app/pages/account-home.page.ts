import { Component, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';

/**
 * The Account page (wallet spec 8.2), at /account: a plain list under its
 * title, one row per thing, each with an icon, a title and one line. Two
 * rows: Account recovery, which opens the Account recovery page
 * (/account/recovery), and, since 2026-11-18, Passkeys, which opens the
 * Passkeys page (/account/passkeys). A new row goes under the last one.
 * The page reads nothing. Until 2026-11-18 it carried the two recovery
 * rows itself, under a subtitle and a sentence about recovery.
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
        </mat-nav-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    /* A Material list row has a fixed height and cuts its line at the row's width; here a row grows with its line and the line wraps onto a second one, so nothing is cut on a phone, and a row whose line fits keeps its 64px. */
    a[mat-list-item] { height: auto; min-height: 64px; padding-bottom: 6px; }
    a[mat-list-item] [matListItemLine] { white-space: normal; }
  `,
})
export class AccountHomePage {
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
}
