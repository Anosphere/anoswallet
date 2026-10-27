# Build plan

The order the pieces of docs/schemas.md get built, what each step
touches, and how each is checked. The user runs every server and ng
serve, and commits; each step ends with the files it changed. Node 24
through nvm.

## Step 1. The signing server

New project ~/Desktop/Z/signingserver: package.json (express, canonicalize;
start, dev), .gitignore (node_modules, keys.json), README.md, src/server.js,
src/app.js, src/keys.js, src/sign.js, src/crypto/canonical.js,
src/crypto/signatures.js (anossoftware's, with the ML-DSA-87 sign added),
test/rig.mjs.

Check: boot on 3300; /public-keys answers a 33-byte and a 2592-byte key;
/sign on a creation built the way the test wallet builds one returns both
wallet signatures and node:crypto verifies each against the public keys;
a body without payload answers 400.

## Step 2. The validators (anossoftware)

- db/schema.sql: the nonces table. `npm run db:setup` on the user's
  databases.
- src/config/env.js: MASTERPOD_URL and TIMESTAMP_WINDOW_SECONDS, optional.
- src/auth/: signed-request.js, common-checks.js, nonces.queries.js,
  require-account.js.
- src/masterpod/masterpod.client.js: the binding lookup.
- src/accounts/accounts.service.js: check 5; accounts.handlers.js: the
  silent 400.
- src/reads/: reads.router.js, reads.handlers.js, reads.service.js,
  reads.queries.js; src/app.js wiring.
- README and docs/schemas.md there: the new level, the two routes, the
  check, the variables.

Check, test/rig.mjs: /get-account and /list-transactions signed by the OG
account (its keys are in src/genesis/og-account.json) answer its balance,
its newest id and its links; a wrong signature, a replayed nonce and an
old timestamp are refused with their reasons; /create-account for an
account the masterpod does not know answers 400 { error: "bad request" }
with nothing in the log. The positive path of the check is step 8's.

## Step 3. The masterpod (masterpodsoftware)

- db/schema.sql: identity_blob and the eight-way CHECK; key_id on
  security_images and security_info; anos_accounts.
- src/anopods/: the eighth setup field, identityBlob in the unlock
  answer, the three counts in status (queries for the counts).
- src/security/: keyId on both adds and in the list.
- src/anos-accounts/: router, handlers, service, queries; src/app.js.
- README, docs/schemas.md section 11.
- `npm run db:reset`, then the user creates the first pod and runs
  make-super-seed as before.

Check, the rig under test/ (extended if one is there): complete-setup
with eight fields and 400 invalid identityBlob without the eighth; unlock
answers identityBlob; a bucket add without keyId is refused, with keyId
the list shows it; status shows the counts; the four anos account routes
in order, 409 on a second create, 404 on marking someone else's, the
unsigned lookup answering vouched.

## Step 4. The web app scaffold

- `ng new wallet --directory .` in ~/Desktop/Z/web_app (standalone,
  routing, css, no SSR), `ng add @angular/material` with a prebuilt
  theme; @noble/curves, @noble/hashes, @noble/post-quantum, canonicalize,
  shamir-secret-sharing, express, http-proxy-middleware; scripts server,
  build; proxy.conf.json; .gitignore (node_modules, dist).
- server/index.js, server/app.js, server/config.js.
- src/app/services/: config, session, masterpod-api, keyholder-api,
  anos-api, signing, crypto (with public-ledger-id.ts beside it),
  passkey, shares, log; src/app/constants.ts (the lock minutes, the PRF
  salt label, the polling intervals).
- The shell (toolbar, side navigation, the guard), the routes with
  placeholder pages, the landing with Unlock and the under-construction
  page, the log page.

Check: `ng build` clean; the proxy serves the build on 4300 and
/api/config answers; through ng serve on 4200, Unlock runs an unlock
against the user's masterpod and lands by the next-step rule; the log
shows the calls.

## Step 5. Create, vouching, notifications, the seed inbox

The create stepper with the camera component (normal quality), the
vouching page, notifications with the poll, the seed page.

Check: `ng build` clean; a pod created through the stepper appears in
the masterpod; the vouch round trip between two tabs works as in the test
app.

## Step 6. Identity and setup

public-ledger-id.ts (normalisation, assembly, scrypt, the lookup id), the
identity page's three panes with the copy of schemas.md 8.2, the setup
page with the deposits first and the eighth field, the Retry path.

Check: the test vector of docs/public-ledger-id.md section 8 computed in
the browser and with node:crypto, the same bytes; setup on a vouched pod
leaves five backupcode shares on the keyholders (their logs) and the
eight columns on the masterpod; a refresh in the middle restarts cleanly.

## Step 7. The security buckets

The camera component's high quality mode, bucket one, bucket two with
its minimum, keyId in the deposits and the adds.

Check: the keyholders log securitybucket1 and securitybucket2 shares
with the same keyId the masterpod rows carry; the next-step rule moves
on to the wallet.

## Step 8. The wallet

The accounts page with Create anos account and Resubmit, the account page
with reads, Send, follow-ups and the fund proposal, the signing path
through /api/sign.

Check: an account created from the wallet lands on all five validators
(the masterpod answered the binding, the creation was accepted, the
leader round wrote it); /get-account shows it; a transfer from the OG
account (the signer tool) shows in its list; a transfer out from the
wallet, signed by pair one and the signing server, lands; Send is
disabled while pending.

## Step 9. Chat and marketplace

Ported from the masterpod test app onto Material.

Check: a private room between two tabs, an invite by username, messages
both ways; a listing and its room.

## Step 10. Records and notes

- masterpod_software_architecture: types/complete_setup.md, unlock.md,
  check_anopod_status.md, add_to_security_bucket_one.md and _two.md,
  list_security_records.md, new types/create_anos_account.md,
  mark_anos_account_submitted.md, list_anos_accounts.md,
  get_anos_account.md; tables/anopods.md, security_images.md,
  security_info.md, new tables/anos_accounts.md; objects/blobs.md;
  rules/endpoints.md, client_crypto.md, not_built_yet.md; flows/
  how_setup_works.md, how_the_security_buckets_work.md,
  how_the_test_app_works.md (pointing at the wallet), new flows/
  how_an_anos_account_is_made.md.
- anos_software_architecture: rules/endpoints.md, configuration.md,
  not_built_yet.md; new types/get_account.md, list_transactions.md,
  access_levels.md; new tables/nonces.md; types/account_creation.md and
  flows/how_an_account_is_created.md (check 5); flows/
  how_a_wallet_builds_a_transaction.md (the wallet, the signing server).
- keyholder_software_architecture: rules/ids.md and not_built_yet.md
  (the real ids, breakglasskey sent, the wallet as the phone),
  flows/how_the_test_app_works.md.
- docs/schemas.md section 11 and docs/public-ledger-id.md section 8
  here; the signing server's README.

## Step 11. Finish

`ng build` clean, every server booted fresh once, the whole flow run
through in the browser from landing to a transfer, then the list of
changed files per repository with a suggested commit message for each:
signingserver and web_app (git init by the user), anossoftware,
masterpodsoftware, and the three record folders.
