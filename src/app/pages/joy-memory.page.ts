import { TextFieldModule } from '@angular/cdk/text-field';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { askConfirm } from '../components/confirm-dialog.component';
import { JOY_MEMORY_MAX_BYTES } from '../constants';
import { JoyService, utf8Length } from '../services/joy.service';
import { LanguageService } from '../services/language.service';

/**
 * Joy's memory (wallet spec 8.2; 2026-11-24, section 11; 4.18), at
 * /joy/memory, reached by Memory on the Joy page: the member's memory
 * file, which Joy reads with every message and adds to herself. What it
 * is, in three sentences; the file's text in a box the member can write
 * in; how full the file is, in percent of the masterpod's limit
 * (JOY_MEMORY_MAX_BYTES); Save, which stores the text in the place of
 * the file before; and Delete all, red, which stores an empty file after
 * a box that asks. The file is opened and stored by joy.service. While
 * an answer of Joy's is under way nothing is stored from here, since the
 * answer's last line may bring a file that Joy changed.
 */
@Component({
  selector: 'app-joy-memory-page',
  imports: [FormsModule, RouterLink, TextFieldModule, MatCardModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().joy.memoryTitle }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/joy"><mat-icon>arrow_back</mat-icon> {{ t().joy.title }}</a></p>
        <p>{{ t().joy.memoryWhat }}</p>
        <p>{{ t().joy.memoryYours }}</p>
        <p class="muted">{{ t().joy.memoryKept }}</p>
        @if (joy.memory() === null) {
          @if (!joy.error()) {
            <p class="muted">{{ t().common.reading }}</p>
          }
        } @else {
          <mat-form-field appearance="outline" class="wide" subscriptSizing="dynamic">
            <mat-label>{{ t().joy.memoryLabel }}</mat-label>
            <textarea matInput cdkTextareaAutosize cdkAutosizeMinRows="6" cdkAutosizeMaxRows="18" [ngModel]="text()" (ngModelChange)="edit($event)" [disabled]="busy()"></textarea>
          </mat-form-field>
          <p class="room" [class.error]="over()">{{ over() ? t().joy.memoryOver : t().joy.memoryUsed(percent()) }}</p>
          <div class="buttons">
            <button mat-flat-button type="button" (click)="save()" [disabled]="busy() || joy.writing() || over() || !changed()">{{ t().common.save }}</button>
            <button mat-stroked-button type="button" class="danger" (click)="deleteAll()" [disabled]="busy() || joy.writing() || joy.memory() === ''">{{ t().joy.deleteAll }}</button>
          </div>
          @if (joy.writing()) {
            <p class="muted">{{ t().joy.memoryWait }}</p>
          }
          @if (saved()) {
            <p class="muted">{{ t().joy.memorySaved }}</p>
          }
        }
        @if (error() ?? joy.error(); as text) {
          <p class="error">{{ text }}</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .wide { width: 100%; }
    .room { margin: 4px 0 12px; font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error, .room.error { color: var(--mat-sys-error); }
  `,
})
export class JoyMemoryPage {
  protected readonly joy = inject(JoyService);
  private readonly dialog = inject(MatDialog);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** What the box holds. */
  protected readonly text = signal('');
  /** True once the member has written in the box: the file as read no longer takes the box's place. */
  private readonly touched = signal(false);
  protected readonly busy = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True when the box holds another text than the stored file. */
  protected readonly changed = computed(() => this.text() !== (this.joy.memory() ?? ''));
  /** How full the file would be with the box's text, in percent of the limit, rounded up so a file with anything in it never reads 0. */
  protected readonly percent = computed(() => Math.ceil((utf8Length(this.text()) / JOY_MEMORY_MAX_BYTES) * 100));
  protected readonly over = computed(() => utf8Length(this.text()) > JOY_MEMORY_MAX_BYTES);

  constructor() {
    void this.joy.open();
    // The box shows the file as it was read, and a file that Joy changed meanwhile, until the member writes in the box.
    effect(() => {
      const memory = this.joy.memory();
      untracked(() => {
        if (memory !== null && !this.touched()) this.text.set(memory);
      });
    });
  }

  protected edit(text: string): void {
    this.text.set(text);
    this.touched.set(true);
    this.saved.set(false);
  }

  /** Save: the box's text is stored as the file. */
  protected save(): Promise<void> {
    return this.store(this.text());
  }

  /** Delete all: a box asks first, then an empty file is stored. */
  protected async deleteAll(): Promise<void> {
    const words = this.t().joy;
    if (!(await askConfirm(this.dialog, { title: words.deleteAllTitle, lines: [], notes: [words.deleteAllText], confirmLabel: words.deleteAll, danger: true }))) return;
    await this.store('');
  }

  private async store(text: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.saved.set(false);
    const failure = await this.joy.saveMemory(text);
    this.busy.set(false);
    if (failure !== null) {
      this.error.set(failure);
      return;
    }
    this.text.set(text);
    this.touched.set(false);
    this.saved.set(true);
  }
}
