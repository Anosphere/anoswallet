import { Injectable, signal } from '@angular/core';
import { REFRESH_WAIT_MS, UPDATE_CHECK_MS } from '../constants';

/** The build's one script file as a page of the wallet names it: `main-`, then letters and digits made from the file's content, then `.js`. Another build has another name. */
const SCRIPT_NAME = /main-[A-Z0-9]+\.js/;

/**
 * The update check and the refresh (wallet spec 8.1; 2026-11-22).
 *
 * A page of the wallet keeps the code it was loaded with for as long as it
 * lives. In a browser tab a person reloads it. A wallet opened from a
 * phone's Home Screen has no address bar and no reload button, and the
 * phone keeps its page for days, so it kept an old build until the app was
 * swiped away. Lock and Log in loaded no page either.
 *
 * The check: the wallet asks its own server for the page again, past the
 * browser's own copy, and reads the name of the script file in the answer.
 * When that name is not the one this page runs, a newer build is there and
 * `available` turns true: the shell shows the Update button. It asks when
 * the wallet starts, every UPDATE_CHECK_MS while the page is on the
 * screen, and each time the page comes back to the front (a phone freezes
 * a page's timers while another app is in front). Once a newer build was
 * seen it asks no more. A development build has one script with no
 * content name (`main.js`): the check is off there.
 *
 * The refresh: `refresh()` shows "Refreshing…" over the whole page, asks
 * the server for the page, and loads the page again once the server has
 * answered. When the server does not answer in REFRESH_WAIT_MS, the words
 * go away and the wallet stays as it is: a page from the Home Screen has
 * no reload button to get off a browser's error page. The Update button,
 * Lock and the box "You are logged out" all end in it, and the shell sees
 * to it that the page stands on the first page, with no session, before
 * it is loaded again (app.ts). The keys of a session live in the page's
 * memory, so the page that comes back has none.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  /** The script file this page runs, read from the page's own script tag; null in a development build. */
  private readonly own = document.querySelector('script[src^="main-"]')?.getAttribute('src')?.match(SCRIPT_NAME)?.[0] ?? null;
  private checking = false;

  /** True once the server's page named another script file than this page runs. It stays true until the page is loaded again. */
  readonly available = signal(false);
  /** True from the start of a refresh until the page is gone, or until the server did not answer: the shell draws "Refreshing…" over everything. */
  readonly refreshing = signal(false);

  constructor() {
    if (this.own === null) return;
    void this.check();
    setInterval(() => void this.check(), UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => void this.check());
  }

  /** One look at the server's page. Nothing is asked while the page is hidden, while a look runs, or once a newer build was seen. An answer that names no script file (the wallet is closed for a while, or no answer) changes nothing. */
  private async check(): Promise<void> {
    if (this.available() || this.checking || document.visibilityState !== 'visible') return;
    this.checking = true;
    try {
      const name = (await this.page())?.match(SCRIPT_NAME)?.[0];
      if (name !== undefined && name !== this.own) this.available.set(true);
    } finally {
      this.checking = false;
    }
  }

  /** Loads the page again from the server, once the server has answered; until then, and while the page loads, "Refreshing…" shows. `before`, when given, runs after the server's answer and right before the load. With no answer nothing runs and the wallet stays as it is. */
  async refresh(before?: () => Promise<unknown>): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    if ((await this.page()) === null) {
      this.refreshing.set(false);
      return;
    }
    await before?.();
    location.reload();
  }

  /** The wallet's page as its server sends it now, never the browser's own copy; null when the server does not answer in REFRESH_WAIT_MS or answers with anything but the page. */
  private async page(): Promise<string | null> {
    try {
      const res = await fetch('/', { cache: 'no-store', signal: AbortSignal.timeout(REFRESH_WAIT_MS) });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }
}
