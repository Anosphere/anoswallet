import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiResponse } from './log.service';
import { AlertSettings, MasterpodApiService } from './masterpod-api.service';
import { SessionService } from './session.service';

/** Where the wallet runs, for the phone's alerts: `tab` in a browser tab, `ready` opened from the Home Screen in a browser that can show notifications, `unsupported` opened from the Home Screen in one that cannot. */
export type AlertDevice = 'tab' | 'unsupported' | 'ready';

/** What a browser hands over when a person allows notifications, as /add-alert-phone takes it: the delivery address, the browser's public key and its secret (both base64url, as the browser gives them), and the kind of device. */
export interface AlertPhone {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
}

/** The bytes of a base64url text, as the masterpod writes its public key for the phones. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True when a subscription's server key, as the browser kept it, holds exactly `bytes`. */
function sameBytes(kept: ArrayBuffer | null, bytes: Uint8Array): boolean {
  if (kept === null) return false;
  const other = new Uint8Array(kept);
  return other.length === bytes.length && other.every((byte, i) => byte === bytes[i]);
}

/**
 * The security alerts of the pod (wallet spec 8.3; 2026-11-21, section
 * 11; the masterpod's side is its spec's section 25): the list of emails
 * and phones that are told when a transfer starts to wait, when a recovery
 * is started and when the list itself changes, and the phone's own part,
 * which is this browser on this device. The Security alerts page
 * (/account/alerts) reads and changes the list through it, and the account
 * page asks it whether anything is set up at all.
 *
 * The phone's part: device() says where the wallet runs, label() what kind
 * of device this is, permission() what the person answered when the phone
 * asked, thisEndpointHash() which entry of the list is this browser, and
 * turnOn() asks for the permission, switches on public/alerts-worker.js,
 * the file that shows a notification, and takes this browser's delivery
 * address from the browser. That worker is switched on only there, when a
 * person turns the phone's alerts on. Nothing in the wallet ever calls
 * unsubscribe() for a phone that is taken off: the masterpod stops sending
 * when the month is over, and until then the phone gets every alert. The
 * one unsubscribe() in turnOn() is for a subscription that was made with
 * another server key, which no message of ours can reach.
 */
@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(MasterpodApiService);
  private readonly session = inject(SessionService);

  /** The pod's list as /list-alert-settings last answered it; null until read. */
  readonly settings = signal<AlertSettings | null>(null);

  /** True when the list is read and holds no confirmed email and no phone: nobody is told yet. */
  readonly nothingSet = computed(() => {
    const settings = this.settings();
    return settings !== null && !settings.emails.some((email) => email.confirmed) && settings.phones.length === 0;
  });

  constructor() {
    // The list is the pod's: back to null when the session's pod changes, so one anoPod never sees another's list in the same tab. Only a change does it: the effect's first run, when this service is made, finds the pod it was made under and leaves the list alone, so a list that was read meanwhile stays.
    let pod = this.session.anopodId();
    effect(() => {
      const now = this.session.anopodId();
      if (now === pod) return;
      pod = now;
      untracked(() => this.settings.set(null));
    });
  }

  /** /list-alert-settings: a good answer goes into the signal, and the answer is returned. */
  async load(quiet = false): Promise<ApiResponse<AlertSettings>> {
    const res = await this.api.listAlertSettings(quiet);
    if (res.ok) this.settings.set(res.body);
    return res;
  }

  /** Reads the list, quietly, when it was not read yet. */
  async ensureLoaded(): Promise<void> {
    if (this.settings() === null) await this.load(true);
  }

  /** Where the wallet runs. `tab` when it was not opened from the Home Screen: neither the display mode nor an iPhone's own flag says so. Otherwise `unsupported` when the browser lacks one of the three things a notification needs, else `ready`. */
  device(): AlertDevice {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return 'tab';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    return 'ready';
  }

  /** The kind of device, from the browser's user agent, in this order: an Android phone's user agent holds "Linux" too, and an iPad may call itself a Macintosh. */
  label(): string {
    const agent = navigator.userAgent;
    if (agent.includes('iPhone')) return 'iphone';
    if (agent.includes('iPad') || (agent.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'ipad';
    if (agent.includes('Android')) return 'android';
    if (['Windows', 'Macintosh', 'Linux', 'CrOS'].some((word) => agent.includes(word))) return 'computer';
    return 'other';
  }

  /** What the person answered when the phone asked about notifications: `default` (not asked yet), `granted` or `denied`; `denied` where the browser has no notifications at all. */
  permission(): NotificationPermission {
    return 'Notification' in window ? Notification.permission : 'denied';
  }

  /** The SHA-256 of this browser's delivery address, 64 hex characters: what the list names a phone by (endpointHash). Null when the worker is not switched on here, when this browser has no delivery address, or when anything throws. */
  async thisEndpointHash(): Promise<string | null> {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) return null;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  /**
   * Turns the alerts on in this browser and answers what /add-alert-phone
   * takes. Call it straight from the button's tap: its first line asks for
   * the permission, and an iPhone asks only inside a tap. In this order:
   * the permission (anything but granted throws Error('denied')); the
   * worker, switched on for the whole site; the masterpod's public key,
   * `pushPublicKey`, 65 bytes from base64url; this browser's subscription,
   * a new one when there is none or when the one it has was made with
   * another server key.
   */
  async turnOn(pushPublicKey: string): Promise<AlertPhone> {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('denied');
    const registration = await navigator.serviceWorker.register('/alerts-worker.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const key = fromBase64Url(pushPublicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription !== null && !sameBytes(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = subscription.toJSON();
    return { endpoint: json.endpoint!, p256dh: json.keys!['p256dh'], auth: json.keys!['auth'], label: this.label() };
  }
}
