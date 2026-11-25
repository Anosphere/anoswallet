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
import { JoyService, siteOf } from '../services/joy.service';
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
 * Since 2026-11-24 (wallet spec 4.20) Joy can search the web. While she
 * searches, "Joy is searching the web…" stands where "Joy is writing…"
 * stands, and when she wrote some words before the search, it stands as
 * a small grey line under those words. Under a finished answer for which
 * she cited web pages stands the word Sources and one row for each page:
 * the page's title and, in grey, its site, or the site alone for a page
 * that gave no title. A row is a link that opens the page in a new tab,
 * so the wallet's own tab stays as it is, with its login.
 *
 * Since 2026-11-25 (wallet spec 4.21) Joy can have a picture made. While
 * one is made, "Joy is making a picture…" stands where "Joy is writing…"
 * stands, or as the small grey line under words that she wrote before
 * it. The picture then stands in her answer, above her words, with the
 * button Download directly under it. A tap on the picture does nothing.
 * Download hands the picture over as a file (joy.service's download). A
 * picture whose bytes this browser no longer keeps shows a grey line in
 * its place. The box of New chat says one sentence more when the chat
 * holds a picture, since the pictures go with the chat.
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
            @if (m.picture; as p) {
              @if (joy.pictureUrls()[p.id]; as url) {
                <img class="picture" [src]="url" [alt]="p.description" (load)="pictureDrawn($event)" />
                <button mat-stroked-button type="button" class="download" (click)="joy.download(p.id)"><mat-icon>download</mat-icon>{{ t().joy.download }}</button>
              } @else {
                <span class="mark">{{ t().joy.pictureGone }}</span>
              }
            }
            @if (m.text) {
              <div class="bubble">{{ m.text }}</div>
            }
            @if (m.sources?.length) {
              <div class="sources">
                <span class="sources-title">{{ t().joy.sources }}</span>
                @for (s of m.sources; track s.url) {
                  <a class="source" [href]="s.url" target="_blank" rel="noopener"><span class="source-title">{{ s.title || site(s.url) }}</span>@if (s.title) {<span class="source-site">{{ site(s.url) }}</span>}</a>
                }
              </div>
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
        @if (joy.answer() !== null) {
          <div class="message">
            @if (joy.answerPicture(); as p) {
              @if (joy.pictureUrls()[p.id]; as url) {
                <img class="picture" [src]="url" [alt]="p.description" (load)="pictureDrawn($event)" />
                <button mat-stroked-button type="button" class="download" (click)="joy.download(p.id)"><mat-icon>download</mat-icon>{{ t().joy.download }}</button>
              }
            }
            @if (joy.answer(); as written) {
              <div class="bubble">{{ written }}</div>
              @if (joy.drawing()) {
                <span class="mark">{{ t().joy.drawing }}</span>
              } @else if (joy.searching()) {
                <span class="mark">{{ t().joy.searching }}</span>
              }
            } @else {
              <div class="bubble waiting">{{ joy.drawing() ? t().joy.drawing : joy.searching() ? t().joy.searching : t().joy.writing }}</div>
            }
          </div>
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
    .picture { display: block; width: 280px; max-width: 100%; height: auto; aspect-ratio: auto 1 / 1; border-radius: 16px; background: var(--mat-sys-surface-container); }
    .download { margin: 2px 0 4px; }
    .sources { display: flex; flex-direction: column; align-self: stretch; min-width: 0; margin: 2px 8px 4px; font-size: 13px; }
    .sources-title { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .source { display: flex; align-items: baseline; gap: 6px; min-width: 0; padding: 7px 0; line-height: 18px; color: var(--mat-sys-primary); text-decoration: none; }
    .source-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .source-site { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--mat-sys-on-surface-variant); }
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
    // The thread follows what is added at its end, a message, the next piece of an answer, the line on a search, the line on a picture or the picture itself, while the reader is near the end. A reader who has gone up to read stays there.
    effect(() => {
      this.joy.messages();
      this.joy.answer();
      this.joy.searching();
      this.joy.drawing();
      this.joy.answerPicture();
      this.joy.error();
      untracked(() => {
        if (this.nearBottom()) this.scrollToBottom();
      });
    });
  }

  /** The site of a source's address, which stands beside its title, or in the title's place when the page gave none. */
  protected readonly site = siteOf;

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

  /** New chat: a box asks first, since the chat is saved nowhere and cannot be brought back. When the chat holds a picture that can still be downloaded, the box says one sentence more: the pictures go with the chat. */
  protected async newChat(): Promise<void> {
    const words = this.t().joy;
    const notes = this.joy.hasPictures() ? [words.newChatText, words.newChatPictures] : [words.newChatText];
    if (await askConfirm(this.dialog, { title: words.newChatTitle, lines: [], notes, confirmLabel: words.newChat })) this.joy.newChat();
  }

  /**
   * Called when the browser has opened a picture's bytes. Until then the
   * picture's box is a square, as wide as the picture is drawn; from then
   * on it has the picture's own shape, which is taller for a picture
   * that is higher than wide. A reader who was near the thread's end
   * before the box grew is brought to the end again: without this they
   * would see the picture's top only.
   */
  protected pictureDrawn(event: Event): void {
    const el = this.threadBox()?.nativeElement;
    const picture = event.target as HTMLElement;
    if (!el) return;
    const grew = Math.max(0, picture.offsetHeight - picture.offsetWidth);
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX + grew) this.scrollToBottom();
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
