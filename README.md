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
how many validators and keyholders there are; `/api/masterpod/<path>`,
`/api/anos/<n>/<path>`, `/api/keyholder/<n>/<path>`, `POST /api/sign` and
`GET /api/sign/public-keys` are forwarded with the prefix cut, bodies
streamed, the browser's Origin kept, the backend's answer returned
unchanged; a backend that does not answer is `502 { error: "<who>
unavailable" }`. Everything else is the Angular build (`dist/wallet/browser`),
with `index.html` for the router's deep links. Variables, each with a
local default (`server/config.js`): `PORT` 4300, `MASTERPOD_URL`,
`VALIDATOR_URLS`, `KEYHOLDER_URLS`, `SIGNING_SERVER_URL`, `SHARE_THRESHOLD`
3, `DEFAULT_VALIDATOR` 1, `DIST_DIR`.

## Layout

```
server/
  index.js                 boots the proxy on PORT
  app.js                   createApp(config): /api/config, the forwarders, the build
  config.js                the variables with their local defaults
src/app/
  app.ts, app.html         the shell: toolbar, side navigation by status, the notification poll
  app.routes.ts            the routes of spec 8.1; session.guard.ts sends anyone without a session to /
  constants.ts             the lock minutes, the PRF salt label, the polling intervals
  amounts.ts               anos <-> millionths
  countries.ts             the ISO 3166-1 alpha-2 codes for the identity form
  unlock.ts                the unlock flow, shared by the landing page and setup
  components/camera.component.ts   the camera: live preview, Take photo, a file input as the fallback
  pages/                   one file per route: landing, create, recover, vouching, identity, setup,
                           bucket-one, bucket-two, wallet, account, chat, marketplace, notifications, seed, log
  services/
    config.service.ts      GET /api/config once
    session.service.ts     the pod, its keys and ids in RAM, the status, the next-step rule, sign()
    masterpod-api.service.ts, keyholder-api.service.ts, anos-api.service.ts, signing.service.ts
                           one method per route of each backend, through the proxy
    crypto.service.ts      every derivation, blob, builder and signature; public-ledger-id.ts beside it
    passkey.service.ts     the two WebAuthn ceremonies with the PRF extension
    shares.service.ts      the deposit rule of spec section 6: deposit(secret, shareType)
    log.service.ts         the activity log, and the HTTP plumbing every call goes through
docs/                      schemas.md (the spec, build notes in section 11), public-ledger-id.md, build-plan.md
proxy.conf.json            ng serve forwards /api to the proxy
```

Everything secret lives in RAM and dies with the tab; nothing touches
browser storage. A new tab unlocks again.
