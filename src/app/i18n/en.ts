/**
 * The English words of the wallet (wallet spec 8.8): one section per page or
 * component, `common` for the sentences several pages share, `dates` for the
 * day words. A sentence with a number or a name in it is a function, so each
 * language keeps its own grammar. `Words` is this object's shape and th.ts
 * must match it, so a sentence missing in Thai fails the build.
 */
export const en = {
  shell: {
    menu: 'Menu',
    brandWallet: 'anoPod wallet',
    brandModerator: 'Moderator wallet',
    brandAttestor: 'Attestor wallet',
    lock: 'Lock',
  },
  nav: {
    vouching: 'Vouching',
    identity: 'Identity',
    setup: 'Setup',
    home: 'Home',
    wallet: 'Wallet',
    cases: 'Cases',
    chat: 'Chat',
    marketplace: 'Marketplace',
    account: 'Account',
    moderation: 'Moderation',
    attesting: 'Attesting',
    notifications: 'Notifications',
    vouchRequests: 'Vouch requests',
    log: 'Log',
  },
  landing: {
    noticeHeadline: 'This is just a test site.',
    title: 'Your anoPod',
    subtitle: 'Unlock with your passkey, or create a new anoPod',
    unlocking: 'Unlocking…',
    noPasskey: 'No passkey for this site on this device? Create an anoPod instead.',
    unlock: 'Unlock',
    create: 'Create account',
    recover: 'Recover account',
  },
  material: {
    optional: 'Optional',
  },
  dates: {
    today: 'Today',
    yesterday: 'Yesterday',
  },
  common: {},
};

/** The shape of a language's words: en.ts is the source, th.ts must match it. */
export type Words = typeof en;
