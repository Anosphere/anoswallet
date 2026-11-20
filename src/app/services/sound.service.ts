import { Injectable, signal } from '@angular/core';

/** The localStorage key of the sound's switch on this device: 'off' once the person turned the sound off; anything else, or nothing, is on. */
const SOUND_KEY = 'anopod-wallet.sound';

/**
 * The wallet's one sound (wallet spec 8.1 and 8.3; 2026-11-19,
 * forclaude/wallet-chat-and-passkey-plan-1.md): two short notes that tell
 * a person that a chat message or a chat request arrived while the wallet
 * is open. The shell rings it from its 5-second read of the room list
 * (app.ts, ring), and the switch on the Your account page turns it off
 * and on.
 *
 * The notes are made by the browser's own sound engine, so the wallet
 * carries no sound file. A browser lets a page make sound only after the
 * person has touched the page, with a tap or a key press: the engine is
 * made at the first one, and until then nothing plays. A person with an
 * open session has tapped Log in in this tab, so the engine is there.
 *
 * The sound plays only while the wallet's page is running. A phone with
 * another app in front, or a locked phone, freezes the page and plays
 * nothing. A phone's browser also stops the engine when it leaves the
 * screen: the service starts it again when the page is back, and at the
 * next tap when the browser refuses that. A sound while the wallet is not
 * open would need push notifications, which are not built.
 *
 * The switch is kept in localStorage under anopod-wallet.sound, for this
 * device and not per pod: the sound is on until the person turns it off.
 * It is a choice and nothing secret.
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
  /** True while the sound is on, on this device. */
  readonly on = signal(readSwitch());

  /** The browser's sound engine: made at the person's first tap or key press, since a browser lets a page make sound only after the person has touched it. */
  private context: AudioContext | null = null;

  constructor() {
    const wake = () => this.wake(true);
    // The three events every browser counts as the person's own touch: a click, the end of a touch and a key press. The start of a touch is not one of them on a phone.
    document.addEventListener('click', wake, { capture: true, passive: true });
    document.addEventListener('touchend', wake, { capture: true, passive: true });
    document.addEventListener('keydown', wake, { capture: true, passive: true });
    // A phone stops a page's sound engine when the browser leaves the screen: it is started again when the page is back, and at the next tap if the browser refuses that.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.wake(false);
    });
  }

  /** The switch of the Your account page: kept on this device. Turning it on plays the sound once, so the person hears what it is. */
  setOn(value: boolean): void {
    this.on.set(value);
    writeSwitch(value);
    if (value) this.chime();
  }

  /** The wallet's one sound: two short notes, the second higher. Nothing plays while the switch is off, before the person's first tap, or while the engine is stopped. */
  chime(): void {
    const context = this.context;
    if (!this.on() || !context || context.state !== 'running') return;
    const at = context.currentTime;
    note(context, 880, at, 0.12);
    note(context, 1174.66, at + 0.14, 0.22);
  }

  /** Starts the sound engine, and with `make` makes it first when there is none. A browser without one, or one that refuses, leaves the wallet silent. */
  private wake(make: boolean): void {
    try {
      if (!this.context && make) this.context = new AudioContext();
      if (this.context && this.context.state !== 'running') void this.context.resume().catch(() => undefined);
    } catch {
      // No sound engine in this browser.
    }
  }
}

/** One soft note: a sine wave that comes in at once and fades out. */
function note(context: AudioContext, frequency: number, at: number, seconds: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.2, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + seconds + 0.02);
}

function readSwitch(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeSwitch(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SOUND_KEY);
    else localStorage.setItem(SOUND_KEY, 'off');
  } catch {
    // Private mode or blocked storage: the tab keeps its own answer.
  }
}
