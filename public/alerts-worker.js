/*
 * The wallet's notification worker (wallet spec 8.3, Security alerts). The
 * browser starts this file when the masterpod sends this phone a security
 * alert, also while the wallet is closed. It does two things: it shows the
 * alert as a notification, and it opens the wallet when the notification is
 * tapped. It keeps no copy of the wallet and answers no request of a page:
 * there is no fetch handler here, so every page load still comes from the
 * wallet's servers.
 *
 * The masterpod sends facts, not sentences: { kind, ... }. The sentence is
 * made here, in the phone's own language: Thai when the browser's language
 * is Thai, English otherwise. A message this file cannot read still shows
 * a notification, because a browser takes the permission away from a site
 * whose message shows nothing.
 */

const WORDS = {
  en: {
    tag: 'en-US',
    title: 'Security alert',
    kinds: { spending: 'spending', guarded: 'guarded', vault: 'vault', assisted: 'assisted' },
    labels: { iphone: 'an iPhone', ipad: 'an iPad', android: 'an Android phone', computer: 'a computer', other: 'a device' },
    transferWaiting: (anos, kind) => `${anos} anos are waiting to leave your ${kind} account. Not you? Open the wallet and cancel the transfer.`,
    recoveryMoveWaiting: (anos, kind) => `A recovery is moving ${anos} anos out of your ${kind} account. Not you? Open the wallet's first page and tap "Recover account".`,
    recoveryCaseOpened: 'A recovery was started for your anoPod. Not you? If your passkey ever stops working, open the wallet\'s first page and tap "Recover account".',
    emailAdded: (email) => `An email was added to your security alerts: ${email}. Not you? Open the wallet and look at Security alerts.`,
    emailRemoving: (email, day) => `An email will come off your security alerts on ${day}: ${email}. Not you? Open the wallet and tap Keep.`,
    emailKept: (email) => `An email stays on your security alerts: ${email}.`,
    phoneAdded: (label) => `A phone was added to your security alerts: ${label}. Not you? Open the wallet and look at Security alerts.`,
    phoneRemoving: (label, day) => `A phone will come off your security alerts on ${day}: ${label}. Not you? Open the wallet and tap Keep.`,
    phoneKept: (label) => `A phone stays on your security alerts: ${label}.`,
    phoneUnreachable: (label) => `A phone no longer gets your security alerts: ${label}.`,
    phoneOn: 'Security alerts are on for this phone.',
    other: 'Open the wallet to see your security alerts.',
    anEmail: 'an email',
  },
  // The Thai words: the same keys, in the words of the wallet's th.ts. A kind of account is the word that follows "บัญชี" there; "กู้คืนบัญชี", "เก็บไว้" and "การแจ้งเตือนความปลอดภัย" are its Recover account, Keep and Security alerts.
  th: {
    tag: 'th-TH-u-ca-gregory',
    title: 'การแจ้งเตือนความปลอดภัย',
    kinds: { spending: 'ใช้จ่าย', guarded: 'หน่วงเวลา', vault: 'นิรภัย', assisted: 'มีผู้ยืนยัน' },
    labels: { iphone: 'iPhone', ipad: 'iPad', android: 'โทรศัพท์ Android', computer: 'คอมพิวเตอร์', other: 'อุปกรณ์เครื่องหนึ่ง' },
    transferWaiting: (anos, kind) => `${anos} anos กำลังรอออกจากบัญชี${kind}ของคุณ หากไม่ใช่คุณ ให้เปิดกระเป๋าเงินแล้วยกเลิกการโอน`,
    recoveryMoveWaiting: (anos, kind) => `การกู้คืนกำลังย้าย ${anos} anos ออกจากบัญชี${kind}ของคุณ หากไม่ใช่คุณ ให้เปิดหน้าแรกของกระเป๋าเงินแล้วแตะ "กู้คืนบัญชี"`,
    recoveryCaseOpened: 'มีการเริ่มการกู้คืน anoPod ของคุณ หากไม่ใช่คุณ และวันหนึ่งพาสคีย์ของคุณใช้ไม่ได้ ให้เปิดหน้าแรกของกระเป๋าเงินแล้วแตะ "กู้คืนบัญชี"',
    emailAdded: (email) => `มีการเพิ่มอีเมลในการแจ้งเตือนความปลอดภัยของคุณ: ${email} หากไม่ใช่คุณ ให้เปิดกระเป๋าเงินแล้วดูที่ "การแจ้งเตือนความปลอดภัย"`,
    emailRemoving: (email, day) => `อีเมลหนึ่งรายการจะออกจากการแจ้งเตือนความปลอดภัยของคุณในวันที่ ${day}: ${email} หากไม่ใช่คุณ ให้เปิดกระเป๋าเงินแล้วแตะ "เก็บไว้"`,
    emailKept: (email) => `อีเมลหนึ่งรายการยังอยู่ในการแจ้งเตือนความปลอดภัยของคุณ: ${email}`,
    phoneAdded: (label) => `มีการเพิ่มโทรศัพท์ในการแจ้งเตือนความปลอดภัยของคุณ: ${label} หากไม่ใช่คุณ ให้เปิดกระเป๋าเงินแล้วดูที่ "การแจ้งเตือนความปลอดภัย"`,
    phoneRemoving: (label, day) => `โทรศัพท์เครื่องหนึ่งจะออกจากการแจ้งเตือนความปลอดภัยของคุณในวันที่ ${day}: ${label} หากไม่ใช่คุณ ให้เปิดกระเป๋าเงินแล้วแตะ "เก็บไว้"`,
    phoneKept: (label) => `โทรศัพท์เครื่องหนึ่งยังอยู่ในการแจ้งเตือนความปลอดภัยของคุณ: ${label}`,
    phoneUnreachable: (label) => `โทรศัพท์เครื่องหนึ่งไม่ได้รับการแจ้งเตือนความปลอดภัยของคุณอีกต่อไป: ${label}`,
    phoneOn: 'การแจ้งเตือนความปลอดภัยเปิดอยู่สำหรับโทรศัพท์เครื่องนี้',
    other: 'เปิดกระเป๋าเงินเพื่อดูการแจ้งเตือนความปลอดภัยของคุณ',
    anEmail: 'อีเมลหนึ่งรายการ',
  },
};

/** Millionths of an anos, a decimal string, as anos with commas: "5000000000" is "5,000", "1500000" is "1.5". */
function anosOf(millionths) {
  if (typeof millionths !== 'string' || !/^[0-9]+$/.test(millionths)) return '?';
  const value = BigInt(millionths);
  const whole = (value / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A moment as a day in the phone's own time and language: "Dec 21, 2026". */
function dayOf(moment, tag) {
  const date = new Date(moment);
  return Number.isNaN(date.getTime()) ? '?' : date.toLocaleDateString(tag, { dateStyle: 'medium' });
}

/** The notification's sentence for one message of the masterpod. */
function sentenceOf(data, words) {
  if (data === null || typeof data !== 'object') return words.other;
  const kind = words.kinds[data.accountType] || data.accountType || '';
  const label = words.labels[data.label] || words.labels.other;
  const email = typeof data.email === 'string' ? data.email : words.anEmail;
  switch (data.kind) {
    case 'transferWaiting': return words.transferWaiting(anosOf(data.amount), kind);
    case 'recoveryMoveWaiting': return words.recoveryMoveWaiting(anosOf(data.amount), kind);
    case 'recoveryCaseOpened': return words.recoveryCaseOpened;
    case 'emailAdded': return words.emailAdded(email);
    case 'emailRemoving': return words.emailRemoving(email, dayOf(data.removesAt, words.tag));
    case 'emailKept': return words.emailKept(email);
    case 'phoneAdded': return words.phoneAdded(label);
    case 'phoneRemoving': return words.phoneRemoving(label, dayOf(data.removesAt, words.tag));
    case 'phoneKept': return words.phoneKept(label);
    case 'phoneUnreachable': return words.phoneUnreachable(label);
    case 'phoneOn': return words.phoneOn;
    default: return words.other;
  }
}

// A new version of this file takes over at once: it holds nothing an open page depends on.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const words = /^th(-|$)/i.test(self.navigator.language || '') ? WORDS.th : WORDS.en;
  event.waitUntil(self.registration.showNotification(words.title, { body: sentenceOf(data, words), icon: '/icon-192.png' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
