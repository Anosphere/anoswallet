import { Component, computed, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { LanguageService } from '../services/language.service';
import { SessionService } from '../services/session.service';

/**
 * The Account page (wallet spec 8.2): the way back to the recovery
 * walkthrough once the next-step rule has stopped sending people there. Three
 * rows: Recovery selfie and Recovery details, each with what the status
 * counts on file, opening the walkthrough at the selfie or at the ID, and,
 * since 2026-11-18, Passkeys, which opens the Passkeys page
 * (/account/passkeys): the anoPod's passkeys, and adding one. The
 * status only counts, since every photo and line is encrypted, so the rows
 * say how many, never which.
 */
@Component({
  selector: 'app-account-home-page',
  imports: [RouterLink, MatCardModule, MatListModule, MatIconModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().common.yourAccount }}</mat-card-title>
        <mat-card-subtitle>{{ t().common.accountRecovery }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p>{{ t().accountHome.intro }}</p>
        <mat-nav-list>
          <a mat-list-item routerLink="/account/recovery/selfie">
            <mat-icon matListItemIcon>photo_camera</mat-icon>
            <span matListItemTitle>{{ t().accountHome.selfieTitle }}</span>
            <span matListItemLine>{{ selfieLine() }}</span>
          </a>
          <a mat-list-item routerLink="/account/recovery/details">
            <mat-icon matListItemIcon>badge</mat-icon>
            <span matListItemTitle>{{ t().accountHome.detailsTitle }}</span>
            <span matListItemLine>{{ detailsLine() }}</span>
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
    p { max-width: 640px; }
  `,
})
export class AccountHomePage {
  private readonly session = inject(SessionService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  protected readonly selfieLine = computed(() => {
    const selfies = this.session.status()?.bucketOneImages ?? 0;
    return selfies === 0 ? this.t().accountHome.noneOnFile : this.t().accountHome.selfiesOnFile(selfies);
  });

  protected readonly detailsLine = computed(() => {
    const status = this.session.status();
    const photos = status?.bucketTwoImages ?? 0;
    const details = status?.bucketTwoInfos ?? 0;
    return photos + details === 0 ? this.t().accountHome.noneOnFile : this.t().accountHome.detailsOnFile(photos, details);
  });
}
