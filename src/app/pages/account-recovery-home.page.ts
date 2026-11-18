import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';
import { SessionService } from '../services/session.service';

/**
 * The Account recovery page (wallet spec 8.2; 2026-11-18, section 11), at
 * /account/recovery, reached from the Account page's first row: the way
 * back to the recovery walkthrough once the next-step rule has stopped
 * sending people there. Back to Account, one sentence on what these are
 * for, and two rows, Recovery selfie and Recovery details, each with what
 * the status counts on file, opening the walkthrough at the selfie or at
 * the ID. The status only counts, since every photo and line is
 * encrypted, so the rows say how many, never which. Until 2026-11-18 the
 * sentence and the two rows stood on the Account page itself.
 */
@Component({
  selector: 'app-account-recovery-home-page',
  imports: [RouterLink, MatCardModule, MatListModule, MatButtonModule, MatIconModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.accountRecovery }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/account"><mat-icon>arrow_back</mat-icon> {{ t().nav.account }}</a></p>
        <p>{{ t().accountRecoveryHome.intro }}</p>
        <mat-nav-list>
          <a mat-list-item routerLink="/account/recovery/selfie">
            <mat-icon matListItemIcon>photo_camera</mat-icon>
            <span matListItemTitle>{{ t().accountRecoveryHome.selfieTitle }}</span>
            <span matListItemLine>{{ selfieLine() }}</span>
          </a>
          <a mat-list-item routerLink="/account/recovery/details">
            <mat-icon matListItemIcon>badge</mat-icon>
            <span matListItemTitle>{{ t().accountRecoveryHome.detailsTitle }}</span>
            <span matListItemLine>{{ detailsLine() }}</span>
          </a>
        </mat-nav-list>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    p { max-width: 640px; }
    /* A Material list row has a fixed height and cuts its line at the row's width; here a row grows with its line and the line wraps onto a second one, so nothing is cut on a phone, and a row whose line fits keeps its 64px. */
    a[mat-list-item] { height: auto; min-height: 64px; padding-bottom: 6px; }
    a[mat-list-item] [matListItemLine] { white-space: normal; }
  `,
})
export class AccountRecoveryHomePage {
  private readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly selfieLine = computed(() => {
    const selfies = this.session.status()?.bucketOneImages ?? 0;
    return selfies === 0 ? this.t().accountRecoveryHome.noneOnFile : this.t().accountRecoveryHome.selfiesOnFile(selfies);
  });

  protected readonly detailsLine = computed(() => {
    const status = this.session.status();
    const photos = status?.bucketTwoImages ?? 0;
    const details = status?.bucketTwoInfos ?? 0;
    return photos + details === 0 ? this.t().accountRecoveryHome.noneOnFile : this.t().accountRecoveryHome.detailsOnFile(photos, details);
  });
}
