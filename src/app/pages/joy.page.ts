import { TextFieldModule } from '@angular/cdk/text-field';
import { Component, ElementRef, Injector, afterNextRender, effect, inject, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { askConfirm } from '../components/confirm-dialog.component';
import { JoyService } from '../services/joy.service';
import { LanguageService } from '../services/language.service';

/** While an answer is being written the thread follows it only when the reader is this close to the bottom. */
const FOLLOW_PX = 120;

/**
 * Joy (wallet spec 8.2; 2026-11-24, section 11; 4.18), at /joy: the
 * member's chat with the wallet's AI. One frame as high as the screen
 * leaves: a header with Joy's name, Memory, which goes to the page of the
 * memory file (/joy/memory), and New chat; one line that says what Joy is
 * and that what is written to her leaves the wallet; the thread; and the
 * message box that grows to five lines (Enter sends, Shift+Enter a new
 * line) with the round Send.
 *
 * The member's messages stand at the right, Joy's at the left. Joy's
 * words are drawn as she wrote them, line breaks kept and nothing read as
 * Markdown. An answer shows while it is written, piece by piece as the
 * masterpod hands the pieces on; until its first piece has come, "Joy is
 * writing…" stands in its place. Under an answer that did not end as an
 * answer should stands a grey line that says so: cut off at the model's
 * limit, stopped by the safety check, or cut off in the middle. A message
 * that was refused, or whose answer failed before any of it came, goes
 * back into the message box, with the reason in red above the box.
 *
 * There is one chat. It is kept by joy.service, not by this page, so an
 * answer goes on while the member looks at another page, and the chat is
 * there after a reload of the page. New chat empties it, after a box that
 * asks, since the chat is saved nowhere.
 */
@Component({
  selector: 'app-joy-page',
  imports: [FormsModule, RouterLink, TextFieldModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule],
  template: `
    <div class="joy">
      <header class="head">
        <span class="disc"><mat-icon>auto_awesome</mat-icon></span>
        <h1 class="title">{{ t().joy.title }}</h1>
        <a mat-button routerLink="/joy/memory">{{ t().joy.memory }}</a>
        <button mat-stroked-button type="button" (click)="newChat()" [disabled]="joy.writing() || joy.messages().length === 0">{{ t().joy.newChat }}</button>
      </header>
      <p class="notice">{{ t().joy.notice }}</p>
      <div class="thread" #threadBox>
        @for (m of joy.messages(); track $index) {
          <div class="message" [class.mine]="m.role === 'user'">
            @if (m.text) {
              <div class="bubble">{{ m.text }}</div>
            }
            @if (m.end) {
              <span class="mark">{{ m.end === 'length' ? t().joy.stopLength : m.end === 'refused' ? t().joy.stopRefused : t().joy.cutOff }}</span>
            }
          </div>
        } @empty {
          @if (joy.ready() && joy.answer() === null) {
            <p class="muted empty">{{ t().joy.empty }}</p>
          }
        }
        @if (joy.answer(); as written) {
          <div class="message"><div class="bubble">{{ written }}</div></div>
        } @else if (joy.answer() !== null) {
          <div class="message"><div class="bubble waiting">{{ t().joy.writing }}</div></div>
        }
      </div>
      @if (joy.error(); as text) {
        <p class="error note">{{ text }}</p>
      }
      <div class="composer">
        <mat-form-field appearance="outline" class="grow" subscriptSizing="dynamic">
          <mat-label>{{ t().joy.message }}</mat-label>
          <textarea matInput cdkTextareaAutosize cdkAutosizeMinRows="1" cdkAutosizeMaxRows="5" [ngModel]="joy.draft()" (ngModelChange)="joy.draft.set($event)" (keydown.enter)="enter($event)"></textarea>
        </mat-form-field>
        <button mat-mini-fab type="button" class="send" (click)="send()" [disabled]="joy.writing() || !joy.ready() || !joy.draft().trim()" [attr.aria-label]="t().common.send"><mat-icon>send</mat-icon></button>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; height: calc(100dvh - 64px - 32px); }
    .joy { display: flex; flex-direction: column; height: 100%; max-width: 820px; margin: 0 auto; border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; overflow: hidden; background: var(--mat-sys-surface); }
    .head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .disc { flex: none; width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .title { flex: 1; min-width: 0; margin: 0 0 0 4px; font-size: 1.25rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .notice { flex: none; margin: 0; padding: 6px 12px; font-size: 12px; line-height: 16px; color: var(--mat-sys-on-surface-variant); background: var(--mat-sys-surface-container); border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .thread { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
    .message { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 88%; align-self: flex-start; }
    .message.mine { align-items: flex-end; max-width: 80%; align-self: flex-end; }
    .bubble { padding: 8px 12px; border-radius: 16px; background: var(--mat-sys-surface-container); white-space: pre-wrap; overflow-wrap: anywhere; }
    .message.mine .bubble { background: var(--mat-sys-primary-container); }
    .bubble.waiting { color: var(--mat-sys-on-surface-variant); }
    .mark { font-size: 12px; color: var(--mat-sys-on-surface-variant); margin: 0 8px 2px; }
    .composer { flex: none; display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px; border-top: 1px solid var(--mat-sys-outline-variant); }
    .grow { flex: 1; min-width: 0; }
    .send { flex: none; margin-bottom: 4px; }
    .note { flex: none; padding: 8px 12px; margin: 0; }
    .empty { text-align: center; margin: auto; max-width: 320px; }
    .muted { color: var(--mat-sys-on-surface-variant); }
    .error { color: var(--mat-sys-error); }
    @media (max-width: 599px) {
      :host { height: calc(100dvh - 56px - 32px); }
    }
  `,
})
export class JoyPage {
  protected readonly joy = inject(JoyService);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;
  private readonly threadBox = viewChild<ElementRef<HTMLElement>>('threadBox');

  constructor() {
    void this.joy.open();
    // The thread follows what is added at its end, a message or the next piece of an answer, while the reader is near the end. A reader who has gone up to read stays there.
    effect(() => {
      this.joy.messages();
      this.joy.answer();
      this.joy.error();
      untracked(() => {
        if (this.nearBottom()) this.scrollToBottom();
      });
    });
  }

  /** Enter sends; Shift+Enter is left to the textarea, a new line, and so is an Enter that only ends a word of an input method. */
  protected enter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.shiftKey || key.isComposing) return;
    event.preventDefault();
    this.send();
  }

  /** The message box's text goes to Joy, and the thread goes to its end. */
  protected send(): void {
    if (this.joy.writing() || !this.joy.ready() || !this.joy.draft().trim()) return;
    void this.joy.send();
    this.scrollToBottom();
  }

  /** New chat: a box asks first, since the chat is saved nowhere and cannot be brought back. */
  protected async newChat(): Promise<void> {
    const words = this.t().joy;
    if (await askConfirm(this.dialog, { title: words.newChatTitle, lines: [], notes: [words.newChatText], confirmLabel: words.newChat })) this.joy.newChat();
  }

  /** True when the reader is within FOLLOW_PX of the thread's bottom, or the thread is not drawn. */
  private nearBottom(): boolean {
    const el = this.threadBox()?.nativeElement;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX;
  }

  private scrollToBottom(): void {
    afterNextRender(
      () => {
        const el = this.threadBox()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      },
      { injector: this.injector },
    );
  }
}
