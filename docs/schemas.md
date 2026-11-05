# The wallet web app: what gets built

One Angular app with a small Express proxy, at wallet.masterpod.com one
day and on this machine now, that does everything the three test apps do
(test-web-app for anos, masterpod-test-web-app, keyholder-test-web-app) in
one flow: create an anoPod, get vouched, give the identity record, set up,
fill the security buckets, make anos accounts, send anos, chat, trade.
Beside it, a stand-in signing server, and the changes to masterpodsoftware
and anossoftware the wallet needs. keyholdersoftware does not change.

Every shape not written here is exactly as the three architecture record
folders describe it (~/Desktop/Z/masterpod_software_architecture,
keyholder_software_architecture, anos_software_architecture). Where this
document differs from them, this document wins; the records get updated
at the end of the build. The public ledger id is in
docs/public-ledger-id.md.

Shapes are written as in the records: hex is lowercase hex of raw bytes,
an id 32 bytes; a route is "POST /path (level)"; a refusal "<status>
<reason>". Levels: the masterpod's none / session / vouched / setup; the
validators' new "account" level (section 5.3).

## 1. The pieces, and who calls whom

    browser (the Angular app)   the wallet origin only:
                                GET  /api/config
                                POST /api/masterpod/<route>
                                POST /api/anos/<n>/<route>
                                POST /api/keyholder/<n>/<route>
                                POST /api/sign, GET /api/sign/public-keys
    the proxy (server/)         masterpod :3100, validators :3001 to :3005, keyholders :3201 to :3205,
                                the signing server :3300
    a validator                 the masterpod, POST /get-anos-account (new); the other validators, as today
    a keyholder                 the masterpod, POST /get-anopod-session-keys, as today
    the signing server          nobody

Ports on this machine: 4200 ng serve (the user runs it), 4300 the proxy,
3300 the signing server, the rest as they are.

Folders

    ~/Desktop/Z/web_app           the Angular workspace, project "wallet": src/, server/, docs/, proxy.conf.json
    ~/Desktop/Z/signingserver     the stand-in signing server, its own project

Both are new and not git repositories yet; the user runs git init and
commits.

## 2. The proxy (web_app/server/)

Express 5 and http-proxy-middleware, ESM, three files: server/index.js
(listens), server/app.js (createApp: the routes below), server/config.js
(the variables, every one with a local default, so no env file is needed
on this machine).

    variable            default                                              meaning
    PORT                4300                                                 where it listens
    MASTERPOD_URL       http://localhost:3100                                the masterpod API
    VALIDATOR_URLS      http://localhost:3001,...,http://localhost:3005      comma separated, in validator order
    KEYHOLDER_URLS      http://localhost:3201,...,http://localhost:3205      comma separated, in keyholder order
    SIGNING_SERVER_URL  http://localhost:3300                                the signing server
    SHARE_THRESHOLD     3                                                    how many shares rebuild a secret
    DEFAULT_VALIDATOR   1                                                    the validator the wallet posts to
    DIST_DIR            dist/wallet/browser                                  the Angular build it serves
    RP_ID               localhost                                            the relying-party id the browser uses in both ceremonies; the masterpod's RP_ID

Routes

    GET  /api/config                  200 { validators, keyholders, shareThreshold, defaultValidator, rpId }: the two counts
                                      are the list lengths; the browser never sees an address
    GET  /api/health                  200 { status: "ok" }
    ANY  /api/masterpod/<path>        forwarded to MASTERPOD_URL/<path>
    ANY  /api/anos/<n>/<path>         forwarded to VALIDATOR_URLS[n - 1]/<path>; n not 1..count: 404 { error: "unknown validator" }
    ANY  /api/keyholder/<n>/<path>    forwarded to KEYHOLDER_URLS[n - 1]/<path>; likewise 404 { error: "unknown keyholder" }
    POST /api/sign                    forwarded to SIGNING_SERVER_URL/sign
    GET  /api/sign/public-keys        forwarded to SIGNING_SERVER_URL/public-keys
    anything else under /api          404 { error: "Not Found", path }
    everything else                   the files of DIST_DIR; index.html for a path that is not a file (the router's deep links)

Behaviour
- Bodies are streamed, never parsed: no express.json in front of the
  proxy, so a 70 MB bucket request passes through as it is. Headers go
  through as received, the browser's Origin included, so the backends'
  CORS rules see http://localhost:4200 as they do today.
- The backend's status and body come back unchanged. A backend that does
  not answer: 502 { error: "<masterpod | validator n | keyholder n |
  signing server> unavailable" }. Proxy timeout 120 seconds.
- The signed envelope's path is the backend path: the browser signs
  "/complete-setup" and posts to /api/masterpod/complete-setup; the proxy
  strips its prefix and the masterpod sees /complete-setup.
- Nothing is logged but boot lines and 502s.

Development: proxy.conf.json sends /api to http://localhost:4300, so ng
serve on 4200 goes through the real proxy. `npm run server` starts the
proxy; `npm run build` then `npm run server` serves the built app on 4300
for a production-like check.

## 3. The signing server (~/Desktop/Z/signingserver)

The stand-in for the serversigner software: it signs whatever the wallet
hands it with the wallet pair and hands it back. Express 5, ESM, no
database, no auth. Files: src/server.js, src/app.js, src/keys.js,
src/sign.js, src/crypto/canonical.js and src/crypto/signatures.js (copies
of anossoftware's, the latter with an ML-DSA-87 sign added:
nodeSign(null, message, privateKey)).

Keys: keys.json in the project root, git-ignored, made at first boot when
missing: a P-256 pair and an ML-DSA-87 pair from node:crypto
generateKeyPairSync, private keys as PKCS#8 DER hex, public keys raw (the
SPKI prefix cut, as keyholdersoftware's make-keys does): 33 bytes
compressed and 2592 bytes. Every boot logs the two public keys.

    GET  /                  the text "signingserver"
    GET  /health            200 { status: "ok", uptime }
    GET  /public-keys       200 { walletKey: hex (33), walletPostQuantumKey: hex (2592) }
    POST /sign              body { transaction: { payload: object, signatures: object } }
                            200 { transaction } with signatures.walletKey (64 bytes r||s over the SHA-256 of
                            the RFC 8785 canonical bytes of payload) and signatures.walletPostQuantumKey
                            (4627 bytes, pure ML-DSA-87, empty context, over the canonical bytes) set,
                            replacing any present; everything else untouched
                            400 { error: "bad request shape" } when transaction, payload or signatures is not an object

PORT 3300 by default. JSON limit 1 MB (a creation is about 60 KB). No
CORS (only the proxy calls it). `npm start`.

## 4. Masterpod changes

### 4.1 identity_blob

anopods gets one column, identity_blob BYTEA CHECK (octet_length <=
1024), and the all-or-nothing CHECK becomes num_nulls(the seven,
identity_blob) IN (0, 8). Setup complete stays "blob2 set".

POST /complete-setup (vouched) takes an eighth field, identityBlob: hex,
1 to 1024 bytes (92 in practice: PLID || lookupId under the encryption
key, section 7), checked after chatPrivateKeyBlob (400 invalid
identityBlob), written with the others.

POST /unlock answers identityBlob: hex, or null before setup, beside
blob1 and chatPrivateKeyBlob.

### 4.2 The key id on the buckets

security_images and security_info each get key_id BYTEA NOT NULL CHECK
(octet_length = 32). The two add routes take keyId: hex (32), checked
right after the body shape (400 invalid keyId), stored on every row the
request writes. /list-security-records answers keyId on every image and
info. A moderator with the shares of key keyId knows which rows it opens.

### 4.3 Status counts

POST /check-anopod-status answers three more integers: bucketOneImages,
bucketTwoImages, bucketTwoInfos, the caller's rows in each. The wallet's
next-step rule reads them (section 8.1).

### 4.4 anos accounts

A new table, one row per anos account a pod made, and a feature folder
src/anos-accounts/ (router, handlers, service, queries).

    anos_accounts
    account_id    BYTEA PK (32)                     SHA-256 of key1 + postQuantumKey1, as the validators compute it
    anopod_id     BYTEA NOT NULL (32)               the pod; index on it
    account_type  TEXT NOT NULL                     spending | guarded | vault | assisted (CHECK)
    key_blob      BYTEA NOT NULL (<= 1024)          pair one and pair two's private halves under the encryption key, 156 bytes (section 7)
    creation      JSONB NOT NULL                    the signed creation transaction, all eight signatures, as posted to the validator
    submitted_at  TIMESTAMPTZ                       null until a validator answered the creation
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(), the set_updated_at trigger

No foreign keys, never deleted. The masterpod never verifies anos
signatures; the validators do.

    POST /create-anos-account (setup)
    body { accountId: hex, accountType: string, keyBlob: hex, creation: { payload, signatures } }
    checks, in order: the shape (400 bad request shape); accountId 32 bytes (400 invalid accountId);
      accountType one of the four (400 invalid accountType); keyBlob 1 to 1024 bytes (400 invalid keyBlob);
      creation.payload.accountId decodes to the same 32 bytes, creation.payload.accountType equals accountType,
      creation.payload.transactionType is "accountCreation", creation.signatures has the eight string fields
      key1, postQuantumKey1, key2, postQuantumKey2, breakGlassKey, breakGlassPostQuantumKey, walletKey,
      walletPostQuantumKey (400 invalid creation); no row with this accountId (409 account already registered)
    writes: INSERT anos_accounts, submitted_at null
    answer: 201 { accountId }

    POST /mark-anos-account-submitted (setup)
    body { accountId: hex }
    checks: the shape and the id (400); a row with this accountId and this pod (404 account not found)
    writes: UPDATE submitted_at = COALESCE(submitted_at, now())
    answer: 200 { accountId, submittedAt: ISO 8601 }

    POST /list-anos-accounts (setup)
    body { }
    answer: 200 { accounts: [ { accountId, accountType, keyBlob: hex, creation, submittedAt: ISO 8601 | null, createdAt } ] },
      the caller's rows, oldest first

    POST /get-anos-account (none)
    body { accountId: hex }
    checks: the shape and the id (400 bad request shape); the row (404 unknown account)
    answer: 200 { accountId, anopodId, vouched: boolean }, vouched read from the pod's row. Unsigned, like
      /get-anopod-session-keys: for the validators.

Level setup implies vouched and setup complete, which is "they are
vouched" of the flow, and the encryption key the keyBlob is under exists.

### 4.5 Applying it

db/schema.sql changes; locally `npm run db:reset` (the table changes
cannot be added by db:setup), then the genesis super seed again with
make-super-seed once the first pod exists. The README, docs/schemas.md
section 11 and the records change with the code.

## 5. Validator changes (anossoftware)

### 5.1 A nonces table and two variables

db/schema.sql gets the keyholder's nonces table as it is (nonce BYTEA PK
16 to 32 bytes, expires_at, the index). `npm run db:setup` adds it to
anos1 to anos5 without a reset. env.js gets two optional variables:
MASTERPOD_URL (default http://localhost:3100) and
TIMESTAMP_WINDOW_SECONDS (default 120), read through an optional helper
like the masterpod's. The five env files need no edit.

### 5.2 The binding check on /create-account

verifyCreateAccount gets a fifth check after uniqueness: POST
MASTERPOD_URL/get-anos-account { accountId } (src/masterpod/
masterpod.client.js, 5-second timeout, shaped like the keyholder's
client). It passes only on a 200 whose anopodId decodes to 32 bytes and
whose vouched is true. Anything else, a 404, a timeout, a 5xx, a bad
body, vouched false, refuses the submission with 400 { error: "bad
request" } and writes no log line: the request is dropped like garbage,
as decided. Only the receiving validator asks; the validator-to-validator
approval path trusts it, as it does for everything else.

### 5.3 The account level

A fourth kind of caller: an account signing with pair one, for reads.
src/auth/ gets signed-request.js (parseSignedRequest and verifyBoth),
common-checks.js and nonces.queries.js, copied from keyholdersoftware
with their comments pointed at this server, and require-account.js:

1. Shape: { payload: { accountId, path, timestamp, nonce, body },
   signatures: { ecdsa, mldsa } }, every field a string, body an object.
   400 bad request shape.
2. payload.path equals the route. 401 path mismatch.
3. The timestamp within TIMESTAMP_WINDOW_SECONDS of now, either way. 401
   timestamp outside window.
4. accountId decodes to 32 bytes (400 invalid accountId); an accounts row
   (401 unknown account); both signatures over the canonical payload
   against public_key1 and public_key_pq1 (401 bad signature).
5. The nonce, 16 to 32 bytes (400 invalid nonce), new in nonces (401
   replay), kept twice the window.
6. req.account = the id, req.body = payload.body.

### 5.4 The two reads

src/reads/ (router, handlers, service, queries), wired in app.js. Both
answer the signer's own account only; nothing about anyone else.

    POST /get-account (account)
    body { }
    answer: 200 { accountId, type, balance: millionths as a decimal string, latestTransactionId: hex | null,
      createdAt: ISO 8601 }. latestTransactionId is the transaction_id of the garlic_chain link with the
      highest position whose account_id is the signer: what the next transfer names as previousTransactionId.

    POST /list-transactions (account)
    body { beforePosition?: integer, limit?: integer (default 50, at most 200) }
    answer: 200 { transactions: [ { transactionId, position, type, accountId, accountIdTo, amount: string,
      createdAt } ], pending: [ { transactionId, type, accountId, accountIdTo, amount: string, createdAt,
      approved } ] }
    transactions: garlic_chain links where account_id or account_id_to is the signer, position descending,
      below beforePosition when given, limit rows; createdAt the row's created_at. pending: the signer's
      pending row (there is at most one), fields read from og_transaction.payload (transactionType, accountIdTo,
      amount or "0", createdAt). The other holding tables (locked, assisted, escrow, fund proposals) are not
      listed; a guarded transfer shows up when it lands (section 10).

Refusals are 400 or 401 + { error }, logged "failed: <reason>" like
every other route. The 1 MB JSON limit stays.

## 6. The keyholders

No change to keyholdersoftware. What the wallet sends them is what the
keyholder test app sends, with the stand-ins replaced:

- publicLedgerId: the real PLID, 32 bytes (docs/public-ledger-id.md).
- lookupId: the real rule, section 6 there.
- shareType: backupcode at setup, securitybucket1 and securitybucket2 at
  each bucket add, and breakglasskey at each anos account creation, the
  type nothing sent before.
- keyId: 32 random bytes per secret, the same on every keyholder, and
  (new) the same value the masterpod gets with the bucket add.

The deposit rule, everywhere a secret is made
1. The secret is split into as many shares as /api/config says
   keyholders (five), threshold shareThreshold (three), with
   shamir-secret-sharing as today.
2. Share n goes to keyholder n through /api/keyholder/n/receive-share,
   the receiving key fetched through /api/keyholder/n/get-keyholder-public-key
   once per session, in order 1 to 5.
3. Every keyholder must answer 201 before the masterpod step that
   follows (complete-setup, the bucket add, create-anos-account). One
   failure stops the step: the screen says which keyholder refused, and
   Retry starts the step again with a fresh secret and a fresh keyId.
   The shares already stored are orphans under a keyId nothing names;
   reads list newest first, so they never get in the way.
4. So "stored on the masterpod" means "the keyholders have it". No
   temporary table, no state column.

## 7. Client crypto, new or changed

Everything the three test apps compute stays as the records say
(masterpod rules/client_crypto.md, keyholder rules/client_crypto.md, anos
flows/how_a_wallet_builds_a_transaction.md). New or changed:

    PLID, lookupId      docs/public-ledger-id.md; scrypt from @noble/hashes/scrypt, SHA-256 from @noble/hashes
    identityBlob        AES-256-GCM under the encryption key of PLID (32) || lookupId (32): iv || ciphertext || tag, 92 bytes
    break-glass seed    32 random bytes per anos account. breakGlassKey: P-256 scalar = HKDF(seed, "anos/break-glass-p256/v1", 48)
                        as an integer mod (n - 1), plus 1, the backup code's rule; breakGlassPostQuantumKey: ML-DSA-87
                        keygen(HKDF(seed, "anos/break-glass-mldsa/v1", 32)). HKDF-SHA-256, empty salt. The seed is
                        split and deposited as breakglasskey, then wiped; it is never sent to the masterpod.
    keyBlob             AES-256-GCM under the encryption key of key1 scalar (32) || postQuantumKey1 seed (32) ||
                        key2 scalar (32) || postQuantumKey2 seed (32), 156 bytes. ML-DSA-87 keys come back from
                        their seeds (the test wallet's generateMlDsaKey(seed)), P-256 public keys from the scalars.
                        Opened only to sign, then dropped; the ciphertext stays in RAM for the session.
    the wallet pair     fetched once per session from /api/sign/public-keys; a creation payload carries them as
                        walletKey and walletPostQuantumKey; the browser makes the other six signatures and
                        /api/sign adds the two. Every transfer, fund proposal and follow-up is signed by pair one
                        in the browser and by the wallet pair through /api/sign, then posted to the validator.
    the account envelope for reads
                        { payload: { accountId, path, timestamp, nonce, body }, signatures: { ecdsa, mldsa } }:
                        the pod envelope with accountId as the signer field, signed by pair one (P-256 r||s over
                        the SHA-256 of the canonical bytes, ML-DSA-87 over the bytes), nonce 16 random bytes.
    the bucket keyId    sent with the add as well as in the deposits.
    the backup code     shown once as base32 in groups of four, with a Complete button; never typed back.
    the wallet pair of the test wallet
                        wallet-keys.ts is not carried over.

## 8. The web app (src/)

Angular 22, standalone components, signals, the router, Angular Material
22 with a prebuilt theme and no custom styling, web first: a toolbar and
a side navigation on a desktop, the navigation collapsing behind a menu
button on a phone. Everything secret lives in RAM and dies with the tab,
as in the test apps; a new tab unlocks again.

### 8.1 Shell, routes, guards

    /                        landing: Unlock, Create account, Recover account
    /create                  the create stepper
    /recover                 "Coming soon: under construction during Test Net"
    /vouching                find seeds, send requests, wait
    /identity                the public ledger id: why, the form, the review
    /setup                   keys, the backup code, the deposits, complete-setup
    /security/bucket-one     the high quality selfie
    /security/bucket-two     ID, phone, email, a contact, more
    /wallet                  the anos accounts and Create anos account
    /wallet/:accountId       one account: balance, transactions, send, follow-ups, fund proposal
    /chat                    rooms, invites, join requests, messages
    /marketplace             listings
    /notifications           the list, mark read
    /seed                    the vouch request inbox (seeds only)
    /log                     the activity log, newest 40 calls, polls excepted (the test apps' Log)

A guard sends anyone without a session to /. Which pages the navigation
shows follows the status: vouching until vouched; identity and setup
until setup is complete; security, wallet, chat and marketplace once it
is; seed when isSeed.

The next-step rule, applied after an unlock and after each step
finishes:

    not vouched                                   /vouching
    vouched, setup not complete                   /identity
    setup complete, bucketOneImages = 0           /security/bucket-one
    bucketTwoImages = 0 or bucketTwoInfos < 3     /security/bucket-two
    otherwise                                     /wallet

The user may navigate anywhere the navigation shows at any time.

### 8.2 The screens

Landing. Unlock: /challenge (unlock), the passkey assertion with the PRF
salt, /unlock; opens blob1, chatPrivateKeyBlob and identityBlob; then
/check-anopod-status and the next-step rule. The platform's passkey
picker is what says whether a passkey exists; with none, the
authenticator's own message shows and the page suggests Create. Create
goes to /create, Recover to /recover.

Create, a linear Material stepper
1. "Step 1 of creating your anoPod is to become vouched. We do this to
   keep the anoSphere safe and secure." First name, last name. Next.
2. Username: checked as typed through /check-username, debounced 400
   ms, "available" or "taken" shown; Next enabled when available.
3. Selfie: the camera component (section 8.4), preview, retake. Next.
4. Create: one button: /challenge (create), the passkey registration
   with the PRF extension, the two ephemeral keys, /create-anopod. On
   201: the session is open; "Your anoPod is created, now get vouched",
   Continue to /vouching. If the registration returned a PRF output it is
   kept; otherwise setup will unlock first, as the test app does.

Vouching. "Pick one or two or more to vouch for you. You'll have to check
back after you've been vouched for." A username search (/search-usernames)
showing the profile card with the selfie and the seed flags, a Send
request button (/send-vouch-request). The requests sent this session
listed. The status line (vouchCount, vouched) refreshed by the
notification poll (every 5 s, as today); when vouched, Continue to
/identity. A seed approving or declining uses /seed.

Identity, three panes
1. Why: the plain-English explanation, in these points: step 6 of setup
   is your public ledger id; we do not store what you type; it is turned
   into a one-way hash on your device; the hash is kept encrypted by
   independent keyholders, not in our database; it exists so you, or one
   day your heirs, can prove this identity made this account after a
   complete lockout, and recover the account and its anos; it cannot be
   deleted, by anyone, ever, and you have to know that before you go on;
   a very sophisticated attack could leak a hash of your birth record,
   and there are far easier ways to learn a birthday or a maiden name.
   A checkbox "I understand this record can never be deleted" and
   Continue, enabled by the checkbox.
2. The form, docs/public-ledger-id.md section 1: the nine fields, a
   Known / Unknown select beside the five that allow it, a country
   select, a date picker. Above it: write things the common way they
   are written today, your best guess of your birth certificate; St.
   Louis or Saint Louis both can be tried in a recovery, but the more
   exact, the easier; if you do not know, choose Unknown. Submit.
3. Review: every answer as given. "Check that everything is right. If
   this is wrong, you may not be able to recover after a complete
   lockout, and your heirs may fail to recover it in the future." Edit
   goes back; "All information is correct" computes the PLID and the
   lookup id (scrypt takes well under a second), drops the answers, and
   goes to /setup.

Setup. A Start button. In order, shown as a progress list: generate the
encryption key, the backup code, the backup code keys, the chat pair,
blob1, blob2, chatPrivateKeyBlob, identityBlob (if the PRF output is not
in RAM, an unlock first); show the backup code in groups of four with "I
have written it down, complete"; on Complete: deposit the backup code
(section 6, backupcode), then /complete-setup with the eight fields; on
200 drop the code and go on by the next-step rule. A failed deposit shows
Retry (section 6, step 3). A /complete-setup refused with 409 setup
already complete means a dropped answer earlier: /check-anopod-status,
and if setup is complete, carry on.

Bucket one. "Add a high quality selfie." The camera component in high
quality (ideal 1920 by 1080, JPEG quality 0.95), up to five images,
preview and remove. Add: a fresh bucket key and keyId; each image
encrypted under the key; the deposits (securitybucket1); then
/add-to-security-bucket-one with keyId and the images; on 201 the key is
dropped and the next-step rule runs. Bucket two is reachable from the
navigation afterwards and the user can add more later.

Bucket two. "Things that prove you are who you say you are. The minimum
now: a good photo of your ID, your phone number, your email, and someone
who can vouch for you by phone, like a spouse or someone who lives with
you. You can add more later." Images (the camera component in normal
quality, or files), and text fields: phone, email, contact name, contact
phone, plus free extra lines, one per line as today. Add needs at least
one image and the three texts phone, email and contact; each text is one
info entry, as "phone: +1 ...", "email: ...", "contact: name, phone". The
flow is bucket one's with securitybucket2 and
/add-to-security-bucket-two.

Wallet. "Your anoPod is complete." The accounts from
/list-anos-accounts, each with its type, its masterpod state (submitted
or not) and its ledger state from /get-account (unknown account means not
landed yet; a balance once it has). Create anos account: a type select
(spending, guarded, vault, assisted) and a button that runs, as a
progress list:
1. pair one, pair two, the break-glass seed and its two keys; the
   wallet public keys from /api/sign/public-keys; accountId; the
   creation payload (the test wallet's buildCreateAccountTransaction,
   with the wallet keys from the server) signed by the six keys here;
2. the break-glass seed deposited (section 6, breakglasskey);
3. /api/sign: the two wallet signatures added;
4. /create-anos-account with keyBlob and the signed creation;
5. /api/anos/1/create-account with the signed creation; a 202, or a 400
   saying the account or its transaction already exists, counts as
   submitted;
6. /mark-anos-account-submitted.
A failure before step 4 shows Retry, which starts over with fresh keys. A
failure at step 5 or 6 leaves the row unsubmitted; the list shows
Resubmit on such an account, which re-posts the stored creation (step 5)
and marks it (step 6). Then the account polls /get-account every 5
seconds until it is on the ledger.

Account. Balance, type, the latest transaction id, the transaction list
from /list-transactions (newest first, Load more with beforePosition),
the pending transaction if any, Refresh, and a 5-second poll while
something is pending. Send: recipient account id (typed, as the anos test
app), amount in anos, and the kind the account type allows, ported from
the test wallet: spending picks plain, escrow or stake with a purpose;
guarded and vault date the transfer the lock plus the offset ahead (the
local constants, 1 + 1 and 2 + 1 minutes, kept in a constants file);
assisted sends assistedAnosTransfer. previousTransactionId is
/get-account's latestTransactionId, fetched right before building. The
payload is signed by pair one (keyBlob opened for the signature and
dropped), /api/sign adds the wallet pair, the validator gets it, the
list refreshes. Send is disabled while the account has a pending
transaction (one per account). Follow-ups (attestation, assisted
transfer cancel, guardian vote, escrow success / cancel / dispute /
verdict) and the fund proposal form are the test wallet's, ported with
the same fields and the same signing path.

Chat and Marketplace: the masterpod test app's sections, ported to
Material lists and forms, the same calls, the same polls (messages every
3 s), invites by username, the join inbox, listings with filters and
sort, a listing's room.

Notifications: the list, newest first, mark read; the 5-second poll
runs while a session is open and updates the status (vouched, counts).

Seed: /list-vouch-requests with selfies, approve and decline, for a seed
or super seed.

Log: the test apps' call log, newest 40, path, status and answer, polls
excepted, with the keyholder and anos calls included.

### 8.3 Services and state

    config.service          GET /api/config once; the counts and the threshold
    session.service         signals: anopodId, username, firstName, lastName, the session keys, the PRF output
                            while needed, the encryption key, the chat keys, the PLID and lookup id, the status
                            from /check-anopod-status, the keyholder receiving keys, the wallet public keys, the
                            accounts (keyBlob ciphertext and creation, never open keys); the next-step rule
    masterpod-api.service   the keyholder test app's api.service.ts, base path /api/masterpod, the two changed
                            routes and the four new ones added
    keyholder-api.service   the keyholder test app's, base path /api/keyholder/<n>
    anos-api.service        the anos test app's account-api.service.ts, base path /api/anos/<defaultValidator>,
                            plus the two signed reads
    signing.service         /api/sign/public-keys and /api/sign
    crypto.service          the keyholder test app's crypto.service.ts plus the anos test app's (keys, the
                            builders, signing), plus section 7 and the public ledger id
    passkey.service         the keyholder test app's, unchanged
    shares.service          the deposit rule of section 6, one function: deposit(secret, shareType)
    log.service             the activity log

Keys are regenerated from blobs at each unlock; nothing secret touches
localStorage, sessionStorage or IndexedDB.

### 8.4 The camera component

One component for the selfie, the bucket images and any photo: when
getUserMedia is available it shows the live camera (facingMode user,
width and height ideal from a quality input: normal 1280 by 720, high
1920 by 1080), a Take photo button, the frame drawn to a canvas and
encoded as JPEG (quality 0.92 normal, 0.95 high), preview, Retake. Below
it always a file input, accept image/*, with capture="user" so a phone
offers its camera, as the fallback when the camera is refused or absent.
The output is { contentType, bytes } for the caller to encrypt or send.

## 9. Configuration, and running it on this machine

What runs, who starts it

    masterpod          the user, npm run dev on 3100, after db:reset and the genesis super seed
    validators 1 to 5  the user, already running with --watch; npm run db:setup once for the nonces table
    keyholders 1 to 5  the user, KEYHOLDER=N npm run dev on 3201 to 3205
    signing server     the user, npm start on 3300
    the proxy          the user, npm run server in web_app, on 4300
    ng serve           the user, on 4200, with proxy.conf.json

Masterpod WEB_ORIGIN and RP_ID stay http://localhost:4200 and localhost:
the browser's origin is 4200 and the passkey ceremonies happen there. On
the testnet they are the three origins https://wallet.anocloud.com,
https://attestor.wallet.anocloud.com and https://moderator.wallet.anocloud.com
and the one id wallet.anocloud.com, the proxy's RP_ID, and the proxy's URLs
point at the real servers through the committed network/wallet.env
(section 11, Deploy build 1).

## 10. Out of scope, not built

- Recover account: the locked-out flow and the case view are built
  (section 12, build 1, 2026-10-26); the moderator section is build 2 and
  the finish build 3.
- Sending anos to a username: the recipient is a typed account id.
- The real signing server (the serversigner software, tomorrow): no
  checks of what it signs, no auth.
- Keyholder discovery and ceremonies: the proxy's list is the truth.
- A retry of a failed keyholder deposit: the step restarts with a new
  secret.
- Reads of the other holding tables; the wallet shows a guarded or vault
  transfer only when it lands.
- Any check by a validator that walletKey in a creation is the signing
  server's key: the binding check with the masterpod is the check.
- Several passkeys, push delivery, languages other than English, a custom
  theme, rate limits.

## 11. Build notes

Filled in during the build: what was checked, the test vector, anything
that differed from the plan and why.

### Step 1, the signing server (2026-10-25)

- Built as section 3 says. `src/crypto/canonical.js` and `signatures.js`
  are anossoftware's copies; they import `hash.js` and `bytes.js`, so those
  two came along unchanged (four files under `src/crypto/`, not two).
- `keys.json` holds, beside the two keys, an `about` line and `createdAt`.
  Every boot re-derives each public key from its private key and refuses a
  file where they disagree.
- Checked by `test/rig.mjs` (19 checks, boots the server on 3301 so a
  server on 3300 is not disturbed): both public key sizes; `/sign` on a
  creation built the way the test wallet builds one returns the payload and
  the six other signatures untouched and both wallet signatures, each
  verified with `node:crypto` the way a validator verifies them; `/sign`
  on a transfer-shaped payload; the four malformed bodies (no payload, no
  signatures, no transaction, an array) answer `400 bad request shape`;
  unknown paths answer 404.

### Step 2, the validators (2026-10-25)

- Built as section 5 says, with one placement: check 5 runs in
  `receiveCreateAccount`, not inside `verifyCreateAccount`, because the
  validator-to-validator approval path calls `verifyCreateAccount` too and
  only the receiving validator may ask the masterpod (5.2). The refusal
  travels as `{ ok: false, reason: 'bad request', dropped: true }` and the
  handler answers it without a log line.
- The copied keyholder files answer through `ok / refuse / answer`, so
  `src/util/result.js` was copied too. `require-account.js` reads pair one
  with the transfer feature's `findAccount`.
- The nonces table went live on `anos1` to `anos5` through `psql` as the
  superuser under `SET ROLE anossoftware` (the user's rule), the statements
  `db/schema.sql` now carries; `npm run db:setup` is a no-op for it now.
- Both optional variables default (`http://localhost:3100`, 120 seconds);
  the five env files were not touched.
- Checked by `anossoftware/test/rig.mjs` (34 checks): a validator booted on
  3009 against `anos1` with its settings in the environment and a throwaway
  key; the OG account (keys from `~/Desktop/og-account-keys.json`) reads its
  balance, newest id and links, pages with `limit` and `beforePosition`;
  wrong signature, replay, old and future timestamp, wrong path, bad shape,
  missing mldsa, unknown account, bad id, short nonce, bad `limit` and bad
  `beforePosition` are refused with their reasons; a full valid creation
  for an account the masterpod does not know answers `400 { error: "bad
  request" }` with nothing in the captured log, while a creation failing
  check 1 still logs its reason. The user's five validators (`--watch`)
  restarted on the change and answer `/get-account` on 3001 and 3003.

### Step 3, the masterpod (2026-10-25)

- Built as section 4 says. `/get-anos-account` reads `vouched` with a
  `LEFT JOIN` on `anopods` (a vanished pod reads as false);
  `/mark-anos-account-submitted` on a bad id answers `400 invalid
  accountId`, the lookup on one `400 bad request shape`, as 4.4 words each.
- Checked by `masterpodsoftware/test/rig.mjs` (42 checks) on a throwaway
  database built from `db/schema.sql` and a masterpod booted on 3199. Pods
  are written straight into that database with session keys the rig made
  and a passkey the rig holds, so `/unlock` could be exercised with a forged
  WebAuthn assertion. Every check of the plan passed: eight-field setup and
  `400 invalid identityBlob` without the eighth, `identityBlob` in the
  unlock answer (null before setup), both adds refused without `keyId` and
  listed with it, the three counts, the four anos account routes in order,
  `409` on a second create, `404` on marking someone else's, the unsigned
  lookup answering `vouched`. The throwaway database is dropped at the end.
- The live `masterpod` database still has to be rebuilt (4.5): the build
  tooling refused to drop it, so the user runs `npm run db:reset` in
  masterpodsoftware, restarts the masterpod (it runs without `--watch`, so
  it is still on the old code), creates the first pod through the wallet and
  runs `make-super-seed`, as before.

### Step 4, the web app scaffold (2026-10-25)

- `ng new wallet --directory .` ran in the non-empty folder (docs/ kept),
  with `--skip-git`, `--skip-tests` and `--ssr=false`; `ng add
  @angular/material --theme=azure-blue` added the prebuilt theme as
  `src/material-theme.scss` (the Material 22 way: one `mat.theme` include)
  and the Roboto and Material Symbols links. `package.json` got `"type":
  "module"` for the ESM proxy and the `server` script. The initial-bundle
  warning budget was raised to 3 MB (the post-quantum libraries alone pass
  500 kB), so `ng build` prints no warning.
- The proxy mounts every forwarder at the root with a `pathFilter` and a
  `pathRewrite` that cuts the prefix; an `app.use('/prefix')` mount hands
  http-proxy-middleware a path with the prefix already stripped, which was
  the first version's bug. The two signing server routes are method
  specific, so `GET /api/sign` is the 404 of "anything else under /api".
  `server.setMaxListeners(32)` because thirteen proxies each listen for the
  server closing. `http-proxy` prints a `util._extend` deprecation line at
  boot under Node 24; it is the library's, not ours.
- The HTTP plumbing lives in `log.service.ts` (`post`, `get`), so every call
  is logged in one place; the three API services call it. The unlock flow
  is `src/app/unlock.ts`, shared by the landing page and by setup (which
  unlocks first when the PRF output is not in RAM); `session.open()` for
  the same pod keeps what is in RAM (the identity) and only replaces the
  session keys. `src/app/countries.ts` holds the alpha-2 codes for the
  identity form. `NotificationItem` lives in `session.service.ts`
  (re-exported by the masterpod service) because the session holds the
  polled list. The notification poll runs in the shell (`app.ts`), every 5
  seconds while a session is open, refreshing the notifications and the
  status.
- Checked: `ng build` clean; the proxy booted on 4300 answers `/api/config`
  `{ validators: 5, keyholders: 5, shareThreshold: 3, defaultValidator: 1
  }`, forwards to the masterpod (`/check-username` through it), to each
  validator and keyholder by number (`/api/anos/9` and `/api/keyholder/7`
  are 404, `/api/anos/10` does not match validator 1), to the signing
  server (`502 signing server unavailable` while it is down, the public keys
  and a signature when a rig instance runs on 3300), a signed `/get-account`
  to validator 3 through it answered 200 with the browser's Origin passed
  through (CORS header `http://localhost:4200` came back); deep links serve
  `index.html`. The unlock through ng serve against the user's masterpod
  waits for the masterpod to be reset and restarted (step 3).

### Step 5, create, vouching, notifications, the seed inbox (2026-10-25)

- Built as 8.2 says: the linear stepper (names, the debounced username
  check, the camera component in normal quality, Create), the vouching
  page, the notifications page, the seed page. The camera component emits
  every photo taken or file chosen and `cleared` on Retake; the stepper
  replaces its one selfie, the bucket pages keep a list with Remove.
- The camera's live preview needs `getUserMedia`; a refused or absent camera
  shows a line and leaves the file input, `accept="image/*"
  capture="user"`, which is always there.
- `ng build` clean. The browser checks (a pod created through the stepper
  appears in the masterpod; the vouch round trip between two tabs) wait for
  the user's ng serve and the reset masterpod; they are part of step 11's
  run-through.

### Step 6, identity and setup (2026-10-25)

- `public-ledger-id.ts` is pure functions: `normaliseText`, `formatDate`,
  `normaliseAnswers`, `assemble`, `publicLedgerIdOf` (scrypt from
  `@noble/hashes/scrypt.js`, N 16384, r 8, p 1, dkLen 32, maxmem 64 MiB),
  `lookupIdOf`, `identityIdsOf`. The test vector of
  `docs/public-ledger-id.md` section 8 was computed with that library under
  Node and with `node:crypto`'s `scryptSync`: the same 32 bytes, the same
  lookup id. The identity page runs the same file in the browser.
- The identity form keeps its answers in the component's signals; "All
  information is correct" computes both ids, puts them in the session (RAM)
  and clears every field, select and the checkbox before leaving for
  /setup. The country select lists the 249 alpha-2 codes
  (`src/app/countries.ts`) with names from `Intl.DisplayNames`. The date
  picker is Material's with the native date adapter; the Date it hands over
  is read with `getDate`, `getMonth` and `getFullYear`, never UTC.
- Setup runs the eight derivations as a progress list; the backup code is
  shown in groups of four with "I have written it down, complete". Complete
  deposits the code (`backupcode`) and only then posts `/complete-setup`
  with the eight fields. A keyholder refusal shows Retry, which drops the
  run's secrets and starts over (fresh key, fresh code, fresh keyId), as 6.3
  says. A `409 setup already complete` checks the status and, if complete,
  carries on by the next-step rule, with a line saying an unlock will load
  the keys. A pod without the PRF output in RAM is unlocked first on Start
  (`src/app/unlock.ts`); `session.open()` for the same pod keeps the
  identity, so a refresh between Identity and Setup is the one thing that
  loses it, and the setup page then sends the user back to Identity.
- `ng build` clean. The checks against the live keyholders and masterpod
  (five `backupcode` shares in their logs, the eight columns on the
  masterpod, a refresh in the middle) are part of step 11's run-through.

### Step 7, the security buckets (2026-10-25)

- The camera component takes a `quality` input: normal (1280 by 720, JPEG
  0.92) or high (1920 by 1080, JPEG 0.95). Bucket one uses high, bucket two
  normal; both keep up to five images with previews and Remove. Bucket two
  needs at least one image and the phone, email, contact name and contact
  phone; the texts become `phone: ...`, `email: ...`, `contact: name, phone`
  and one entry per extra line.
- Add: a fresh bucket key, every image (and text) encrypted under it, the
  deposit (`securitybucket1` or `securitybucket2`) which returns the keyId,
  then the masterpod add with that keyId; on 201 the key is zeroed, the
  status re-read and the next-step rule run. A refusal anywhere leaves the
  images in RAM and turns the button into Retry, which starts the step again
  with a fresh key.
- `ng build` clean. The keyholder logs and the masterpod rows are checked in
  step 11's run-through.

### Step 8, the wallet (2026-10-25)

- The browser signs a creation with its six keys and a transfer, proposal or
  follow-up with pair one only; `/api/sign` adds the wallet pair. The
  `signatures` object therefore has six entries on the way to the signing
  server and eight on the way to the masterpod and the validator (the
  masterpod's `invalid creation` check wants all eight).
- Pair one and pair two are kept as secrets (two P-256 scalars, two
  ML-DSA-87 seeds) and wrapped as the 156-byte keyBlob; pair one is opened
  from the blob for every signature, including the signed reads, and dropped
  afterwards. The break-glass seed is deposited as `breakglasskey` and
  zeroed. Amounts are typed in anos with up to six decimals
  (`src/app/amounts.ts`) and travel as millionths.
- The wallet page runs the six steps as a progress list; a failure before
  step 4 (the keys, the deposit, the signing server) shows Retry with fresh
  keys; a failure at step 5 or 6 leaves the masterpod row unsubmitted and the
  list shows Resubmit, which re-posts the stored creation and marks it. A
  validator `400` whose reason says the account or transaction already
  exists counts as submitted. Accounts not on the ledger are polled every 5
  seconds; an account's page polls while it has a pending transaction.
- `ng build` clean. The end-to-end check (an account landing on all five
  validators, the signer tool's transfer in its list, a transfer out) is
  step 11's run-through.

### Step 9, chat and marketplace (2026-10-25)

- Ported from the masterpod test app onto Material lists, expansion panels
  and forms, the same calls and polls (messages every 3 seconds). Room keys
  live in the session for the tab's life, so a room selected in chat is
  readable after a trip to the marketplace. Listing quantities are typed in
  anos and sent as millionths, the masterpod's unit.
- `ng build` clean. The two-tab checks (a private room, an invite by
  username, messages both ways, a listing and its room) are step 11's.

### Step 10, records and notes (2026-10-25)

- The three record folders were updated as the plan lists, plus the index
  files and level files that list routes and tables, so nothing there is
  stale: masterpod README.md (as-of line, 38 routes, 19 tables, where the
  wallet and the signing server are), types/access_levels.md (the new
  none and setup routes); anos README.md and the new
  types/access_levels.md; keyholder README.md. The masterpod's
  how_the_test_app_works.md and the keyholder's keep the test app's
  description below a new opening that points at the wallet, since the
  test apps still run.
- This file's section 11 and public-ledger-id.md section 8 were filled in
  step by step; the signing server's README was written with it in step
  1; the wallet got its own README.

### Step 11, finish (2026-10-25)

- `ng build` clean (1.17 MB initial, no warnings). The built app served by
  the proxy on 4300 was opened in the desktop app's browser pane: the
  landing page, the create stepper, Recover and the session guard (a deep
  link to /wallet lands on the landing page) all render under the Material
  theme with no console errors. The pane blocks camera access, which
  showed that the stepper's hidden selfie step opened the camera on page
  load; the camera now starts only when step 3 is selected.
- Booted fresh during the build: the signing server (its rig, and on 3300
  for the proxy check), a validator on 3009 (its rig), a masterpod on 3199
  on a throwaway database (its rig), the proxy on 4300. The user's five
  validators restarted themselves on the code change (`--watch`) and
  answered the new signed read on 3001 and 3003.
- Not run here, because they need the user's servers and a passkey in the
  user's browser: the masterpod reset and restart (step 3), the signing
  server on 3300 and the proxy on 4300 under the user's hands, and the
  whole flow from landing to a transfer. The first run-through is the
  user's, with the checks of steps 4 to 9 that were deferred to it listed
  in those steps' notes.

### Deploy build 1 (2026-11)

Built 2026-11-03 from `forclaude/wallet-deploy-plan-1.md` section 1 and
appendix B, in this repository and in signingserver, nothing else. The
plan's line numbers matched the tree (web_app at 13d9760, signingserver at
63aa775). The two code changes: `changeOrigin: true` in `server/app.js`
(proxy.conf.json keeps its `false`), and `RP_ID` through `server/config.js`,
`GET /api/config` as `rpId`, the boot lines, `WalletConfig` and
`PasskeyService`, which now takes the id from the configuration in both
ceremonies and no longer reads the page's host. New: `network/wallet.env`,
the three units, the nginx site, the install script, `LICENSE`, the
README section "The wallet servers", the `RP_ID` row and `rpId` in
section 2. In signingserver: its unit, its install script, `LICENSE`,
`"license": "Apache-2.0"`, the README section "On signing1".

Chosen where the plan was silent:

- `text()` trims the value before judging it, so a whitespace-only `RP_ID`
  is refused like an empty one (`RP_ID must not be empty`), and the trimmed
  value is what the browser gets.
- The `RP_ID` row sits last in section 2's variables table and last in the
  README's variables sentence; `rpId` follows `defaultValidator` in the
  `GET /api/config` row. That row does not list `edition` and was not
  changed beyond `rpId`.
- `"license": "Apache-2.0"` sits after `"private": true` in this
  package.json; signingserver's keeps its place, line 15.
- The README section "The wallet servers" is the last section of the
  file, after Layout's closing paragraph, with the four update lines of
  the plan's section 10 as an indented block and no dollar sign anywhere.
- The six appendix B files were copied out of the plan by line range, so
  they are byte-identical to it; `wallet-attestor.service` and
  `wallet-moderator.service` are `wallet.service` with the three lines
  the plan names replaced and nothing else (diff checked). Mode 644, like
  the doorman's scripts: they run with `sh`. `LICENSE` is the masterpod's
  file, same SHA-256 in both repositories.
- In `PasskeyService` the `await this.config.load()` is the first line of
  each ceremony. `ConfigService.load` shares one fetch and the shell
  starts it at launch (app.ts), so in the ordinary case the await resolves
  from that promise within the click's user activation. No import cycle:
  config.service imports log.service, which imports nothing of the app's
  services.

Checked here, with Node 24.22.0 from nvm:

- `node --check` clean on `server/app.js`, `server/config.js`,
  `server/index.js` and signingserver's `src/server.js`; `sh -n` clean on
  both install scripts.
- `ng build` clean: 1.37 MB initial (270 kB estimated transfer), no
  warning; `dist/wallet/browser` holds `favicon.ico`, `index.html`,
  `main-2LVVVTYY.js` and `styles-32FV4QL7.css`.
- The proxy on 4399, a spare port: with `RP_ID=wallet.anocloud.com
  EDITION=attestor`, `/api/config` answered
  `"edition":"attestor","rpId":"wallet.anocloud.com"`, `/api/health`
  `{"status":"ok"}`, and the boot lines ended `edition attestor`,
  `rp id wallet.anocloud.com`; with `RP_ID=` empty the boot stopped with
  `Error: RP_ID must not be empty`, exit code 1; without the variable
  `/api/config` answered `"rpId":"localhost"`. One more boot, with
  `--env-file=network/wallet.env` as the units run it, answered
  `{"validators":8,"keyholders":8,"shareThreshold":3,"defaultValidator":1,"edition":"wallet","rpId":"wallet.anocloud.com"}`
  and printed the eight doormen, api.anocloud.com and signing1 in its boot
  lines: the env file parses. A boot opens no connection; nothing ran
  against any server from this Mac.
- Not checked here, by design: the forwarding with `changeOrigin` against
  the masterpod's and the doormen's certificates, the units, the site and
  the install script on a server. Those are the plan's sections 4 to 9,
  the operator's.


### The iPhone passkey crash (2026-11-05)

- Reported by the user: on https://wallet.anocloud.com the create stepper
  works on a laptop, but on an iPhone 11 (iOS 18.7.8, Safari and Chrome
  alike) it jumped back to step 1 with empty fields the moment the passkey
  sheet closed. Two WebContent crash records from the phone show why: a
  trap (EXC_BREAKPOINT) on the main thread inside WebKit's own
  `PublicKeyCredential.toJSON()`, while it serialises the PRF extension
  outputs, called by `toJson()` in `src/app/services/passkey.service.ts`.
  In WebKit's iOS 18 branch (the 621 train; the phone runs build
  8621.8.1.10.1) that serialiser reads the largeBlob output by a copy-paste
  mistake, and largeBlob is empty because the wallet asks only for PRF, so
  every call traps. A trap kills the page process, where no JavaScript can
  catch it; Safari reloads /create and the stepper starts over. Chrome on
  iOS is the same WebKit. WebKit main was fixed on 2026-03-06, which is why
  iOS 27 in the simulator and desktop Chrome never showed it. Unlock calls
  the same function after `navigator.credentials.get()`, so it would have
  died the same way on the phone.
- The change: `toJson()` never calls the native `toJSON()` and always
  builds the JSON by hand, the branch that already served browsers without
  `toJSON()`. That form carries id, rawId, type, authenticatorAttachment,
  response (clientDataJSON, attestationObject and transports for a
  registration; authenticatorData, signature and userHandle for an
  assertion) and clientExtensionResults, which `register()` still replaces
  with prf enabled only and `assert()` still strips of prf. That is
  everything the masterpod reads: `verifyRegistrationResponse` and
  `verifyAuthenticationResponse` of @simplewebauthn/server 14.0.3 use
  exactly those fields, and `masterpodsoftware/src/auth/webauthn.js` reads
  clientExtensionResults.prf, rawId and response.userHandle. The native
  form's extra registration fields (response.authenticatorData, publicKey
  and publicKeyAlgorithm) were never read.
- Checked here with Node 24.22.0 from nvm: `ng build` clean, 1.37 MB
  initial, no warning. The phone is the user's check, after the deploy.

## 12. Recovery and the moderator edition

Design settled 2026-10-26 (`~/Desktop/Z/forclaude/recovery-and-moderator.md`
records the chat). The masterpod's part of this specification is
`~/Desktop/Z/masterpodsoftware/docs/schemas.md` section 12 (the tables, the
routes, the statuses and events, the client crypto in its 12.6); this
section is the app's part. Three builds in three fresh chats, planned in
`~/Desktop/Z/forclaude/build-1-case-and-recovery-pod.md`,
`build-2-moderation.md` and `build-3-delivery-and-finish.md`. Section 10's
"Recover account: coming soon" ends with build 1.

### 12.1 One codebase, two editions

The moderator app is this app with a moderator section switched on. The
proxy reads `EDITION` (`wallet` or `moderator`, default `wallet`) and
answers it in `GET /api/config` as `edition`; `ConfigService` exposes it.
`moderatorwallet.masterpod.com` is a second proxy with `EDITION=moderator`
pointing at the same backends; the masterpod lists both origins in
`WEB_ORIGIN`. On this machine the user restarts the proxy with
`EDITION=moderator npm run server` to work as a moderator; both editions
live on 4200 through the same `proxy.conf.json`, one at a time.

What the edition changes: the navigation shows Moderation (12.3) when the
edition is moderator and a session is open; the landing card's title says
Moderator wallet. Nothing else. A moderator's pod is an ordinary pod
(username starting with `moderator`, vouched by a super seed, setup
complete, a spending account staked 1000 anos for moderator through the
account page's Send, as today); every other page works as it does.

### 12.2 Routes and guards

    /recover                 Recover account: I'm locked out, or Continue a recovery
    /recover/open            the locked-out stepper (12.3)
    /recover/case            my recovery: the case, its progress, the finish
    /moderation              the cases (moderator edition)
    /moderation/:caseId      one case: profile, events, buckets, sign-off, dismissal, banker packet

`/recover` and `/recover/open` need nothing. `/recover/case` needs a
recovery session (`RecoveryService.hasSession`), else `/recover`.
`/moderation` and `/moderation/:caseId` need a session (`sessionGuard`) and
the moderator edition; a pod that is not a moderator sees the masterpod's
`403 not a moderator` as "This anoPod is not a moderator" on the page.

### 12.3 The screens

**Recover** (`/recover`). Two cards. "I'm locked out": "If you lost the
device with your passkey, we can get you back in. You'll need your birth
record, your username and an email where a moderator can reach you. A
moderator will meet you on a video call and check your security buckets
before anything is released." Button: Start, to `/recover/open`. "Continue
a recovery": "Already opened a case on this device? Unlock it with the
passkey you made then." Button: Continue, which runs `/challenge`
(unlockCase), the passkey assertion with the PRF salt,
`/unlock-recovery-pod`, derives `KEK_prf`, opens `hybridKeyBlob`, and goes
to `/recover/case`. The platform's picker shows the passkeys; with none
the authenticator's message shows.

**Locked out** (`/recover/open`), a linear stepper

1. Your birth record: the nine fields of `docs/public-ledger-id.md` as the
   identity page has them (the same form, moved into a component the two
   pages share, 12.4), "We turn this into the same lookup id you made at
   setup, on this device; nothing you type is sent." Next computes
   `lookupId` with `identityIdsOf` and drops the public ledger id.
2. Who you are: username (lowercased; `/check-username` says taken, which
   here means found; a free username means "no anoPod has that username")
   and contact email. Next.
3. Open my case: one button. `/challenge` (openCase, the username) gives
   the challenge and the pod's id; the passkey registration with the PRF
   extension and that id as user handle; the PRF output from the
   registration or, when it returned none, one local assertion with a
   random challenge; `KEK_prf`; the recovery hybrid pair and
   `hybridKeyBlob`; the ephemeral keys; `/open-recovery-case`. On 201 the
   recovery session is open and the page goes to `/recover/case`. The
   refusals shown: "a case is already open for this identity" (409), "no
   anoPod has that username", the passkey messages as on Create.

**My recovery** (`/recover/case`). The case id (short, with Copy), the
status in words ("Open: a moderator will contact you at <email> and meet
you on a video call", "In review", "Approved: the bankers are sending your
keys", "Delivering: n of 3 backup code shares received", "Completed",
"Dismissed: <reason in words>"), the timeline from the events the person
may see (scheduled with the meeting link as a link, approved, dismissed,
recovered, completed), a Refresh button (`/get-recovery-pod`; also polled
every 15 s while the page is open). "Keep this device: you unlock this case
with the passkey you just made."

When three shares of one backup code `keyId` are in, the finish appears as
a second stepper on the same page:

1. Combine: opens every share with the recovery hybrid private key, groups
   by `keyId`, combines each group of three; the backup code and the
   break-glass seeds are in RAM. Shows "backup code recovered" and "n
   break-glass seeds recovered".
2. Get back in: `KEK_backup` and the backup code keys from the code;
   `blob2` from the last `/get-recovery-pod` answer (masterpod 12.4.3 hands
   it over once the case is approved) opened with `KEK_backup` gives the
   encryption key; `newBlob1` = the encryption key under `KEK_prf`;
   `/challenge` (recover); the payload `{ challenge, caseId, newBlob1 }`
   signed with the backup code keys; `/recover-with-backup-code`. Then the
   ordinary unlock (`/challenge` unlock, the assertion, `/unlock`), which
   opens the normal session in this tab with the same passkey: `blob1`,
   the chat keys, the identity blob, the status.
3. Break-glass keys: `/list-anos-accounts`; for each recovered seed derive
   the two break-glass public keys and find the account whose
   `creation.payload.publicKeys` has them; `/store-break-glass-blob` with
   the seed under the encryption key. Shows which accounts got theirs and
   any seed that matched no account.
4. New backup code: a new code shown once as on Setup, with Complete;
   `newBlob2`, the new backup code keys, the proof by the old keys,
   `/rotate-backup-code`; then the deposit as `backupcode` through
   `SharesService.deposit`, a new `keyId`. "Your old backup code is now
   worthless."
5. Done: `/complete-recovery-case`; "You're back in." Continue to
   `/wallet`.

Each step keeps its result in RAM and can be retried; a refresh of the
page loses the combined code, and the person starts the finish again from
Combine after unlocking the recovery pod.

**Moderation** (`/moderation`). The cases from `/list-recovery-cases`, a
status filter (the four open statuses by default, plus completed and
dismissed), each row: username, names, status, approvals, opened. A row
opens `/moderation/:caseId`.

**Case** (`/moderation/:caseId`), from `/get-recovery-case`, refreshed by a
button and every 15 s

- The person: public selfie, username, names, the contact email with
  Copy, the lookup id with Copy, the status.
- The timeline: every event, the acting moderator's username, the details
  in words (a note shown as typed).
- Schedule: a date-time and a meeting link, Save (`/schedule-recovery-case`).
- Bucket one: a Pull key button. The moderator picks one of their anos
  accounts (the spending account that holds the stake; the keyholders
  refuse the others with `403 not a moderator`, shown as "this account
  holds no moderator stake"). The page makes a one-time hybrid pair, signs
  the account envelope for `/get-security-bucket-one-key` with pair one
  from the account's `keyBlob`, asks every keyholder in parallel, opens
  the shares with aad `lookupId || shareType || keyId`, groups by `keyId`
  and combines the newest group with at least `shareThreshold` shares.
  Then `/list-case-security-records` (bucket 1), decrypts the rows whose
  `keyId` matches and shows the images. `404 unknown lookup id` from the
  keyholders shows as "the keyholders know no identity with this lookup
  id". Bucket two: the same with `/get-security-bucket-two-key` and bucket
  2, images and texts, every key the keyholders answered.
- Sign off: the account picker, Approve or Reject, a note, Sign. The sign-
  off message of masterpod 12.6 signed by pair one,
  `/sign-off-recovery-case`. The page shows who has signed what.
- Dismiss: the preset reason, a note, Dismiss (`/dismiss-recovery-case`),
  behind a confirmation.
- Banker packet, shown when the status is approved or delivering: the
  lookup id, the URL and the hybrid key as JSON `{ "x25519": ..., "mlkem":
  ... }`, each with Copy and one Copy all, laid out as the bankers' GUI
  takes them. Shares received listed below it, by keyholder and type.

### 12.4 Services and state, new or changed

    recovery.service        the recovery session, apart from SessionService: caseId, the recovery session keys,
                            the PRF output and KEK_prf, the recovery hybrid private key, the last /get-recovery-pod
                            answer, the combined backup code and seeds while the finish runs; sign(path, body)
                            builds the recovery envelope (caseId as the signer); everything in RAM
    masterpod-api.service   one method per new route (masterpod 12.4); challenge() takes the three new purposes,
                            openCase with the username; listAnosAccounts items carry breakGlassBlob
    keyholder-api.service   getSecurityBucketOneKey(n, envelope), getSecurityBucketTwoKey(n, envelope): the
                            keyholder's moderator routes, the account envelope as the body
    crypto.service          generateHybridKeys(), wrapHybridPrivateKey / unwrapHybridPrivateKey (124-byte blob),
                            decryptFromHybrid (the mirror of encryptToHybrid: X25519 and ML-KEM-1024 decapsulation,
                            the same HKDF and aad), combineShares (shamir-secret-sharing combine), signSignOff
                            (pair one over the canonical sign-off), backupCodeProof (the backup code keys over a
                            canonical payload); everything else reused as it is
    config.service          edition in WalletConfig
    identity form           the nine-field form of the identity page becomes a component both the identity page
                            and the locked-out stepper use; the identity page's behaviour does not change
    shell                   Moderation in the navigation when edition is moderator and a session is open

### 12.5 Running it on this machine

    masterpod       npm run db:setup (the new tables and alters), restart; WEB_ORIGIN unchanged locally
    keyholders      RECOVERY_POD_HOSTS default (localhost) already covers the masterpod
    the proxy       npm run server as today; EDITION=moderator npm run server to work as a moderator
    pods            a person's pod with setup, both buckets and an anos account or two (its break-glass
                    seeds deposited); a moderator pod moderatorjoy vouched by the super seed, setup complete,
                    a spending account funded from another account and staked 1000 anos for moderator; a
                    second moderator pod for the second signature
    the bankers     the keyholder GUI on the Windows machine with the two YubiKeys, pointed at the banker
                    packet; the keyholders on this machine do the posting

The person's side is tested in a browser or profile that does not hold the
person's pod's passkey, or with that passkey given up (masterpod 12.6, last
paragraph).

### 12.6 Out of scope, not built

- Email or any message to the person; the app is the channel.
- Moving anos with the recovered break-glass keys.
- A moderator's history, several moderators on a call, a reject rule.
- Any change to the bankers' GUI; it takes the packet as it is.

### 12.7 Build notes

Filled in by each build chat, one subsection per build.

#### Build 1, the locked-out flow and the recovery pod (2026-10-26)

Built from `~/Desktop/Z/forclaude/build-1-case-and-recovery-pod.md`;
`ng build` clean. What this section left open and how it was decided:

- The identity form became
  `src/app/components/identity-form.component.ts`: the seven texts with
  Known / Unknown, the country select, the date picker and the guidance
  paragraph, rendering an `IdentityFormState` the page owns (signals for
  the answers, `complete`, `countryName`, `dateText`, `answers()`,
  `reset()`), so the answers survive a pane change on the identity page
  and its review pane reads them as before. The identity page keeps its
  why, review and action markup; nothing it does changed.
- `RecoveryService` (`services/recovery.service.ts`) holds the recovery
  session apart from `SessionService`: the case id, status, username,
  email and lookup id as signals, the last `/get-recovery-pod` answer, and
  in plain fields the session keys, the PRF output, `KEK_prf` and the
  hybrid private key; `sign(path, body)` builds the 12.4.1 envelope.
  `RECOVERY_POLL_MS` (15 s) lives there, not in `constants.ts`.
- `MasterpodApiService.challenge(purpose, username?)`; `openRecoveryCase`
  and `unlockRecoveryPod` take the self-signed envelope;
  `getRecoveryPod(envelope, quiet)` takes the recovery envelope from
  `RecoveryService.sign`, so the API service does not depend on the
  recovery service.
- `CryptoService` additions: `HybridKeys`, `generateHybridKeys`,
  `hybridKeysFromSecret`, `hybridPublicKeyOf`, `wrapHybridPrivateKey`,
  `unwrapHybridPrivateKey` (x25519 secret (32) || ml-kem seed (64) under
  `KEK_prf`, 124 bytes); nothing else touched.
- The locked-out stepper: step 1's Next computes the lookup id, drops the
  public ledger id and the answers (the identity page's rule), then
  advances; the linear stepper only moves once the step's `completed`
  binding has rendered, so the page waits for the next render
  (`afterNextRender`) before `stepper.next()`. Back to step 1 shows an
  empty form; Next then moves on with the computed id unless the form is
  filled in again. The recovery passkey is registered with the username
  as both name and display name (the person's names are not kept). The
  local assertion for the PRF output, when the registration returned
  none, is `PasskeyService.assert` with a random challenge; the platform's
  picker then shows every passkey of the site and the person picks the
  one just made.
- Refusals in words: `409` on open as "A case is already open for this
  identity", `404` from `/challenge` as "No anoPod has that username",
  `401 unknown passkey` on Continue as "This passkey belongs to no
  recovery case" with the hint that the person is not locked out on this
  device. The contact email is checked as the masterpod does (3 to 254
  characters, an `@` not first).
- My recovery: the status sentences of 12.3 ("Delivering: n of 3" counts
  the largest group of backupcode shares by `keyId`, the threshold from
  `/api/config`); the timeline shows `opened` as "Case opened" (the
  masterpod answers it), `scheduled` with the meeting link as a link,
  `approved`, `dismissed` with the preset reason in words, `recovered`,
  `completed`. The poll stops on completed and dismissed; a 401 says the
  recovery session has ended. The finish stepper's place is a comment in
  the template (build 3).
- Checked on the user's 4200 in the built-in browser: `/recover`;
  `/recover/open` with the form filled, the lookup id computed and the
  stepper advancing, the username lookup against the live masterpod
  ("quinnkoch found"), step 3 reached; `/recover/case` without a session
  goes to `/recover`. Opening a case needs the restarted masterpod and a
  passkey ceremony: the user's run-through, on a browser profile that does
  not hold the pod's passkey (masterpod 12.6, last paragraph).

#### Build 2, the moderator edition and the moderation pages (2026-10-26)

Built from `~/Desktop/Z/forclaude/build-2-moderation.md`; `ng build`
clean. What this section left open and how it was decided:

- `EDITION` is read by `server/config.js` through a `oneOf` helper:
  `wallet` or `moderator`, `wallet` by default, anything else refused at
  boot (`EDITION must be one of wallet, moderator, got "x"`); `server/app.js`
  answers it in `/api/config` as `edition`. `ConfigService` gets the
  `Edition` type, `edition` in `WalletConfig` and a `moderatorEdition`
  computed. A proxy started before this build answers no `edition`, which
  the app reads as the wallet edition.
- The shell: `Moderation` (icon `gavel`) after the status entries and
  before Notifications, when the edition is moderator and a session is
  open; the toolbar's brand reads "Moderator wallet" in that edition.
  Approved change 5 placed "the landing card's title" in the shell; the
  landing page's own card title ("Your anoPod") lives in
  `pages/landing.page.ts`, which is not on the approved list, and was
  left as it is.
- `moderation.guard.ts` (new, beside the two guards) needs a session and
  the moderator edition (`ConfigService.load()` awaited), else the
  landing page. Whether the pod is a moderator is the masterpod's call:
  its `403 not a moderator` shows as "This anoPod is not a moderator."
  on both pages.
- `MasterpodApiService`: the six methods and the shapes
  `RecoveryCaseItem`, `CaseEvent`, `CaseShare`, `BankerPacket`,
  `RecoveryCaseAnswer`, `SignOffBody`, `DISMISS_REASONS`;
  `listRecoveryCases(statuses?)` sends `{}` when no filter is given.
  `KeyholderApiService`: `getSecurityBucketOneKey` and
  `getSecurityBucketTwoKey` take the account envelope the page builds
  with `CryptoService.signAccountEnvelope` (pair one, a fresh nonce per
  keyholder). `CryptoService`: `decryptFromHybrid` (the mirror of
  `encryptToHybrid`, which build 3's share opening reuses),
  `combineShares` (shamir `combine`), `signSignOff` (pair one over the
  canonical `SignOffMessage`, as the account envelope is signed).
- Moderation (`pages/moderation.page.ts`): the six statuses in a
  multi-select, the four in-progress ones at first; each row the
  username, the names, the status in words, "n of 2 approvals" and when
  the case was opened, the case id under it; a row links to the case.
  The status words and icons are exported from there for the case page.
- Case (`pages/moderation-case.page.ts`): the person (selfie, username,
  names, the email and the lookup id with Copy, the status), the
  timeline in words with the acting moderator's username, a note on its
  own line and the meeting link as a link; Schedule with a
  `datetime-local` input turned into ISO 8601 and an https link checked
  before Save; one account picker, shared by the pulls and the sign-off,
  filled from `/list-anos-accounts` when the session holds no accounts
  yet, the first spending account picked; Bucket one and Bucket two,
  each with Pull key; Sign off (Approve or Reject, a note, Sign);
  Dismiss behind an inline confirmation (Dismiss, then Confirm dismissal
  or Cancel, with a warning line); the banker packet once the status is
  approved or delivering, the hybrid key as compact JSON
  `{"x25519":…,"mlkem":…}`, Copy on each of the three and Copy all as
  the JSON of `{ lookupId, url, hybridKey }`, the shares received listed
  below it by keyholder and type; Refresh and a quiet 15 s poll
  (`RECOVERY_POLL_MS`, shared with My recovery).
- The pull: every keyholder in parallel; it fails when more than
  `keyholders - shareThreshold` of them refuse, the first refusal in
  words (`403 not a moderator` as "This account holds no moderator
  stake", `404 unknown lookup id` as "The keyholders know no identity
  with this lookup id", `401 unknown account` as "not on the ledger
  yet"); a share that does not open with the response pair fails the
  pull naming the keyholder; the shares are grouped by `keyId`, the
  groups sorted by their newest `createdAt`; bucket one combines the
  newest group with at least `shareThreshold` shares, bucket two every
  such group; then `/list-case-security-records`, the rows whose `keyId`
  was combined decrypted (images as object URLs, full size in a new tab
  on click; texts as a list) and the others counted as "under other
  keys"; the response pair, the shares and the bucket keys are zeroed
  afterwards and a second pull revokes the first pull's URLs. The
  masterpod's viewed event is written by the listing call, whether or
  not a key was combined.
- The sign-off's and the dismissal's refusals in words: `409 already
  signed off`, `409 case closed`, `403 not your account`, `401 bad
  signature`; a `400` names the route and the reason.
- Checked with `ng build` (clean) and on the user's 4200 in the built-in
  browser: `/moderation` without a session lands on the landing page;
  the shell renders. The edition flag was checked on a throwaway proxy on
  port 4399: `EDITION=moderator` answers `"edition":"moderator"`, the
  default answers `wallet`, `EDITION=bogus` refuses to boot. The
  moderation pages themselves need a moderator session, the live
  keyholders and the validators' stake: the user's run-through (12.5).

#### Build 3, the recovery finish (2026-10-26)

Built from `~/Desktop/Z/forclaude/build-3-delivery-and-finish.md`;
`ng build` clean. What this section left open and how it was decided:

- `MasterpodApiService`: `recoverWithBackupCode(envelope)` (level none,
  the proof inside), `completeRecoveryCase(envelope)` (the recovery
  envelope from `RecoveryService.sign`), `rotateBackupCode(body)` and
  `storeBreakGlassBlob(accountId, blob)` (session), with the shapes
  `RecoverAnswer`, `RotationMessage` and `RotateBackupCodeBody`.
  `breakGlassBlob` is declared on `AnosAccountListItem`, which extends
  `AnosAccountItem` and is what `listAnosAccounts` now answers:
  `AnosAccountItem` itself lives in `session.service.ts`, which stays
  untouched, and a list item assigns to the session's `accounts` as
  before.
- `CryptoService`: `backupCodeProof(code, payload)` signs the canonical
  payload with the two keys the code derives (a private
  `backupCodeSigningKeys`, section 7's derivations with their private
  halves, built for one proof and dropped), as the session keys sign;
  `wrapBreakGlassSeed(seed, encryptionKey)`. `breakGlassKeys(seed)`
  already exposes the public halves (`publicKey` on each key), so no
  `breakGlassPublicKeysOf` was added. `decryptFromHybrid` and
  `combineShares` from build 2 are reused as they are.
- `RecoveryService` holds what Combine rebuilt in plain fields, dropped
  with the session: every rebuilt backup code candidate (newest key id
  first; one in practice) and the break-glass seeds, with a `hasCombined`
  signal.
- The finish stepper (`pages/recover-case.page.ts`): a second linear
  vertical stepper under the timeline, shown when the largest group of
  backupcode shares reaches `shareThreshold` (from `/api/config`, which
  the page now loads) and the status is approved or delivering, and kept
  once Combine ran in this page, so Done still shows after the status
  turns completed. Each step is a button; a failure shows above the
  stepper and the same button retries; completed steps are not editable.
  Combine opens every share with the hybrid private key, counts the ones
  that do not open, groups by `keyId`, combines each group with at least
  the threshold (the newest first by `receivedAt`), and refuses when no
  backup code came out. Get back in picks the candidate that opens
  `blob2` (so an older deposit's shares cost no round trip), wraps the
  encryption key under KEK_prf as `newBlob1`, runs the proof once (a
  retry after a cancelled passkey prompt only repeats the unlock), then
  `unlockWithPasskey` from `unlock.ts`, which opens the normal session in
  the tab. `401 bad signature` on the proof, and a code that opens no
  blob2, both say the person may have rotated already and is not locked
  out. Break-glass keys lists the accounts, matches each seed by the two
  derived public keys against `creation.payload.publicKeys`, stores the
  matched ones and reports the rest. New backup code is two buttons:
  Make a new backup code shows it once as on Setup; "I have written it
  down, complete" rotates first (the proof by the old code), then
  deposits through `SharesService.deposit`; a failed deposit leaves the
  rotation standing and the button reads Retry the deposit, depositing
  the same new code under a fresh key id (the opposite of Setup's
  fresh-secret retry, since the masterpod already holds the new code's
  keys). Done posts `/complete-recovery-case`; a `409` on a case that
  reads completed counts as done; Continue goes to `/wallet`.
- Checked with `ng build` (clean) and on the user's 4200 in the built-in
  browser: `/recover/case` without a session lands on `/recover`, no
  console errors. The stepper needs a case with three delivered shares
  and a passkey ceremony: the user's run-through (the plan's step 4).

## 13. The attestor edition

Design settled 2026-10-26 (`~/Desktop/Z/forclaude/attestor.md` records the
chat). The masterpod's part of this specification is
`~/Desktop/Z/masterpodsoftware/docs/schemas.md` section 13 (the tables,
the routes, the statuses and events, the client crypto in its 13.6), the
validators' part `~/Desktop/Z/anossoftware/docs/schemas.md` section 13
(the two reads), the keyholders' part
`~/Desktop/Z/keyholdersoftware/docs/schemas.md` section 13; this section
is the app's part. Three builds in three fresh chats, planned in
`~/Desktop/Z/forclaude/attestor-build-1-validators-and-keyholders.md`,
`attestor-build-2-masterpod.md` and `attestor-build-3-wallet.md`.

### 13.1 A third edition

`EDITION` (12.1) gains `attestor`: `wallet`, `moderator` or `attestor`,
`wallet` by default, anything else refused at boot. `ConfigService` gets
`attestorEdition` beside `moderatorEdition`.
`attestorwallet.masterpod.com` is a third proxy with `EDITION=attestor`
pointing at the same backends; the masterpod lists its origin in
`WEB_ORIGIN`. On this machine the user restarts the proxy with
`EDITION=attestor npm run server`.

What the edition changes: the navigation shows Attesting (13.3) when the
edition is attestor and a session is open; the toolbar's brand reads
"Attestor wallet". Nothing else. An attestor's pod is an ordinary pod
(username starting with `attestor`, vouched by a super seed, setup
complete, a spending account staked 1000 anos for attestor through the
account page's Send, as today). A pod is a moderator or an attestor by its
username, never both.

Every edition, the wallet included, gets Cases (13.3): the person's side
of a trade or dispute case. It shows in the navigation once setup is
complete.

### 13.2 Routes and guards

    /attesting                    the trades and the disputes waiting for attestors (attestor edition)
    /attesting/trade/:caseId      one trade case: the person, the trade, the buckets, the sign-off
    /attesting/dispute/:caseId    one dispute case: the parties, the escrow, the evidence, the verdicts
    /cases                        my cases (every edition)
    /cases/:caseId                one of my cases: share the lookup id, upload evidence, the timeline

The three Attesting pages need a session and the attestor edition
(`attestingGuard`, the shape of `moderationGuard`); a pod that is not an
attestor sees the masterpod's `403 not an attestor` as "This anoPod is not
an attestor". The two Cases pages need a session (`sessionGuard`).

### 13.3 The screens

**Attesting** (`/attesting`). Two tabs. The page asks the attestor for the
staked account once per session (13.4, `AttestingService`): the picker
the moderation case page has, filled from `/list-anos-accounts`, the first
spending account picked; the choice signs every validator read, keyholder
pull and sign-off until the tab closes.

The Trades tab: `/list-assisted-transfers` from the default validator,
each row the sender as a person (`/list-anos-account-profiles` once for
the whole list: selfie, username, names; an unknown account shows its id
and "not on this masterpod"), the amount in anos, when the trade was made,
and the case state from `/list-attestor-cases` matched by transaction id:
"No case yet" with an Open a case button, or the status in words (Open, In
review, Decided, Dismissed) linking to the case page, with "n of 2
sign-offs" and who opened it. The attestor ids already in the slots show
as "1 attestation on the validators" under the row. Open a case runs
`/open-trade-case` and goes to the case page.

The Disputes tab: `/list-disputed-escrows`, each row the seller and the
buyer as people, which of them disputed, the amount, when, the verdicts
already on the validators, and the case state as above. Open a case: the
page makes the case pair (`generateHybridKeys`), fetches
`/list-attestors`, wraps the 96 secret bytes to every attestor's chat
public key (`wrapCaseSecret`, the opener included), runs
`/open-dispute-case` with the public halves and the wraps, keeps the pair
in RAM (13.4) and goes to the case page. A status filter above both tabs
(the two review statuses by default, plus decided and dismissed) and a
Refresh; a quiet 15 s poll (`CASES_POLL_MS`).

**Trade case** (`/attesting/trade/:caseId`), from `/get-trade-case`,
refreshed by a button and every 15 s. Top to bottom:

- The person: public selfie, username, names, the status in words.
- The trade: the amount, the receiver's account id with Copy, when it was
  made (from the Trades list, cached in the service; the case answers the
  ids), the transaction id with Copy.
- The timeline: every event in words, the acting attestor's username, a
  note shown as typed, the meeting link as a link.
- Schedule: a date-time and an `https` meeting link, Save
  (`/schedule-attestor-case`).
- The lookup id: "Waiting for the person to share their lookup id" until
  the case answers one; then the id with Copy.
- Bucket one: Pull key, enabled once the lookup id is in. The moderation
  case page's pull, reused as it is: a one-time hybrid pair, the account
  envelope for `/get-security-bucket-one-key` signed by pair one of the
  staked account, every keyholder in parallel, the shares opened and
  combined, then `/list-trade-case-security-records` (bucket 1) and the
  rows whose `keyId` matches decrypted and shown. `403 not a moderator or
  attestor` shows as "This account holds no attestor stake". Bucket two
  the same with `/get-security-bucket-two-key` and bucket 2, images and
  texts.
- Attest: a note, Sign. The page builds the `attestation` follow-up as the
  account page does (`buildFollowUp` with the staked account's pair one,
  `attestorId` the account, `accountId` the sender, `transactionId` the
  trade's; the wallet pair from `/api/sign`), then
  `/sign-off-trade-case`. The page shows who has signed.
- When the answer says decided and no `sent` event exists: Send to the
  validators, which posts both stored attestations (from the
  `attestationSigned` events) to the default validator's `/attestation`
  one after the other, then `/mark-attestor-case-sent` with the answers.
  Shown as "Sent" with each answer, or Retry. The page of the attestor
  whose signature decided the case runs it at once, without the click.
- Dismiss: the preset reason, a note, Dismiss behind an inline
  confirmation (`/dismiss-attestor-case`).

**Dispute case** (`/attesting/dispute/:caseId`), from
`/get-dispute-case`, the same frame:

- The parties: the seller and the buyer, each with selfie, username and
  names, and which of them disputed; the status.
- The escrow: the amount (from the Disputes list, cached), the
  transaction id with Copy.
- The case key: when `myKey` is null, "You hold no key for this case; ask
  one of: <usernames of keyHolders>". When the attestor holds one, the
  page opens it with the session's chat keys (`unwrapCaseSecret`) and
  keeps the pair in RAM. Share the case key: a username picker over
  `/list-attestors` minus the holders, which wraps the secret to that
  pod's chat key and runs `/share-case-key`.
- The timeline, as the trade case.
- Evidence: two columns, the seller's and the buyer's. Each file opened
  with the case key (`decryptFromHybrid` on `keyForCase` with the case
  id as aad, then the file under the content key): images shown inline,
  full size in a new tab on click, PDFs as a link that opens in a new tab;
  who uploaded it and when. Without the key, the files are counted, not
  shown. After the decision, "the attestors' copies were deleted".
- Schedule, as the trade case.
- Verdict: Success or Cancel, a note, Sign. The `escrowVerdict` follow-up
  built as the account page does (`arbitratorId` the staked account),
  then `/sign-off-dispute-case`. The page shows each attestor's verdict.
- When decided: Send to the validators posts the two agreeing verdicts
  (from the `verdictSigned` events whose verdict is the decided one) to
  `/escrow-signature`, then `/mark-attestor-case-sent`; Retry on a
  refusal; the deciding attestor's page runs it at once.
- Dismiss, as the trade case.

The case pair, the opened evidence and the bucket keys live in RAM and are
zeroed when the page is left; a refresh fetches and opens them again.

**Cases** (`/cases`), every edition. `/list-my-cases`: the trades and the
disputes where this pod is a party, newest first, each row the kind, the
amount and the other account when the account page's transaction list
knows the transaction (otherwise the transaction id), the status in words
and when it was opened. A row opens `/cases/:caseId`. The notifications
page's labels for the five case kinds (13.4) link here.

**My case** (`/cases/:caseId`), from `/get-my-case`, refreshed by a button
and every 15 s. For a trade: "An attestor is checking your trade", the
status in words, the timeline the person may see (case opened, scheduled
with the meeting link, decided, dismissed with the reason in words, sent),
and Share my lookup id: one button, disabled once shared, which opens the
identity blob in session (`SessionService.getIdentity`) and runs
`/share-lookup-id`; "Nothing but the lookup id leaves this device". For a
dispute: the same frame with "Attestors are looking at this escrow", your
side (seller or buyer), and Evidence: a file input (images and PDFs,
several at once) with Upload, which for each file makes a content key,
encrypts the file under it, wraps the key under the pod's encryption key
(`keyForMe`) and to the case key (`keyForCase`, aad the case id), and runs
`/add-dispute-evidence`; the list of your files, each opened with
`keyForMe` and shown as on the attestor's page; and Supply again, offered
on a file of yours from another case (the Cases list of your own evidence
across cases comes from the other cases' `/get-my-case` answers, cached),
which wraps its content key to this case's key and posts it under
`existing`. After the decision: "The attestors' copies have been deleted;
your copies stay."

### 13.4 Services and state, new or changed

    attesting.service       the attestor's staked account for the session (accountId, its keyBlob opened per
                            signature as the account page does), the trade and dispute lists from the validator
                            with their profiles, the case pairs and opened content keys per case while a page is
                            open; everything in RAM
    masterpod-api.service   one method per route of masterpod 13.4 (eighteen) and their shapes; listAttestorCases
                            sends {} when no filter is given
    anos-api.service        listAssistedTransfers(pairOne, accountId), listDisputedEscrows(pairOne, accountId):
                            the account envelope of section 5.3, as getAccount builds it
    crypto.service          additions only: wrapCaseSecret(secret, chatP256PublicHex, chatKemPublicHex) and
                            unwrapCaseSecret(bytes, chat), the room key wrap of section 7 over the 96 secret
                            bytes (1725 bytes); newContentKey(); everything else reused as it is (encrypt,
                            decrypt, encryptToHybrid, decryptFromHybrid, generateHybridKeys,
                            hybridKeysFromSecret, buildFollowUp, signAccountEnvelope)
    config.service          attestorEdition in WalletConfig's edition
    notifications page      the five case kinds in words, each linking to /cases/:caseId by reference id
    constants               CASES_POLL_MS (15 s)
    shell                   Attesting in the navigation when the edition is attestor and a session is open;
                            Cases when setup is complete; the brand "Attestor wallet"

### 13.5 Running it on this machine

    validators      the two reads (anossoftware 13); the user's --watch validators pick them up
    keyholders      STAKE_MIN_ATTESTOR_ANOS in each .env-keyholderN (default 1000)
    masterpod       npm run db:setup (the five tables, the check), restart; WEB_ORIGIN unchanged locally
    the proxy       EDITION=attestor npm run server to work as an attestor
    pods            a person's pod with setup, both buckets and an assisted account that has sent an
                    assistedAnosTransfer; two pods with spending accounts for an escrow and a dispute; an
                    attestor pod attestorjoy vouched by the super seed, setup complete, a spending account
                    funded and staked 1000 anos for attestor; a second attestor pod for the second signature

### 13.6 Out of scope, not built

- Email or any message to the parties; the app is the channel.
- A party deleting their evidence; evidence beyond the four content types.
- Several validators asked at once; the lists come from the default
  validator, as every anos call does.
- A moderator who is also an attestor.

### 13.7 Build notes

Filled in by the build chat, one subsection per build.

#### Build 3, the wallet (2026-10-26)

Built straight through from `~/Desktop/Z/forclaude/attestor-build-3-wallet.md`;
`ng build` clean, no warnings (none before, none after). The approved
changes and nothing else: `server/config.js` (the `oneOf` list grows by
`attestor`), `config.service.ts` (`attestor` in `Edition`,
`attestorEdition`), the shell (`app.ts`, `app.html`), `app.routes.ts`,
`masterpod-api.service.ts`, `anos-api.service.ts`, `crypto.service.ts`
(additions only), `notifications.page.ts`, `constants.ts`
(`CASES_POLL_MS`, 15 s, shared by the Attesting lists, the two attestor
case pages and My case). New: `attesting.guard.ts`,
`services/attesting.service.ts`, `pages/attesting.page.ts`,
`pages/attesting-trade-case.page.ts`,
`pages/attesting-dispute-case.page.ts`, `pages/cases.page.ts`,
`pages/my-case.page.ts`. The moderation, recovery and account pages were
not touched: the account picker, the keyholder pull and the dismissal
confirmation are copied into the new pages. What this section left open
and how it was decided:

- The shell: Attesting (icon `fact_check`) sits beside Moderation, after
  the status entries and before Notifications; Cases (icon
  `folder_shared`) after Wallet in the setup-complete block; the brand
  reads "Attestor wallet" in the attestor edition, "Moderator wallet" in
  the moderator one. `attestingGuard` is `moderationGuard` with
  `attestor`; a session in another edition lands on the landing page.
- `MasterpodApiService`: the eighteen methods under three headings (the
  attestor reads, the attestor writes, the person's side) with the shapes
  `AttestorCaseStatus`, `AttestorItem`, `AccountProfileItem`,
  `PartyNames`, `TradeCaseItem`, `DisputeCaseItem`, `AttestorCasesAnswer`,
  `TradeCaseAnswer`, `DisputeEvidenceItem`, `DisputeCaseAnswer`,
  `CaseKeyWrap`, `OpenDisputeCaseBody`, `SentResult`,
  `ATTESTOR_DISMISS_REASONS` (six, beside the recovery's five),
  `MyTradeCase`, `MyDisputeCase`, `MyCasesAnswer`, `MyCaseEvent`,
  `MyEvidenceItem`, `MyCaseAnswer` (a union by `kind`), `EvidenceFile`,
  `ExistingEvidence`. The attestor events have the recovery events'
  shape, so `CaseEvent` is reused. `listAttestorCases(statuses?)` sends
  `{}` with no filter; `addDisputeEvidence` sends `files` and `existing`
  only when they have entries. `AnosApiService`: `listAssistedTransfers`
  and `listDisputedEscrows`, the account envelope as `getAccount` builds
  it, with `AssistedTransferItem`, `EscrowVerdictItem`,
  `DisputedEscrowItem`. `CryptoService`: `wrapCaseSecret` checks the 96
  bytes and runs `wrapRoomKey` over them (the same bytes on the wire,
  1725); `unwrapCaseSecret` mirrors `unwrapRoomKey` with the 1725-byte
  check and answers the 96 secret bytes, `hybridKeysFromSecret` makes the
  pair; `newContentKey`; two constants beside `HPKE_KEY_BYTES`.
- `AttestingService`: the staked `accountId` as a signal, `loadAccounts`
  and `pairOne` copied from the moderation case page, `loadLists` (both
  reads signed by pair one, then `/list-anos-account-profiles` for the
  ids not yet known, 200 per call, the profiles cached by account id for
  the session), `listedAt`, `tradeOf` / `disputeOf` / `profileOf`, the
  case pairs by case id (`setCasePair`, `getCasePair`, `dropCasePair`,
  which zeroes). An effect clears everything when the session closes
  (`SessionService.close` is not on the list). `attestingError` (`403 not
  an attestor` as "This anoPod is not an attestor.") and
  `validatorRefusal` (the validators' `403 not an attestor` as "This
  account holds no attestor stake on the validators.", `401 unknown
  account` as "not on the ledger yet") are exported from there.
- No note on Attest and on Verdict: the masterpod's `/sign-off-trade-case`
  and `/sign-off-dispute-case` bodies are `{ caseId, attestation }` and
  `{ caseId, verdict }` with no field for one (masterpod 13.4.4, as
  built), so the note of 13.3's "Attest: a note, Sign" has nowhere to go
  and the two forms are a button. The dismissal takes its note as before.
- Attesting: `/list-attestor-cases` is asked for all four statuses and the
  filter is applied on the page, so a decided case whose posting failed is
  never taken for "No case yet". A row's case is the best match by
  transaction id (a review case first, then a decided one, then a
  dismissed one, the newest of each); Open a case shows when there is no
  case or only a dismissed one; a row with no case counts as review work
  for the filter. The rows are plain blocks (a dispute row carries two
  people), not list items; an account the masterpod does not know shows
  its id and "not on this masterpod". The status words and icons and the
  dismiss words are exported from the page, as the moderation page does.
  Picking another account reads the lists again; the poll skips while the
  page is busy or opening a case. The open refusals in words: `409 case
  already open`, `409 not an assisted account`, `404 unknown (seller |
  buyer) account`.
- The dispute open: the case pair, `/list-attestors`, a wrap for every
  attestor that has chat keys (`/list-attestors` filters on setup
  complete, so all of them in practice; one without is skipped), refused
  when no wrap could be made; the pair goes to the service on `201` and is
  zeroed on any failure.
- The two case pages: the frame of the moderation case page copied. The
  trade's amount, receiver and date come from the service's cached list;
  when the case is not in it and an account is picked, the lists are read
  once quietly; otherwise "not on the validator's list" shows. The pull is
  the moderation page's, pointed at `/list-trade-case-security-records`,
  the keyholders' `403 not a moderator or attestor` read as "This account
  holds no attestor stake: the keyholders refused it", Pull key disabled
  until the lookup id is in. Send to the validators posts only the stored
  objects without an accepted (2xx) answer in any `sent` event, one after
  the other, then `/mark-attestor-case-sent` with every answer (a refusal
  with its reason cut to 500 characters); so a Retry never re-posts an
  object the validator already took, and "Sent" shows once every signer
  has a 2xx. The deciding attestor's page runs it right after the sign-off
  answer says `decided`. The last `sent` event's answers are listed under
  the button; the refusals of the attestor routes are in words (`409
  already signed off`, `409 case closed`, `409 case not decided`, `403 not
  your account`, `403 a party to the escrow`, `401 bad signature`, `400
  sign-off does not match the case`, `403 no key for this case`, `409 key
  already shared`, `400 not an attestor`).
- The dispute case: the pair from the service (the opener's) or from
  `myKey` with the session's chat keys; no chat keys in RAM, or a wrap
  that does not open, shows in words. The evidence rows are opened once
  (keyForCase under the pair with the case id's bytes as aad, the file
  under the content key, the content key zeroed at once) and kept as
  object URLs until the page is left; a row whose case-key copy is gone
  shows a delete icon, one without the pair a lock; nothing but the pair
  is kept between refreshes. `/list-attestors` is read once per page for
  the holders' usernames and the share picker, which lists the attestors
  that hold no key and have chat keys. The verdict form starts on
  success; the dismiss reason starts on `settled` for a dispute and
  `selfieMismatch` for a trade. Leaving the page revokes the URLs and
  drops the pair from the service.
- Cases: `/list-my-cases`, both lists merged newest first. The amount and
  the other account come from `/list-transactions` for each distinct
  account of the person on the cases (pair one from the keyBlob, quiet,
  the chain links and the pending row; an account not in the session or
  no encryption key in RAM knows nothing); a held trade or escrow is in
  neither until it lands, so the transaction id shows while a case is
  open. No poll (13.3 names none for Cases): Refresh.
- My case: the title by kind ("An attestor is checking your trade",
  "Attestors are looking at this escrow"), the status sentences, the
  person's timeline in words with the dismiss reasons as the person reads
  them. Share my lookup id is disabled once shared or once the case is
  final; without the identity in RAM it says to unlock again. The upload
  takes JPEG, PNG, WebP and PDF, at most 10 MB less 28 bytes each (the
  masterpod's `MAX_IMAGE_BYTES` on the ciphertext), five per request (its
  `MAX_IMAGES_PER_REQUEST`), several at once; the person's files are
  opened with keyForMe once and kept until the page is left. Supply again:
  while the case is in review, the person's other dispute cases are read
  once per page visit (`/list-my-cases`, then `/get-my-case` each) and
  their files shown with a Supply again button; the click opens keyForMe
  again, wraps the content key to this case's key and posts it under
  `existing`. Refusals in words: `409 lookup id already shared`, `409 case
  closed`, `404 unknown evidence`.
- Notifications: the five case kinds in words, each a link to
  `/cases/<referenceId>`; the other kinds stay text.
- Checked with `ng build` (clean) and on the user's 4200 in the built-in
  browser: the shell renders (the brand reads "anoPod wallet" because the
  user's proxy on 4300 predates the edition flag and answers none);
  `/attesting`, `/attesting/trade/:caseId`, `/cases` and `/cases/:caseId`
  without a session land on the landing page; no console errors; the
  served bundle carries the new routes. The edition flag on a throwaway
  proxy on port 4399: `EDITION=attestor` answers `"edition":"attestor"`,
  the default answers `wallet`, `EDITION=bogus` refuses to boot with
  `EDITION must be one of wallet, moderator, attestor, got "bogus"`. The
  attestor pages themselves need an attestor session, the live keyholders
  and the validators' stake; the Cases pages a person's session with a
  case: the user's run-through (13.5).
