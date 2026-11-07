# wallet

The anoPod wallet: one Angular 22 app (Angular Material, standalone
components, signals) with a small Express proxy, doing everything the three
test apps did in one flow: create an anoPod, get vouched, give the identity
record, set up, fill the security buckets, make anos accounts, send anos,
chat, trade. The spec is `docs/schemas.md`; the public ledger id is
`docs/public-ledger-id.md`; `docs/build-plan.md` is how it was built.

## Running it on this machine

Everything else first: the masterpod on 3100, the five validators on 3001
to 3005, the five keyholders on 3201 to 3205, the signing server on 3300
(`~/Desktop/Z/signingserver`, `npm start`). Then

```bash
npm install
npm run server      # the proxy on 4300 (server/), no env file needed locally
npm start           # ng serve on 4200; proxy.conf.json sends /api to 4300
```

Open <http://localhost:4200>. The passkey ceremonies happen on that origin,
which is the masterpod's `WEB_ORIGIN` and `RP_ID` (localhost).

For a production-like check, `npm run build` then `npm run server` serves
the build from 4300 as well.

## The proxy (server/)

The one origin the browser talks to. `GET /api/config` tells the browser
how many validators and keyholders there are and the three lock numbers;
`/api/masterpod/<path>`, `/api/anos/<n>/<path>`,
`/api/keyholder/<n>/<path>`, `POST /api/sign` and
`GET /api/sign/public-keys` are forwarded with the prefix cut, bodies
streamed, the browser's Origin kept, the backend's answer returned
unchanged; a backend that does not answer is `502 { error: "<who>
unavailable" }`. Everything else is the Angular build (`dist/wallet/browser`),
with `index.html` for the router's deep links. Variables, each with a
local default (`server/config.js`): `PORT` 4300, `MASTERPOD_URL`,
`VALIDATOR_URLS`, `KEYHOLDER_URLS`, `SIGNING_SERVER_URL`, `SHARE_THRESHOLD`
3, `DEFAULT_VALIDATOR` 1, `DIST_DIR`, `RP_ID` localhost,
`GUARDED_LOCK_MINUTES` 1, `VAULT_LOCK_MINUTES` 2, `LOCK_OFFSET_MINUTES` 1
(the validators' lock numbers, answered in `/api/config`).

## Layout

```
server/
  index.js                 boots the proxy on PORT
  app.js                   createApp(config): /api/config, the forwarders, the build
  config.js                the variables with their local defaults
src/app/
  app.ts, app.html         the shell: toolbar, side navigation by status, the notification poll
  app.routes.ts            the routes of spec 8.1; session.guard.ts sends anyone without a session to /
  constants.ts             the PRF salt label, the polling intervals
  amounts.ts               anos <-> millionths
  countries.ts             the ISO 3166-1 alpha-2 codes for the identity form
  i18n/en.ts, th.ts        the words of each language, one section per page (spec 8.8)
  unlock.ts                the unlock flow, shared by the landing page and setup
  components/camera.component.ts   the camera: live preview, Take photo, a file input as the fallback
  components/note-form.component.ts   the note form under a history row: the kind, the money and the currency, the memo (spec 8.2)
  pages/                   one file per route: landing, create, recover, vouching, identity, setup,
                           bucket-one, bucket-two, wallet, noted-transactions, account, chat, marketplace, notifications, seed, log
  services/
    config.service.ts      GET /api/config once
    language.service.ts    the language on screen: Thai when the browser's first language is Thai,
                           else English; the words, the locale tag, the dates
    session.service.ts     the pod, its keys and ids in RAM, the status, the next-step rule, sign()
    masterpod-api.service.ts, keyholder-api.service.ts, anos-api.service.ts, signing.service.ts
                           one method per route of each backend, through the proxy
    crypto.service.ts      every derivation, blob, builder and signature; public-ledger-id.ts beside it
    passkey.service.ts     the two WebAuthn ceremonies with the PRF extension
    shares.service.ts      the deposit rule of spec section 6: deposit(secret, shareType)
    log.service.ts         the activity log, and the HTTP plumbing every call goes through
    notes.service.ts      the noted transactions: the last list read, the blobs opened on the phone, add, update, remove (spec 8.2)
docs/                      schemas.md (the spec, build notes in section 11), public-ledger-id.md, build-plan.md
proxy.conf.json            ng serve forwards /api to the proxy
```

The app speaks English and Thai (spec 8.8). The language follows the
browser's first language, English unless it is Thai, and the landing
card offers Switch to English for the tab while the app is in Thai;
nothing is stored.

Everything secret lives in RAM and dies with the tab; nothing touches
browser storage. A new tab unlocks again.

## The wallet servers

On the testnet the wallet runs on two Hetzner servers, wallet1 and
wallet2, behind the balancer wallet-lb1, which passes TCP with the PROXY
protocol. The plan is `forclaude/wallet-deploy-plan-1.md` beside the
repos; the operator runs it paste by paste, and nothing runs against the
servers from a chat. On each server:

- The code is the clone of this repository at `/opt/wallet/web_app`,
  owned by the system user `wallet`, home `/opt/wallet`. The Angular build
  is made there with `npx ng build`; `dist/` stays out of git.
- Three units from `deploy/`: `wallet.service` (EDITION wallet, port
  4300), `wallet-attestor.service` (attestor, 4301) and
  `wallet-moderator.service` (moderator, 4302). Each runs
  `node --env-file=network/wallet.env server/index.js` as `wallet`.
- The environment is the committed `network/wallet.env`: the masterpod,
  the validators and the keyholders in registry order, the signing
  server, the threshold, the default validator, RP_ID and the three lock
  numbers, equal to the validators'. Nothing in it is secret and both
  servers hold it byte for byte; EDITION and PORT come from the unit. No
  `.env` exists on the servers.
- nginx ends TLS for https://wallet.anocloud.com,
  https://attestor.wallet.anocloud.com and
  https://moderator.wallet.anocloud.com with the site
  `deploy/nginx/wallet.conf`, each name to its edition's port on
  loopback. The certificate is the operator's, at
  `/etc/wallet/tls/fullchain.pem` and `/etc/wallet/tls/key.pem`, with a
  renewal hook that ends in `systemctl reload nginx`.
- `scripts/install-system-files.sh`, run as root from the repo root, puts
  the deploy files in place (the TLS folder, the nginx site, the three
  units) and restarts the three units. It runs twice at setup: before the
  certificate exists it skips the site, after it installs the site; and
  again after any pull that touched `deploy/`.

Updating, wallet1 first, then wallet2 minutes later (the plan, section
10): the pull as `wallet`, `npm ci` when the pull names
`package-lock.json`, the build after every pull, then the install script,
which restarts the three units.

    sudo -iu wallet git -C /opt/wallet/web_app pull --ff-only
    sudo -iu wallet bash -c 'cd /opt/wallet/web_app && npm ci'
    sudo -iu wallet bash -c 'cd /opt/wallet/web_app && npx ng build'
    sh /opt/wallet/web_app/scripts/install-system-files.sh

A change to `network/wallet.env` alone, a new validator or another
threshold, is the pull and then
`systemctl restart wallet wallet-attestor wallet-moderator`.
