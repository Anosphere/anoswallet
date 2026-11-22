import { Component, WritableSignal, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { AlertDevice, AlertPhone, AlertsService } from '../services/alerts.service';
import { LanguageService } from '../services/language.service';
import { ApiError, ApiResponse, reasonOf } from '../services/log.service';
import { AlertPhoneItem, AlertSettings, MasterpodApiService } from '../services/masterpod-api.service';

/** A code as the masterpod takes it: six digits. */
const CODE = /^[0-9]{6}$/;

/**
 * What the part "This phone" shows, the first of seven that holds, in this
 * order: `off`, the masterpod sends no notifications; `listed`, this
 * browser is on the list, `phone` being its entry; `computer`, a browser
 * tab on a computer; `tab`, a browser tab on a phone, where the steps for
 * the Home Screen show (an iPhone's Safari tab ends here: it has no
 * notifications at all, so nothing below is asked before this);
 * `unsupported`, opened from the Home Screen in a browser that cannot show
 * a notification; `denied`, the person said no to notifications; `ask`,
 * the button that turns the alerts on.
 */
type ThisPhone =
  | { kind: 'off' | 'computer' | 'tab' | 'unsupported' | 'denied' | 'ask'; phone: null }
  | { kind: 'listed'; phone: AlertPhoneItem };

/** What a look at this browser gave: where the wallet runs, the kind of device, the person's answer about notifications, and the hash the list names this browser by, null when it has none. */
interface Seen {
  device: AlertDevice;
  label: string;
  permission: NotificationPermission;
  hash: string | null;
}

/**
 * The Security alerts page (wallet spec 8.2; 2026-11-21, section 11), at
 * /account/alerts: the emails and the phones that are told when a transfer
 * starts to wait in a guarded, a vault or an assisted account, when a
 * recovery is started for the anoPod, and when this list changes (masterpod
 * spec 25). The list is /list-alert-settings, read on open and again after
 * every change. An email goes on the list with "Send the code" and counts
 * once the six-digit code that was sent to it is typed back. "Take off"
 * does not take an email or a phone off: it sets the day it comes off, a
 * month ahead, and until then it gets every alert; "Keep" undoes it. So
 * neither asks first: nothing is lost by a tap. The phone's part is this
 * browser: where the wallet was opened from the Home Screen and the
 * browser can show notifications, one button asks the phone for its
 * permission and puts this browser on the list (alerts.service, turnOn);
 * anywhere else the page says what is in the way. A refusal shows in red
 * under the part it belongs to, the known reasons as a sentence of their
 * own.
 */
@Component({
  selector: 'app-account-alerts-page',
  imports: [RouterLink, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ t().accountAlerts.title }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p><a mat-button routerLink="/account"><mat-icon>arrow_back</mat-icon> {{ t().nav.account }}</a></p>
        <p>{{ t().accountAlerts.intro1 }}</p>
        @if (listError(); as text) {
          <p class="error">{{ text }}</p>
        }
        @if (alerts.settings(); as s) {
          <p>{{ t().accountAlerts.intro2(t().minutes(s.removeMinutes)) }}</p>

          <h3>{{ t().accountAlerts.emailHeading }}</h3>
          @for (e of s.emails; track e.emailId) {
            <div class="entry">
              @if (e.confirmed) {
                <div class="row">
                  <div class="text">
                    <span class="name">{{ e.email }}</span>
                    @if (e.removesAt; as moment) {
                      <span class="line">{{ t().accountAlerts.comesOff(day(moment)) }}</span>
                    }
                  </div>
                  @if (e.removesAt) {
                    <button mat-stroked-button type="button" (click)="keepEmail(e.emailId)" [disabled]="busy()">{{ t().accountAlerts.keep }}</button>
                  } @else {
                    <button mat-stroked-button type="button" (click)="takeOffEmail(e.emailId)" [disabled]="busy()">{{ t().accountAlerts.takeOff }}</button>
                  }
                </div>
              } @else {
                <div class="text">
                  <span class="name">{{ e.email }}</span>
                  <span class="line">{{ t().accountAlerts.notConfirmed }}</span>
                </div>
                <div class="code">
                  <div class="pair">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="code-box">
                      <mat-label>{{ t().accountAlerts.codeLabel }}</mat-label>
                      <input matInput [ngModel]="codeOf(e.emailId)" (ngModelChange)="setCode(e.emailId, $event)" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
                    </mat-form-field>
                    <button mat-flat-button type="button" (click)="confirm(e.emailId)" [disabled]="busy() || !codeReady(e.emailId)">{{ t().accountAlerts.confirm }}</button>
                  </div>
                  <div class="pair apart">
                    <button mat-button type="button" (click)="sendNewCode(e.email)" [disabled]="busy()">{{ t().accountAlerts.newCode }}</button>
                    <button mat-stroked-button type="button" (click)="takeOffEmail(e.emailId)" [disabled]="busy()">{{ t().accountAlerts.takeOff }}</button>
                  </div>
                </div>
              }
            </div>
          } @empty {
            <p class="muted">{{ t().accountAlerts.emailNone }}</p>
          }
          @if (s.emails.length < s.emailLimit) {
            @if (s.emailOn) {
              <div class="add">
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>{{ t().accountAlerts.emailLabel }}</mat-label>
                  <input matInput type="email" [ngModel]="email()" (ngModelChange)="email.set($event)" />
                </mat-form-field>
                <button mat-flat-button type="button" (click)="sendCode()" [disabled]="busy()">{{ t().accountAlerts.sendCode }}</button>
              </div>
              <p class="muted">{{ t().accountAlerts.emailKept }}</p>
            } @else {
              <p class="muted">{{ t().accountAlerts.emailOff }}</p>
            }
          }
          @if (emailOk(); as text) {
            <p class="ok">{{ text }}</p>
          }
          @if (emailError(); as text) {
            <p class="error">{{ text }}</p>
          }

          <h3>{{ t().accountAlerts.phonesHeading }}</h3>
          @if (thisPhone(); as here) {
            <div class="entry">
              <div class="row">
                <div class="text">
                  <span class="name">{{ t().accountAlerts.thisPhone }}</span>
                  @switch (here.kind) {
                    @case ('off') {
                      <span class="line">{{ t().accountAlerts.phonesOff }}</span>
                    }
                    @case ('listed') {
                      @if (here.phone.removesAt; as moment) {
                        <span class="line">{{ t().accountAlerts.comesOff(day(moment)) }}</span>
                      } @else {
                        <span class="line">{{ t().accountAlerts.phoneOn }}</span>
                      }
                    }
                    @case ('computer') {
                      <span class="line">{{ t().accountAlerts.phoneComputer }}</span>
                    }
                    @case ('tab') {
                      <span class="line">{{ t().accountAlerts.phoneTab }}</span>
                      <span class="line">{{ t().accountAlerts.phoneTabIphone }}</span>
                      <span class="line">{{ t().accountAlerts.phoneTabAndroid }}</span>
                    }
                    @case ('unsupported') {
                      <span class="line">{{ t().accountAlerts.phoneUnsupported }}</span>
                    }
                    @case ('denied') {
                      <span class="line">{{ t().accountAlerts.phoneDenied }}</span>
                    }
                  }
                </div>
                @if (here.kind === 'listed') {
                  @if (here.phone.removesAt) {
                    <button mat-stroked-button type="button" (click)="keepPhone(here.phone.phoneId)" [disabled]="busy()">{{ t().accountAlerts.keep }}</button>
                  } @else {
                    <button mat-stroked-button type="button" (click)="takeOffPhone(here.phone.phoneId)" [disabled]="busy()">{{ t().accountAlerts.takeOff }}</button>
                  }
                }
              </div>
              @if (here.kind === 'ask') {
                <button mat-flat-button type="button" class="turn-on" (click)="turnOn()" [disabled]="busy()">{{ t().accountAlerts.turnOn }}</button>
                <p class="muted ask">{{ t().accountAlerts.phoneAsk }}</p>
              }
            </div>
          }
          @for (p of otherPhones(); track p.phoneId) {
            <div class="entry">
              <div class="row">
                <div class="text">
                  <span class="name">{{ nameOf(p) }}</span>
                  @if (p.removesAt; as moment) {
                    <span class="line">{{ t().accountAlerts.comesOff(day(moment)) }}</span>
                  }
                </div>
                @if (p.removesAt) {
                  <button mat-stroked-button type="button" (click)="keepPhone(p.phoneId)" [disabled]="busy()">{{ t().accountAlerts.keep }}</button>
                } @else {
                  <button mat-stroked-button type="button" (click)="takeOffPhone(p.phoneId)" [disabled]="busy()">{{ t().accountAlerts.takeOff }}</button>
                }
              </div>
            </div>
          }
          @if (phoneOk(); as text) {
            <p class="ok">{{ text }}</p>
          }
          @if (phoneError(); as text) {
            <p class="error">{{ text }}</p>
          }

          <h3>{{ t().accountAlerts.textHeading }}</h3>
          <p class="muted">{{ t().accountAlerts.textSoon }}</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    p { max-width: 640px; }
    .error { color: var(--mat-sys-error); }
    .ok { color: var(--mat-sys-primary); }
    .muted { color: var(--mat-sys-on-surface-variant); }
    h3 { margin: 24px 0 4px; }
    .entry { max-width: 640px; padding: 8px 0; }
    /* A row is its words and, at their right, its one button. The words take the room that is left and wrap, an address inside a word too, so a row grows with its lines and nothing is cut on a phone; the button keeps its place beside them. */
    .row { display: flex; align-items: center; gap: 8px; }
    .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
    .row > button { flex: none; }
    .name { font-size: 16px; line-height: 24px; }
    .line { color: var(--mat-sys-on-surface-variant); font-size: 14px; line-height: 20px; }
    /* Under an address that is not confirmed yet: the Code box with Confirm, then Send a new code with Take off. Each two are one piece, so where the four do not fit on one line they wrap as two and two, and no button stands alone on a line. */
    .code { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
    .pair { display: flex; align-items: center; gap: 8px; }
    /* The second pair takes the room that is left, so Take off stands at the row's right edge. Its starting width is its two buttons side by side, never less: with a starting width of nothing the browser kept the pair on the first line where it did not fit, and Take off ran past the card. */
    .pair.apart { flex: 1 0 auto; justify-content: space-between; }
    .code-box { width: 112px; }
    /* The Email address box with Send the code beside it: the box gives way, so the button stays on its line on a narrow phone too. */
    .add { display: flex; align-items: center; gap: 8px; max-width: 480px; margin-top: 8px; }
    .add mat-form-field { flex: 1; min-width: 0; }
    .add button, .pair button { flex: none; }
    .turn-on { margin-top: 8px; }
    .ask { margin: 8px 0 0; }
  `,
})
export class AccountAlertsPage {
  private readonly api = inject(MasterpodApiService);
  protected readonly alerts = inject(AlertsService);
  protected readonly lang = inject(LanguageService);
  protected readonly t = this.lang.words;

  /** A refused /list-alert-settings, in red where the list would be. */
  protected readonly listError = signal<string | null>(null);
  /** True while a call runs: every button is off. */
  protected readonly busy = signal(false);

  /** The Email address box, as typed. */
  protected readonly email = signal('');
  /** The Code boxes, as typed, by email id. */
  private readonly codes = signal<Record<string, string>>({});
  /** The Email part's good line, in the class ok, and its refusal, in red; one at a time. */
  protected readonly emailOk = signal<string | null>(null);
  protected readonly emailError = signal<string | null>(null);
  /** The Phones part's good line and its refusal. */
  protected readonly phoneOk = signal<string | null>(null);
  protected readonly phoneError = signal<string | null>(null);

  /** This browser as it was last looked at; null until the first look is back. */
  private readonly seen = signal<Seen | null>(null);

  /** What the part "This phone" shows; null until the list and the look at this browser are both there. */
  protected readonly thisPhone = computed((): ThisPhone | null => {
    const settings = this.alerts.settings();
    const seen = this.seen();
    if (settings === null || seen === null) return null;
    if (settings.pushPublicKey === null) return { kind: 'off', phone: null };
    const listed = seen.hash === null ? undefined : settings.phones.find((phone) => phone.endpointHash === seen.hash);
    if (listed) return { kind: 'listed', phone: listed };
    if (seen.device === 'tab') return { kind: seen.label === 'computer' ? 'computer' : 'tab', phone: null };
    if (seen.device === 'unsupported') return { kind: 'unsupported', phone: null };
    if (seen.permission === 'denied') return { kind: 'denied', phone: null };
    return { kind: 'ask', phone: null };
  });

  /** The phones of the list that are not this browser, oldest first, as the list has them. */
  protected readonly otherPhones = computed((): AlertPhoneItem[] => {
    const here = this.thisPhone();
    const phones = this.alerts.settings()?.phones ?? [];
    return here?.kind === 'listed' ? phones.filter((phone) => phone.phoneId !== here.phone.phoneId) : phones;
  });

  constructor() {
    void this.load();
  }

  /** A moment as a day in the language on screen: "Dec 21, 2026". */
  protected day(moment: string): string {
    return new Date(moment).toLocaleDateString(this.lang.tag(), { dateStyle: 'medium' });
  }

  /** Another phone's row in words, "Android phone, added Nov 3, 2026": the kind of device as the list has it, a kind the wallet does not know as "Another device", and the day it was added. */
  protected nameOf(phone: AlertPhoneItem): string {
    const words = this.t().accountAlerts;
    return words.phoneAdded(words.phoneLabels[phone.label] ?? words.phoneLabels['other'], this.day(phone.createdAt));
  }

  protected codeOf(emailId: string): string {
    return this.codes()[emailId] ?? '';
  }

  protected setCode(emailId: string, text: string): void {
    this.codes.update((codes) => ({ ...codes, [emailId]: text }));
  }

  /** True when the row's Code box holds six digits: Confirm is off until then. */
  protected codeReady(emailId: string): boolean {
    return CODE.test(this.codeOf(emailId));
  }

  /** /list-alert-settings, a refusal in red where the list would be, and a look at this browser, for the part "This phone". */
  private async load(): Promise<void> {
    const [res] = await Promise.all([this.alerts.load(), this.look()]);
    this.listError.set(res.ok ? null : `/list-alert-settings: ${reasonOf(res)}`);
  }

  /** A look at this browser: where the wallet runs, the kind of device, the answer about notifications, and the hash the list names it by. */
  private async look(): Promise<void> {
    const hash = await this.alerts.thisEndpointHash();
    this.seen.set({ device: this.alerts.device(), label: this.alerts.label(), permission: this.alerts.permission(), hash });
  }

  // --- Email --------------------------------------------------------------------

  /** "Send the code": the box's words go to /add-alert-email with the language on screen. A good answer empties the box, reads the list again and says where the code went. */
  protected sendCode(): Promise<void> {
    return this.inEmail(async (settings) => {
      const res = await this.api.addAlertEmail(this.email(), this.lang.language());
      if (!res.ok) throw new Error(this.refusal('/add-alert-email', res, settings));
      this.email.set('');
      await this.load();
      return this.t().accountAlerts.codeSent(res.body.email);
    });
  }

  /** "Send a new code": the same call with the row's address. */
  protected sendNewCode(email: string): Promise<void> {
    return this.inEmail(async (settings) => {
      const res = await this.api.addAlertEmail(email, this.lang.language());
      if (!res.ok) throw new Error(this.refusal('/add-alert-email', res, settings));
      await this.load();
      return this.t().accountAlerts.codeSent(res.body.email);
    });
  }

  /** "Confirm": the row's code goes to /confirm-alert-email. A good answer reads the list again and says that the address now gets the alerts. */
  protected confirm(emailId: string): Promise<void> {
    return this.inEmail(async (settings) => {
      const res = await this.api.confirmAlertEmail(emailId, this.codeOf(emailId));
      if (!res.ok) throw new Error(this.refusal('/confirm-alert-email', res, settings));
      this.setCode(emailId, '');
      await this.load();
      return this.t().accountAlerts.confirmed;
    });
  }

  /** "Take off" beside an email: the route, then the list again. It asks nothing first: a confirmed address still gets every alert until its day, and "Keep" undoes it. */
  protected takeOffEmail(emailId: string): Promise<void> {
    return this.inEmail(async (settings) => {
      const res = await this.api.removeAlertEmail(emailId);
      if (!res.ok) throw new Error(this.refusal('/remove-alert-email', res, settings));
      await this.load();
      return null;
    });
  }

  /** "Keep" beside an email that is set to come off: the route, then the list again. */
  protected keepEmail(emailId: string): Promise<void> {
    return this.inEmail(async (settings) => {
      const res = await this.api.keepAlertEmail(emailId);
      if (!res.ok) throw new Error(this.refusal('/keep-alert-email', res, settings));
      await this.load();
      return null;
    });
  }

  // --- Phones -------------------------------------------------------------------

  /**
   * "Turn on alerts for this phone". alerts.turnOn is the first thing this
   * tap runs, with nothing waited for in front of it: its first line asks
   * the phone for the permission, and an iPhone asks only inside a tap.
   * Then /add-alert-phone, the list again and the line that a first
   * notification is on its way. A person who says no gets the sentence
   * about the phone's settings: as the part's own line once the browser
   * remembers the no, in red while it does not (a question that was only
   * closed). Anything else that is thrown shows its own words in red.
   */
  protected turnOn(): Promise<void> {
    return this.inPhones(async (settings) => {
      if (settings.pushPublicKey === null) return null;
      let phone: AlertPhone;
      try {
        phone = await this.alerts.turnOn(settings.pushPublicKey);
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'denied') throw err;
        await this.look();
        if (this.thisPhone()?.kind === 'denied') return null;
        throw new Error(this.t().accountAlerts.phoneDenied);
      }
      const res = await this.api.addAlertPhone(phone);
      if (!res.ok) {
        await this.look();
        throw new Error(this.refusal('/add-alert-phone', res, settings));
      }
      await this.load();
      return this.t().accountAlerts.phoneTurnedOn;
    });
  }

  /** "Take off" beside a phone: the route, then the list again. */
  protected takeOffPhone(phoneId: string): Promise<void> {
    return this.inPhones(async (settings) => {
      const res = await this.api.removeAlertPhone(phoneId);
      if (!res.ok) throw new Error(this.refusal('/remove-alert-phone', res, settings));
      await this.load();
      return null;
    });
  }

  /** "Keep" beside a phone that is set to come off: the route, then the list again. */
  protected keepPhone(phoneId: string): Promise<void> {
    return this.inPhones(async (settings) => {
      const res = await this.api.keepAlertPhone(phoneId);
      if (!res.ok) throw new Error(this.refusal('/keep-alert-phone', res, settings));
      await this.load();
      return null;
    });
  }

  // --- plumbing -----------------------------------------------------------------

  /** A refusal in words: the sentence of its reason where the reason is a known one, else the path and the reason, as the other pages show one. */
  private refusal(path: string, res: ApiResponse<unknown>, settings: AlertSettings): string {
    const words = this.t().accountAlerts;
    switch ((res.body as Partial<ApiError> | null)?.error) {
      case 'invalid email':
        return words.invalidEmail;
      case 'email already listed':
        return words.emailListed;
      case 'email limit reached':
        return words.emailLimit(settings.emailLimit);
      case 'too many codes today':
        return words.tooManyCodes;
      case 'wait before a new code':
        return words.waitForCode;
      case 'wrong code':
      case 'invalid code':
        return words.wrongCode;
      case 'code expired':
      case 'code used up':
        return words.codeDead;
      case 'too many changes today':
        return words.tooManyChanges;
      case 'email alerts not set up':
        return words.emailOff;
      case 'phone alerts not set up':
        return words.phonesOff;
      case 'push service not supported':
        return words.phoneService;
      case 'phone limit reached':
        return words.phoneLimit(settings.phoneLimit);
      default:
        return `${path}: ${reasonOf(res)}`;
    }
  }

  /** One action of the Email part: busy while it runs, the part's two lines cleared first, the line it answers in the class ok, what it throws in red. */
  private inEmail(action: (settings: AlertSettings) => Promise<string | null>): Promise<void> {
    return this.run(this.emailOk, this.emailError, action);
  }

  /** One action of the Phones part, the same way. */
  private inPhones(action: (settings: AlertSettings) => Promise<string | null>): Promise<void> {
    return this.run(this.phoneOk, this.phoneError, action);
  }

  private async run(ok: WritableSignal<string | null>, error: WritableSignal<string | null>, action: (settings: AlertSettings) => Promise<string | null>): Promise<void> {
    const settings = this.alerts.settings();
    if (settings === null || this.busy()) return;
    this.busy.set(true);
    ok.set(null);
    error.set(null);
    try {
      ok.set(await action(settings));
    } catch (err) {
      error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
