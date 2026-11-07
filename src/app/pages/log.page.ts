import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { LanguageService } from '../services/language.service';
import { LogService } from '../services/log.service';

/** /log: the activity log, newest 40 calls, polls excepted (wallet spec 8.2). */
@Component({
  selector: 'app-log-page',
  imports: [MatCardModule, MatButtonModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().log.title }}</mat-card-title>
        <mat-card-subtitle>{{ t().log.subtitle }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <pre class="log">{{ log.text() || t().log.none }}</pre>
      </mat-card-content>
      <mat-card-actions>
        <button mat-button type="button" (click)="log.clear()" [disabled]="log.entries().length === 0">{{ t().common.clear }}</button>
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .log { font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; max-height: 70vh; overflow: auto; }
  `,
})
export class LogPage {
  protected readonly log = inject(LogService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
}
