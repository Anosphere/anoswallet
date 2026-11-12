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
    DEPOSIT_FLOOR_PERCENT  80    how many of the keyholders must store a share for a deposit to go through, in percent, 1 to 100 (section 6; 2026-11-07)
    DEFAULT_VALIDATOR   1                                                    until 2026-11-10 the validator the wallet posted to; it no longer picks the validator (below)
    DIST_DIR            dist/wallet/browser                                  the Angular build it serves
    RP_ID               localhost                                            the relying-party id the browser uses in both ceremonies; the masterpod's RP_ID
    GUARDED_LOCK_MINUTES  1    the validators' time lock on a guarded account, in minutes (a week, 10080, on the network since 2026-11-12; 10 on the testnet before that)
    VAULT_LOCK_MINUTES    2    the same on a vault account (30 days, 43200; 20 before)
    LOCK_OFFSET_MINUTES   1    how much more than its lock a guarded or vault transfer may be dated ahead (10; 5 before)

The three lock numbers are the validators' (anossoftware's
network/testnet.env); the wallet dates a guarded or vault transfer the
lock plus the offset ahead and a validator refuses one outside its
window, so the two files are changed together (2026-11-06, section 11).

DEFAULT_VALIDATOR no longer picks the validator (2026-11-10, section 11):
the browser picks one of the listed validators per session, at random,
and moves to the next one when it does not answer (8.3). The variable
stays, with its boot check that it is not larger than the list, and
/api/config still answers it as defaultValidator, for a tab that was
loaded before that change and still posts to it. The browser's code no
longer reads defaultValidator. Taking both out is a later clean-up.

Routes

    GET  /api/config                  200 { validators, keyholders, shareThreshold, depositFloorPercent, defaultValidator, edition,
                                      rpId, guardedLockMinutes, vaultLockMinutes, lockOffsetMinutes }: the two counts are the
                                      list lengths; the browser never sees an address; defaultValidator is DEFAULT_VALIDATOR,
                                      still answered and no longer read by the browser (2026-11-10, above)
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
  CORS rules see http://localhost:4200 as they do today. The one
  exception is the Connection header on a call to a validator, which
  the proxy sets to keep-alive (2026-11-11, the point on the
  connections below).
- The backend's status and body come back unchanged. A backend that does
  not answer: 502 { error: "<masterpod | validator n | keyholder n |
  signing server> unavailable" }. Proxy timeout 120 seconds.
- The connections to the validators stay open (2026-11-11, section 11).
  A call to a validator goes to its doorman on a connection that is
  open and waiting when there is one, so it does not open a connection
  and set up the encryption again. The proxy closes a connection that
  sat unused for 10 seconds (validatorIdleMs in server/config.js). The
  doormen close one after 15 seconds, so the proxy is always first and
  no call meets a closing connection. The proxy keeps at most 32 unused
  connections per validator (validatorIdleConnections), in each of its
  processes. That is no limit on the calls under way: a call that finds
  no waiting connection opens a new one. A new connection has the same
  10 seconds to open, so a validator whose machine cannot be reached is
  502 { error: "validator n unavailable" } after 10 seconds, where the
  call hung for the 120. A call that is under way still has the 120.
  For this the proxy sends "Connection: keep-alive" to a validator in
  place of the "close" that nginx in front of it sends with every call.
  The masterpod, the keyholders and the signing server get a new
  connection for every call, as before.
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

Since 2026-11-08 the answer also carries role, after isSuperSeed:
"moderator", "attestor", "validator", "masterPod" or null, the pod's live
appointment (masterpod spec section 16, forclaude/appointments-plan-1.md).
The names "validator" and "masterPod" came on 2026-11-10 (masterpod spec
16.7, forclaude/validator-masterpod-stake-plan-1.md): a pod appointed
for one of them may stake for it, and the appointment opens nothing
else. The account page's Stake for list reads the role (8.2). An older
masterpod sends no role field, and the wallet then shows daoVote and
guardian only (since 2026-11-10; until then it showed all six purposes).

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

Since 2026-11-10 the masterpod lets a pod make at most 20 new anos
accounts in the last 30 days: /create-anos-account counts the pod's rows
as its last check, after the 409, and at the limit answers 403 account
limit reached (masterpod spec section 17); the wallet says it in one
sentence and shows no counter (8.2, Wallet).

### 4.5 Applying it

db/schema.sql changes; locally `npm run db:reset` (the table changes
cannot be added by db:setup), then the genesis super seed again with
make-super-seed once the first pod exists. The README, docs/schemas.md
section 11 and the records change with the code.

### 4.6 noted_transactions

Added 2026-11-07 (forclaude/wallet-notes-plan-1.md; section 11): the
wallet's memory of what a transaction was for, on the masterpod under
the person's pod. One row per ledger transaction the person noted for
their tax records: the ledger's facts in the clear (the masterpod already
links a pod to its accounts and every validator holds the chain, so they
are no secret from a snooper, and in the clear they let the database
sort, cut a date range and refuse a double note) and the private part,
the kind, the money, the currency, the memo and a typed tag, as one blob
under the pod's encryption key (section 7), which the masterpod cannot
open. The masterpod learns which transactions were noted and nothing of
the money. One note per pod and transaction, enforced by the database; a
note's ledger facts never change once written, only its blob; the row is
deleted when the person removes the note. A feature folder
src/wallet-memory/ on the masterpod (router, handlers, service, the two
tables' queries), in the shape of src/anos-accounts/.

    CREATE TABLE IF NOT EXISTS noted_transactions (
      note_id          BYTEA       PRIMARY KEY CHECK (octet_length(note_id) = 32),
      anopod_id        BYTEA       NOT NULL CHECK (octet_length(anopod_id) = 32),
      transaction_id   BYTEA       NOT NULL CHECK (octet_length(transaction_id) = 32),
      account_id       BYTEA       NOT NULL CHECK (octet_length(account_id) = 32),
      other_account_id BYTEA       CHECK (octet_length(other_account_id) = 32),
      position         BIGINT      NOT NULL CHECK (position >= 0),
      transacted_at    TIMESTAMPTZ NOT NULL,
      amount           BIGINT      NOT NULL CHECK (amount >= 0),
      sent             BOOLEAN     NOT NULL,
      note_blob        BYTEA       NOT NULL CHECK (octet_length(note_blob) <= 4096),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (anopod_id, transaction_id)
    );
    CREATE INDEX IF NOT EXISTS noted_transactions_anopod_id_transacted_at_idx ON noted_transactions (anopod_id, transacted_at DESC);

note_id is random, minted by /add-noted-transaction; anopod_id the pod
that noted it; transaction_id the transaction's id on the validators;
account_id the pod's anos account the transaction belongs to (an
anos_accounts row of the pod's); other_account_id the other side as the
wallet shows it (the receiver when the pod sent, the sender when it
received), or null when there is none; position the transaction's
position on the ledger, as /list-transactions answers it; transacted_at
when the validators wrote it (createdAt); amount millionths of an anos,
as the ledger says it; sent true when the anos left the pod's account,
false when they came in or nothing moved; note_blob the ciphertext of the
private part (iv || ciphertext || tag), at most 4096 bytes, a few hundred
in practice; created_at and updated_at as every table, with the
set_updated_at trigger.

    POST /add-noted-transaction (setup)
    body { transactionId: hex, accountId: hex, otherAccountId: hex | null, position: integer, transactedAt: ISO 8601,
           amount: decimal string of millionths, sent: boolean, noteBlob: hex }
    checks, in order: the shape (400 bad request shape: the five strings, otherAccountId a string or null, position a
      number, sent a boolean); transactionId 32 bytes (400 invalid transactionId); accountId 32 bytes (400 invalid
      accountId); otherAccountId 32 bytes when not null (400 invalid otherAccountId); position an integer of 0 or more
      (400 invalid position); transactedAt parses (400 invalid transactedAt); amount digits only that fit a BIGINT (400
      invalid amount); noteBlob 1 to 4096 bytes (400 invalid noteBlob); an anos_accounts row with this accountId and
      this pod (403 not your account); no note of this pod for this transaction (409 already noted), the unique rule
      as the backstop (a unique violation on the insert answers the same 409)
    writes: INSERT noted_transactions with a fresh note_id
    answer: 201 { noteId }

    POST /update-noted-transaction (setup)
    body { noteId: hex, noteBlob: hex }
    checks: the shape (400 bad request shape); noteId 32 bytes (400 invalid noteId); noteBlob 1 to 4096 bytes (400
      invalid noteBlob); the row exists and is this pod's (404 note not found)
    writes: UPDATE note_blob; the ledger facts never change
    answer: 200 { noteId, updatedAt: ISO 8601 }

    POST /remove-noted-transaction (setup)
    body { noteId: hex }
    checks: the shape (400 bad request shape); noteId 32 bytes (400 invalid noteId); the row is this pod's (404 note not
      found)
    writes: DELETE the row
    answer: 200 { noteId, removed: true }

    POST /list-noted-transactions (setup)
    body { from?: ISO 8601, to?: ISO 8601 }, both optional; null counts as absent
    checks: the shape (400 bad request shape); from parses when given (400 invalid from); to parses when given (400
      invalid to)
    reads: the pod's rows with transacted_at at or after from and before to, newest transacted_at first, then the
      highest position, 1001 rows at most
    answer: 200 { notes: [ { noteId, transactionId, accountId, otherAccountId, position, transactedAt, amount, sent,
      noteBlob, createdAt, updatedAt } ], more: boolean }: the first 1000, and more true when a 1001st row exists

The proxy forwards them as any masterpod path (section 2): the wallet
posts to /api/masterpod/add-noted-transaction and signs
/add-noted-transaction. The wallet's side is notes.service (8.3) and the
note form on the transaction history page (8.2).

### 4.7 wallet_settings

Added 2026-11-07 (forclaude/wallet-notes-plan-1.md; section 11): one row
per pod, one encrypted JSON object holding the small things the wallet
should remember, the Protect your passkey answer first; a later thing is
one more field inside the object, with no masterpod change. Written whole
by /set-wallet-settings, which inserts the row or replaces its blob in
place; never deleted. The masterpod cannot open it.

    CREATE TABLE IF NOT EXISTS wallet_settings (
      anopod_id     BYTEA       PRIMARY KEY CHECK (octet_length(anopod_id) = 32),
      settings_blob BYTEA       NOT NULL CHECK (octet_length(settings_blob) <= 16384),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

anopod_id the pod; settings_blob the ciphertext of the settings object
(iv || ciphertext || tag), at most 16384 bytes, a few dozen in practice,
under the pod's encryption key (section 7); created_at and updated_at as
every table, with the set_updated_at trigger.

    POST /get-wallet-settings (setup)
    body { }
    answer: 200 { settingsBlob: hex | null, updatedAt: ISO 8601 | null }, null before the first set

    POST /set-wallet-settings (setup)
    body { settingsBlob: hex }
    checks: the shape (400 bad request shape); settingsBlob 1 to 16384 bytes (400 invalid settingsBlob)
    writes: INSERT or UPDATE the pod's one row, whole
    answer: 200 { updatedAt: ISO 8601 }

The proxy forwards them as any masterpod path (section 2). The wallet's
side is settings.service (8.3), the setup page's Continue and the Protect
your passkey page (8.2).

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

src/reads/ (router, handlers, service, queries), wired in app.js. All
five answer the signer's own account only; nothing about anyone else.
Since 2026-11-08 two public reads sit beside them, /list-fund-proposals
and /get-fund-proposal, the block at the end of this section.
The third, /list-escrows, was added 2026-11-05 for the escrow trades
(anossoftware spec section 16); the fourth, /get-assisted-transfer, on
2026-11-06 for the assisted transfer (anossoftware spec section 17); the
fifth, /get-locked-transfer, and the date range on /list-transactions on
2026-11-06 for the balances and the history (anossoftware spec section
18).

    POST /get-account (account)
    body { }
    answer: 200 { accountId, type, balance: millionths as a decimal string, latestTransactionId: hex | null,
      createdAt: ISO 8601, stakes: { daoVote, moderator, attestor, guardian, validator, masterPod },
      guardianVotes: number }. latestTransactionId is the transaction_id of the garlic_chain link with the
      highest position whose account_id is the signer: what the next transfer names as previousTransactionId.
    stakes and guardianVotes (2026-11-08, anossoftware spec 25.1): the account's stake per purpose, millionths
      as decimal strings, "0" each when the account has no stakes row, and floor(guardian / GUARDIAN_VOTE_ANOS)
      as a number, the account's guardian votes. A validator without the fund proposal reads sends neither;
      the wallet's AccountAnswer has both optional. The Guardians pages and Home's fund proposal line read
      guardianVotes. Since 2026-11-10 (section 11, forclaude/wallet-balance-card-plan-1.md) the balances
      service (8.3) reads stakes, for the balance card (8.2, Wallet): it keeps each account's purposes above
      zero and adds them up as Staked, which the card counts into Total, since a stake is a transfer to the
      fund and has left the balance. An answer without stakes counts as nothing staked.

    POST /list-transactions (account)
    body { beforePosition?: integer, limit?: integer (default 50, at most 200), from?: ISO 8601, to?: ISO 8601 }
    answer: 200 { transactions: [ { transactionId, position, type, accountId, accountIdTo, amount: string,
      createdAt } ], pending: [ { transactionId, type, accountId, accountIdTo, amount: string, createdAt,
      approved } ] }
    transactions: garlic_chain links where account_id or account_id_to is the signer, position descending,
      below beforePosition when given, with created_at at or after from and before to when given, limit rows;
      createdAt the row's created_at. pending: the signer's pending row (there is at most one), fields read
      from og_transaction.payload (transactionType, accountIdTo, amount or "0", createdAt). The other holding
      tables (locked, assisted, escrow, fund proposals) are not listed here; a guarded transfer shows up when
      it lands (section 10), the open escrows have /list-escrows and the locked transfer /get-locked-transfer.
    from and to (2026-11-06, anossoftware spec 18.3): either alone works; to is the first moment after the
      range, so the wallet sends the start of the day after the last day picked; beforePosition and limit work
      as before, within the range; pending is not cut. A value Date.parse does not accept is 400 invalid from
      or 400 invalid to.

    POST /list-escrows (account)
    body { }
    answer: 200 { escrows: [ { transactionId, accountId, accountIdTo, amount: string, createdAt,
      stage: waiting | held | releasing | cancelling | disputed, disputedBy: hex | null,
      verdicts: [ { verdict: success | cancel, approved } ] } ] }
    escrows: the escrow_transfers rows where account_id (the seller) or account_id_to (the buyer) is the
      signer, newest first, at most 200: the open trades only, nothing from logs (which may be purged) or
      archives. A released escrow is on the chain under the same id, so /list-transactions shows it to
      both sides for good; a cancelled one leaves no trace the wallet reads. stage is named by the
      validator from the row's columns (anossoftware spec 16.2): waiting until every validator accepted
      the trade (no follow-up is accepted on it yet); held when nothing is signed on it; releasing with
      the seller's success on it; cancelling with the buyer's cancel on it; disputed with a dispute on it,
      which only verdicts move. disputedBy is the signer of the dispute. verdicts carry what each verdict
      says and whether every validator accepted it, never the attestor's id.

    POST /get-assisted-transfer (account)
    body { }
    answer: 200 { transfer: { transactionId, type, accountId, accountIdTo, amount: string, createdAt,
      stage: waiting | attesting | locked | writing | cancelling, attestations: 0 | 1 | 2,
      unlocksAt: ISO 8601 | null } | null }
    transfer: the assisted_transfers row whose account_id is the signer, or null when there is none. There is
      at most one: account_id is unique there, and the validator holds one transaction per account. The
      sender's only: the receiver can do nothing with the transfer and sees it in the history when it lands.
      The held transfer only, nothing from logs or archives: a written transfer is on the chain under the
      same id, so /list-transactions shows it for good; a cancelled one leaves no trace the wallet reads.
      stage is named by the validator from the row's columns (anossoftware spec 17.2): waiting until every
      validator accepted the transfer (no follow-up is accepted on it yet); cancelling with the sender's
      cancel on it; writing with both attestations approved, until the next round writes it (the sender may
      still cancel); attesting otherwise, accepted and waiting for two approved attestations. attestations
      counts the attestation slots holding one; the two reach the validator together, posted by the
      deciding attestor's app, so it is nearly always 0 or 2. Since 2026-11-08 (anossoftware spec 22) the
      row may be a breakGlassTransfer, the recovery finish's move out of a lost account (12.3): unlocksAt is
      then the moment a move out of a guarded or vault account may be written (null for every other row),
      and a fifth stage, locked, is both attestations approved with that moment ahead; the wallet reads it
      "Locked until <date>" (assistedStages.locked).
    type (answered by the validator since 2026-11-08, read by the wallet since 2026-11-10,
      forclaude/recovery-finish-order-plan-1.md): the row's transactionType, assistedAnosTransfer or
      breakGlassTransfer. Since 2026-11-10 this read is also made with the break-glass pair, by the recovery's
      finish (12.3, Move your money): the envelope is signed by a lost account's break-glass pair, which the
      account level accepts as it does on /get-account (anossoftware spec 22). A breakGlassTransfer in the
      answer is a move the validators already hold for that account, and its transactionId and accountIdTo
      are what the finish files with the masterpod. Every other read of it is signed by pair one.

    POST /get-locked-transfer (account)
    body { }
    answer: 200 { transfer: { transactionId, accountId, accountIdTo, amount: string, createdAt,
      unlocksAt: ISO 8601, stage: waiting | locked | due | cancelling } | null }
    transfer: the locked_transactions row whose account_id is the signer, a guarded or vault transfer waiting
      out its time lock, or null when there is none (2026-11-06, anossoftware spec section 18). There is at
      most one: account_id is unique there, and the validator holds one transaction per account. The sender's
      only: the receiver sees it in the history when it lands. The held transfer only, nothing from logs or
      archives: a written transfer is on the chain under the same id, and the row is deleted when written.
      Since 2026-11-11 the sender can cancel a locked transfer until it is written, with the follow-up
      lockedTransferCancel at POST /locked-transfer-cancel (anossoftware spec section 28; 8.2, Account). A
      cancelled transfer's row moves to the validator's logs, and this read then answers null: a cancelled
      transfer leaves no trace the wallet reads. Until that day nothing could be done with a locked
      transfer, since no follow-up existed for it. unlocksAt is the row's
      future_date, the moment the transfer may be written. stage is named by the validator from the row by the
      database's clock, the one the ready list reads (anossoftware spec 18.2): waiting until every validator
      accepted the transfer; cancelling (2026-11-11) with the sender's cancel on it, which the validator
      decides right after waiting, until every validator accepted the cancel and the row is gone; locked
      while the unlock moment is ahead; due once it has passed, until the next
      leader round writes it (a round starts with the next transaction of any kind).

Refusals are 400 or 401 + { error }, logged "failed: <reason>" like
every other route. The 1 MB JSON limit stays.

The public reads (2026-11-08; anossoftware spec 25, the plan
forclaude/wallet-guardians-plan-1.md): no envelope, no signature, the body
a plain JSON object (400 bad request shape otherwise), built like
/list-dao-stakes (anossoftware 23); the doorman passes them at 4 KB with
the object check (doormansoftware spec 7), the fields are the validator's.
Everything they answer is the fund's business: a written proposal's
payouts are on the public chain, and the votes are the guardians' public
act on the fund's money. A validator or a doorman without them answers
404, which the wallet shows in red under the tab of the Guardians page
while everything else works, so the validators and their doormen deploy
first.

    POST /list-fund-proposals (public)
    body { status: 'open' | 'decided', limit?: integer (default 20, at most 200), offset?: integer, from?: ISO 8601, to?: ISO 8601 }
    answer: 200 { settings, proposals: [ item ] }
    settings: { anosPerVote, minimumStake, percent, minutes }, the validator's GUARDIAN_VOTE_ANOS and
      STAKE_MIN_GUARDIAN_ANOS as millionths (decimal strings) and GUARDIAN_VOTE_PERCENT and GUARDIAN_VOTE_MINUTES
      as numbers, with every answer, so the wallet's notice, its rule and its become-a-guardian sentence carry
      the validator's own numbers.
    item: { transactionId, guardianId (the proposer's account), createdAt, voteClosesAt, status, approved,
      payoutCount, total: millionths as a decimal string, forWeight (the proposer's weight plus the approved
      votes for), againstWeight (the approved votes against), passing, decidedAt: ISO 8601 | null,
      votes: [ { guardianId, vote: for | against, weight, approved, votedAt } ] } (anossoftware 25.1).
    status (anossoftware 25.2): waiting until every validator accepted the proposal (no vote is accepted on it
      yet); open while voteClosesAt is ahead; closing once it has passed and the next ready list has not tallied
      it yet; written for an archived proposal that passed and whose payouts the round wrote; failed for one that
      did not. A word the wallet does not know is shown as it is, with no button.
    open lists the fund_proposals rows, one at most (limit, offset, from and to are not read); decided lists the
      archives rows of fund proposals, newest first by the decision, after offset rows, with the decision at or
      after from and before to when given (to is the first moment after the range, as /list-transactions takes
      them). 400 invalid status / invalid limit / invalid offset / invalid from / invalid to.

    POST /get-fund-proposal (public)
    body { transactionId: hex }
    answer: 200 { settings, proposal }, the item plus proposerWeight (the proposer's votes when the proposal was
      stored) and payouts: [ { index, accountIdTo, amount, reason, stakeFor: purpose | null } ] in index order,
      the fields as the proposer sent them; the open row first, then the archives. 400 invalid transactionId
      for anything but 64 hex characters; 404 unknown proposal.

## 6. The keyholders

Since 2026-11-08 the wallet also asks every keyholder `/get-owner` (level
none, keyholder spec section 15) who owns a lookup id, all at once with
the deposit's 15 second limit, found when any answers: the locked-out
stepper's step 1 (12.3), `SharesService.findOwner`. Before that, nothing
here changed keyholdersoftware. What the wallet sends them in a deposit is
what the keyholder test app sends, with the stand-ins replaced:

- publicLedgerId: the real PLID, 32 bytes (docs/public-ledger-id.md).
- lookupId: the real rule, section 6 there.
- shareType: backupcode at setup, securitybucket1 and securitybucket2 at
  each bucket add, and breakglasskey at each anos account creation, the
  type nothing sent before.
- keyId: 32 random bytes per secret, the same on every keyholder, and
  (new) the same value the masterpod gets with the bucket add.

The deposit rule, everywhere a secret is made (as changed 2026-11-07 by
forclaude/wallet-deposit-floor-plan-1.md; before it every keyholder had
to answer 201, one at a time, in order)
1. The secret is split into as many shares as /api/config says
   keyholders, threshold shareThreshold, with shamir-secret-sharing as
   today. Shares and threshold are separate numbers: 27 keyholders get
   exactly 27 shares, nothing is computed and thrown away.
2. Share n goes to keyholder n through /api/keyholder/n/receive-share,
   the receiving key fetched through /api/keyholder/n/get-keyholder-public-key
   once per session, every keyholder at once, each call with a time limit
   of 15 seconds (KEYHOLDER_DEPOSIT_TIMEOUT_MS in constants.ts): a
   keyholder that has not answered by then counts as one that did not
   store the share, so a stopped VM holds nobody for the proxy's two
   minutes.
3. The deposit goes through when at least the floor stored it:
   depositFloorPercent of the keyholders, rounded up, never below
   shareThreshold (22 of 27 at 80 percent; every keyholder when the proxy
   sends no percent). The masterpod step that follows (complete-setup,
   the bucket add, create-anos-account) then runs; the keyholders that
   failed show only in the activity log. Below the floor the step stops:
   the screen says how many stored, how many were needed and the first
   failure ("Only 20 of 27 keyholders stored the share, 22 are needed.
   Keyholder 12: HTTP 0: no answer in 15 s"), and Retry starts the step
   again with a fresh secret and a fresh keyId. The shares already stored
   are orphans under a keyId nothing names; reads list newest first, so
   they never get in the way.
4. So "stored on the masterpod" means "enough keyholders have it". A
   keyholder that was down misses that share for good; the secret still
   rebuilds from any shareThreshold of the others, and the reads already
   tolerate a missing share (a pull needs the threshold, not everyone).
   A catch-up that hands a keyholder the shares it missed is not built
   (the plan's decision 1). No temporary table, no state column.

## 7. Client crypto, new or changed

Everything the three test apps compute stays as the records say
(masterpod rules/client_crypto.md, keyholder rules/client_crypto.md, anos
flows/how_a_wallet_builds_a_transaction.md). New or changed:

    PLID, lookupId      docs/public-ledger-id.md; scrypt from @noble/hashes/scrypt, SHA-256 from @noble/hashes
    identityBlob        AES-256-GCM under the encryption key of PLID (32) || lookupId (32): iv || ciphertext || tag, 92 bytes
    break-glass seed    32 random bytes per anos account. breakGlassKey: P-256 scalar = HKDF(seed, "anos/break-glass-p256/v1", 48)
                        as an integer mod (n - 1), plus 1, the backup code's rule; breakGlassPostQuantumKey: ML-DSA-87
                        keygen(HKDF(seed, "anos/break-glass-mldsa/v1", 32)). HKDF-SHA-256, empty salt. The seed is
                        split and deposited as breakglasskey, then wiped; it is never sent to the masterpod. At a
                        recovery's finish the recovered seed signs the account's break-glass move (step 5 of
                        forclaude/break-glass-plan-1.md) and is wiped again; nothing of it is stored on the
                        masterpod (2026-11-08; from 2026-10-26 to then the finish stored it as breakGlassBlob).
    keyBlob             AES-256-GCM under the key blob key of key1 scalar (32) || postQuantumKey1 seed (32) ||
                        key2 scalar (32) || postQuantumKey2 seed (32), 156 bytes. The key blob key (2026-11-08,
                        forclaude/break-glass-plan-1.md) = HKDF(PRF output, "masterpod/kek-keys/v1", 32): from the
                        passkey's PRF output alone, a sibling of KEK_prf, derived at every unlock and create and
                        kept in RAM with the PRF output (session.service); not the encryption key, which the backup
                        code also opens, so a backup-code recovery returns the pod and not the signing keys, and a
                        lost passkey loses the key blobs for good (the wallet shows such an account as lost, 8.2).
                        ML-DSA-87 keys come back from their seeds (the test wallet's generateMlDsaKey(seed)), P-256
                        public keys from the scalars. Opened only to sign, then dropped; the ciphertext stays in
                        RAM for the session. Before 2026-11-08 the blob was under the encryption key.
    the wallet pair     fetched once per session from /api/sign/public-keys; a creation payload carries them as
                        walletKey and walletPostQuantumKey; the browser makes the other six signatures and
                        /api/sign adds the two. Every transfer, fund proposal and follow-up is signed by pair one
                        in the browser and by the wallet pair through /api/sign, then posted to the validator.
    the account envelope for reads
                        { payload: { accountId, path, timestamp, nonce, body }, signatures: { ecdsa, mldsa } }:
                        the pod envelope with accountId as the signer field, signed by pair one (P-256 r||s over
                        the SHA-256 of the canonical bytes, ML-DSA-87 over the bytes), nonce 16 random bytes.
    the bucket keyId    sent with the add as well as in the deposits.
    the backup code     never shown (2026-11-10, section 11): made at Setup, wrapped as blob2 and deposited with the
                        keyholders as backupcode, all without the person seeing it or writing it down; it is the
                        secret the long recovery rebuilds from the bankers' shares. Until 2026-11-10 it was shown
                        once as base32 in groups of four, with a Complete button.
    the wallet pair of the test wallet
                        wallet-keys.ts is not carried over.
    noteBlob (2026-11-07)
                        AES-256-GCM under the encryption key of the UTF-8 JSON { v: 1, kind, money, currency, memo, tag }:
                        a few hundred bytes; wrapJson / unwrapJson (crypto.service)
    settingsBlob (2026-11-07)
                        the same of { v: 1, protect }

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
    /account                 your account: Recovery selfie and Recovery details, with what is on file
    /account/recovery/selfie    the account recovery walkthrough, opened at the selfie
    /account/recovery/details   the walkthrough opened at the ID
    /account/protect         the Protect your passkey page: the setup pane again, Save records the answer
    /security/bucket-one     forwards to /account/recovery/selfie
    /security/bucket-two     forwards to /account/recovery/details
    /home                    home: the greeting, the balance card, things to do, the tiles
    /wallet                  the anos accounts and Create anos account
    /wallet/:accountId       one account: balance, send, pending, escrow trades, the held or locked transfer
    /wallet/:accountId/escrow/:transactionId   one escrow trade: the details, the buttons for your side, the closed view
    /wallet/:accountId/assisted/:transactionId   one assisted transfer: the details, the stage, the case, Cancel transfer, the closed view
    /wallet/:accountId/history   the transaction history: the rows in plain words by day, a date range, Show more
    /wallet/notes            the noted transactions: every account's notes, a date range, the kind chips, the totals, Download as CSV
    /chat                    the list of chats; on a desktop the pane beside it shows the child route
    /chat/requests           invites to me and join requests on my rooms
    /chat/new                start a chat: Message someone, New public room, Find public rooms
    /chat/:chatRoomId        one conversation
    /marketplace             browse: the filter chips, the Your listings row, the cards
    /marketplace/new         a new listing
    /marketplace/mine        your listings, open first, with who connected and Close
    /marketplace/:listingId  one listing: the details, the owner, Connect / Waiting / Open chat; the owner's view
    /dao                     DAO: the notice, three tabs (Open votes, Pending, Decided), the cards, New proposal
    /dao/new                 a new proposal: the title, the text, Post
    /dao/:proposalId         one proposal: the status, the title and the text, the proposer, the numbers, your support or vote with a confirm in place, the votes and the supporters
    /dao/guardians           Guardians: the notice, your guardian accounts, two tabs (Open vote, Decided), the cards, New proposal
    /dao/guardians/new       a new fund proposal: the account that proposes, the payouts, Post
    /dao/guardians/:transactionId   one fund proposal: the status, the payouts, the numbers, Voting as and your vote with a confirm in place, the votes
    /notifications           the list, mark read
    /seed                    the vouch request inbox (seeds only)
    /log                     the activity log, newest 40 calls, polls excepted (the test apps' Log)

In app.routes.ts the three Guardians routes (2026-11-08, section 11; the
plan is forclaude/wallet-guardians-plan-1.md) sit between dao/new and
dao/:proposalId: the router takes the first route that matches, and
dao/:proposalId would otherwise swallow dao/guardians. The Guardians have
no entry of their own in the side panel or the Home tiles: the DAO page
carries a card to them (8.2).

The route of the person's recovery case, cases/recovery/:caseId
(2026-11-12, section 11; the plan is
forclaude/wallet-case-chats-plan-1.md), sits in front of cases/:caseId
in app.routes.ts, the more specific path first. The Cases routes are not
in the list above: they are in 13.2, and this one is there with them.

A guard sends anyone without a session to /. Which pages the navigation
shows follows the status: vouching until vouched; identity and setup
until setup is complete; home first, then wallet, chat, marketplace, DAO
(2026-11-08) and account once it is (2026-11-06, section 11); seed when
isSeed. The Chat entry carries the number of unread rooms (8.2, Chat;
2026-11-05, section 11) and the Notifications entry the number of unread
notifications (2026-11-06); the side panel and the Home tiles draw one
list, navigation.service (8.3). The toolbar's "anoPod wallet" is a link
to /home once setup is complete.

Two more entries carry a number since 2026-11-12 (section 11; the plan
is forclaude/wallet-case-chats-plan-1.md, its decisions 15 and 25): the
Moderation entry of the moderator edition (12.3) and the Attesting entry
of the attestor edition (13.3). The number is how many things on that
page this device has not seen yet, as the Chat entry counts its unread
rooms. A thing on the Attesting page is a row of its three lists: an
assisted transfer the validators hold, a disputed escrow the validators
hold, a recovery case that is open or in review. A thing on the
Moderation page is a recovery case that is open or in review. The wallet
reads those lists every 15 seconds, in that edition only, and the number
clears when the page is opened (work-badge.service, 8.3). It shows at
the right of the entry in the side panel and on the entry's Home tile,
since both draw the one list.

The next-step rule, applied after an unlock and after each step
finishes:

    not vouched                                   /vouching
    vouched, setup not complete                   /identity
    setup complete, bucketOneImages = 0           /account/recovery/selfie
    bucketTwoImages = 0 or bucketTwoInfos < 3     /account/recovery/details
    otherwise                                     /wallet

After an unlock, Wallet reads Home: the landing page sends a pod whose
next step is /wallet to /home, while the setup steps (the recovery
walkthrough's "Go to wallet") still end at Wallet, the next thing to do
(2026-11-06, section 11).

The user may navigate anywhere the navigation shows at any time.

The toolbar's words and the navigation's labels come from the
dictionary and follow the language (8.8; 2026-11-06, section 11).

### 8.2 The screens

Landing. Above the card, in every edition, the test-site notice: a wide
red-tinted box (the theme's error-container colours) with a warning
icon, "This is just a test site." in large bold letters, then "There are
no real Anos here, do not pay money to anyone in order to buy Anos. This
is for testing purposes only.", then the same in Thai. Then the card.
The headline follows the language; under the card, while the app is in
Thai, the button "Switch to English" (8.8). Unlock: /challenge (unlock),
the passkey assertion with the PRF salt, /unlock; opens blob1,
chatPrivateKeyBlob and identityBlob; then /check-anopod-status and the
next-step rule. The platform's passkey picker is what says whether a
passkey exists; with none, the authenticator's own message shows and
the page suggests Create. Create goes to /create, Recover to /recover.

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

Vouching. Title "Get vouched". Until vouched: the subtitle "Someone who
already has an anoPod confirms they know you."; the status line
(vouchCount) refreshed by the notification poll (every 5 s, as today);
the instructions in three parts, "How vouching works" (every anoPod is
vouched for by a real person who already has one; two vouches from seeds
or one from a super seed, which also makes the pod a seed), "What to do"
(ask a couple of people in the anoSphere for their username, search each
one, check the photo and the tag, Send request) and "While you wait" (the
page changes by itself, Unlock brings the pod back here until vouched, a
decline shows under Notifications); then a username search
(/search-usernames) showing the profile card with the selfie and the seed
flags, a Send request button (/send-vouch-request), and the requests sent
this session. Once vouched, all of that is gone and the card shows only a
big "You've been vouched", "N people vouched for you. You can continue to
the next step." (1 person when it is one) and a big Continue to
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

Setup. A Start button. In order: generate the encryption key, the backup
code, the backup code keys, the chat pair, blob1, blob2,
chatPrivateKeyBlob, identityBlob (if the PRF output is not in RAM, an
unlock first). Five of the eight show as a progress list; the backup
code, its keys and blob2 have no line (2026-11-10, section 11). Then,
with no stop in between: deposit the backup code (section 6,
backupcode), then /complete-setup with the eight fields; on 200 drop the
code and go on by the next-step rule. The backup code is never shown:
until 2026-11-10 the page showed it once in groups of four with "I have
written it down, complete" and waited for that button. On an Android phone
(the browser's user agent string says Android; 2026-11-07, section 11)
the page does not leave yet: once /complete-setup has answered, the card
shows "Protect your passkey" in place of the progress list: "Strongly
recommended." in bold, then "It is free, it takes a few minutes, and it
makes your anoPod much harder to steal."; the why, "On an Android phone
your passkey is usually kept by Google, under your Google account. If
someone takes over that Google account, your passkey is within their
reach."; what it does, "Google's Advanced Protection makes that takeover
very hard: signing in to Google needs your passkey or a security key,
account recovery is slow and strict, and most outside apps are kept
out."; the caution, "It changes how you sign in to Google, and a few
apps that use your Google account may stop working. Google's page
explains it before you turn it on."; the button "Open Google's Advanced
Protection", which opens https://landing.google.com/advancedprotection/
in a new tab; "Then choose one:" over two radio choices, "I turned it
on" and "Skip for now"; and Continue, off until one is picked, which
goes on by the next-step rule. The answer is recorded in the wallet
settings on the masterpod (4.7; 2026-11-07, section 11), 'on' or
'skipped'; the wallet cannot check what the person did; the pane shows
once, at setup, and never on an iPhone or a computer. Google's Advanced
Protection for the Google account is meant, not Android 16's device
setting of the same name. A /complete-setup refused with 409 leaves at
once, as before, without the pane. A failed deposit shows Retry (section
6, step 3). A /complete-setup refused with 409 setup already complete
means a dropped answer earlier: /check-anopod-status, and if setup is
complete, carry on.

Account recovery, one linear Material stepper, at
/account/recovery/selfie (opened at step 1) and /account/recovery/details
(opened at step 2). Titled "Account recovery", with "Everything here is
encrypted on your phone before it is sent. Nobody at anoPod can read it."
above the steps. It replaced the two bucket pages on 2026-11-05 (section
11); the server calls are the same.
1. Selfie. "Take a selfie." and a "Why do we need this?" button that
   opens the longer text (what a moderator compares it with, the key only
   the keyholders can rebuild, up to five, one is enough). The camera
   component in high quality, front camera, up to five, preview and
   remove. Next runs bucket one's flow: a fresh bucket key and keyId;
   each image encrypted under the key; the deposits (securitybucket1);
   /add-to-security-bucket-one with keyId and the images; on 201 the key
   is dropped, the status re-read, and the stepper moves on. With a
   selfie already on file and none pending, Next just moves on.
2. ID. The reminder "The more you add here, the easier it will be to
   recover your account if you are ever locked out." Then "Now a photo of
   your ID. The best ones show your photo and your full name, like a
   driver's license, a national or state ID card, or a passport. Lay it
   flat on a table and fill the frame. Things that do not prove who you
   are, like a bus pass, do not help." The camera component in normal
   quality, back camera, preview and remove. No Back here, the selfie is
   sent.
3. Email. "An email address where you can be reached if you are locked
   out of your account."
4. Phone. "A phone number where you can be reached."
5. Friend or family. Their name and their phone number, both or neither;
   "A moderator may phone them to check that it is really you. Someone
   like a spouse, or someone who lives with you, is best."
6. Bank account, optional, with Skip. Bank, name on the account, account
   number, all three or skip. "A bank account in your name is strong
   proof. In a recovery a moderator can send two small deposits and ask
   you the amounts. The name on the account should match the name on
   your ID." and "This is encrypted on your phone. Nobody at anoPod can
   read it. It is only opened in a recovery you ask for."
7. Anything else, optional. The camera again, back camera (the ID photos
   and these share the five per visit), free lines one per line, and the
   reminder once more. Finish runs bucket two's flow with everything
   gathered: the photos, and one info entry per piece, "phone: ...",
   "email: ...", "contact: name, phone", "bank: bank, name, number", then
   each extra line; the deposits (securitybucket2);
   /add-to-security-bucket-two; on 201 the key is dropped and the status
   re-read.
Then the done view: "Done. On file for a recovery: 1 selfie, 2 photos
and 4 details." (the status counts), "You can add more any time under
Account." and Go to wallet, by the next-step rule.

On a first visit, until the details are on file (an image and three
infos, the next-step rule's line), steps 2 to 5 are required: each Next
waits for its piece, and Finish for all four. After that every step is
optional, Finish needs at least one new thing, and with nothing new it
reads Done and shows the done view without a call. Nothing leaves the
phone before Next on the selfie and Finish at the end, so Back costs
nothing; each send makes one key with the keyholders, which is why the
details go in one batch. A failed deposit or call shows the error and
Retry, which starts that send again with a fresh key.

Account. "Your account", at /account, in the navigation once setup is
complete, after Marketplace. Two rows, Recovery selfie and Recovery
details, opening the walkthrough at step 1 or step 2, each with what the
status counts on file ("1 selfie on file", "2 photos and 4 details on
file", "None on file yet"). The status only counts, since everything is
encrypted, so the rows say how many, never which.

Protect your passkey (2026-11-07, section 11), at /account/protect,
reached from Home's Things to do on an Android phone while the recorded
answer is skipped: the setup pane again, titled "Protect your passkey",
Back to Home, then the pane's lines from `common` ("Strongly
recommended." in bold with the benefits, the why, what it does, the
caution, the button "Open Google's Advanced Protection" to Google's page
in a new tab, "Then choose one:" over "I turned it on" and "Skip for
now") and Save, off until one is picked, which records the answer in the
wallet settings (4.7, settings.service) as 'on' or 'skipped' and goes to
Home; a refusal in red. No row under Account.

Home (2026-11-06, section 11), at /home, where an unlock lands once
setup is complete, first in the navigation; no outer card. Top to
bottom: the greeting, the person's avatar (8.6, 56 px) and "Hello,
Somchai" (the first name, the username when it is empty); the balance
card of the Wallet paragraph below, the same component, with its rows
and the sheets they open (2026-11-10, section 11); "Things to do",
a short list of links, the heading and the list hidden when none
applies, in this order, each only when it applies: "Add a recovery
selfie" (bucketOneImages 0, to /account/recovery/selfie); "Add your
recovery details" (bucketTwoImages 0 or bucketTwoInfos under 3, to
/account/recovery/details); "Protect your passkey" (an Android phone,
the recorded answer skipped, to /account/protect; 2026-11-07, section
11); "Open your first anos account" (the
accounts read and none, to /wallet); "Finish creating your Spending
account 2" (an account not submitted to the validator, by its name, to
/wallet); "3 unread chats" (to /chat); "2 chat requests" (the invites to
this pod and the join requests on its rooms, to /chat/requests); "2
proposals open for your vote" (the open DAO proposals this pod has
votes in and has not voted on, to /dao; 2026-11-08, section 11); "A fund
proposal is open for your vote" (a fund proposal is open and one of the
pod's accounts with guardian votes neither proposed it nor voted on it,
to /dao/guardians; 2026-11-08, section 11); "4 unread notifications" (to
/notifications), each singular when it is one; then the tiles, one
square per side-panel entry except Home itself
and Log, with the entry's icon and label, Chat and Notifications
carrying their unread counts at the top right and, since 2026-11-12
(section 11), Moderation and Attesting the number of things on their
page that this device has not seen yet (8.1), drawn from the same list
as the side panel (navigation.service, 8.3). On open /list-anos-accounts
(quiet) fills the session's accounts, a refusal in red, then the
balances are read; every 5 seconds while an account is not on the ledger
yet or any anos are held or pending, those accounts are read again, the
ones that are not on the ledger yet and the ones with anos held or
pending, and every account once when one of them changed, as the Wallet
page does (2026-11-11, section 11; until then every account was read
again every 5 seconds). Beside the accounts, /list-dao-proposals {
status: 'open',
limit: 100 } (quiet) counts the proposals with yourWeight at least 1 and
no vote of this pod for the open-votes line, and /list-fund-proposals {
status: 'open' } (quiet) brings the open fund proposal for the fund line,
which shows while its status is open and one of the pod's accounts whose
balance entry has guardianVotes at least 1 (balances.service, 8.3, from
the /get-account read Home already makes) is neither its proposer nor in
its votes; a refusal shows no line, the lines are a convenience
(2026-11-08, section 11).

Wallet. Titled "Wallet" (the subtitle left on 2026-11-06, section 11).
On top the balance card (balance-card.component over balances.service,
8.3), the card Home shows too, as it is since 2026-11-10 (section 11;
the plan is forclaude/wallet-balance-card-plan-1.md): "Total" with a
refresh button, and under it the big number, what the accounts hold on
the ledger plus what they have staked (a stake is a transfer to the
fund, so it has left its account's balance, and the card counts it back
in). Then the rows, the label on the left and the amount on the right
("900 anos"), which add up to Total: "Available", what the accounts hold
less what is spoken for; "Staked", the accounts' stakes as /get-account
answers them (5.4); "In escrow", the open escrow trades the accounts
sell in; and "Being sent", only while its amount is above zero: the
assisted transfers waiting for attestors, the guarded and vault
transfers waiting out their lock and the transfers sent and not yet
written, together. Available, Staked and In escrow always show, also at
"0 anos". A row above zero is a button with a small arrow at its right,
and a tap opens the balance sheet for it (the paragraph after this one);
a row at zero is plain and opens nothing. Then the small lines "1
account is not on the ledger yet" and "1 account could not be read"
(plural likewise); "No anos account yet." without an account; "Reading…"
until the first read finished. The validator moves a balance only when a
transfer is written, so what is in escrow or being sent is still in its
account's balance, and Available is what is left after it.
Then (2026-11-07, section 11) a button "Noted transactions" to
/wallet/notes. Then "Accounts": one card per account from /list-anos-accounts, in the
masterpod's order (oldest first), in a grid; "No anos account yet. Open
one below." when there are none. A card is named by its type, "Spending
account", or "Spending account 1" and "Spending account 2" when the pod
has more than one of a type (account-names.ts), with the type's icon;
the name and the balance are one link to the account page. Under the
name: the balance in large type once the account is on the ledger and,
while something is held, "100 anos available · 25 in an escrow trade"
(the held part named by its one kind: in an escrow trade, in an assisted
transfer, waiting out a lock, pending) and, when a held-amount read was
refused, "Some of this account's reads failed; what is held may be
incomplete."; "Not submitted to the validator" for a creation that never
reached the validator; "Waiting for the ledger…" while the creation has
not landed (unknown account); another refusal in red; "Reading…" before
the first read. A lost account (2026-11-08, section 11: its keyBlob does
not open under the key blob key, the keys went with an old passkey) shows
the lock-off icon and "Lost with the old passkey" in place of the balance;
nothing is read for it and it counts in no total and no poll. When
/list-my-break-glass-moves (masterpod 14.4.1, read with the balances
while an account is lost) lists a move for it, the move's state sits
under the line: "Moving the money: waiting for 2 attestors", "Moving the
money: 1 of 2 attestors signed", "Moving the money: being written" once
the case is decided, "Moved to Spending account 2" once the new account's
history lists the move, "The attestors dismissed the move". The card's
footer: the id in short form ("a1b2c3d4…e5f6",
the first 8 and the last 4 characters), a copy button (8.5) with the
full id, and Resubmit on an unsubmitted account. The balances are read
when the page opens, by the card's refresh button and by Refresh (which
reloads the account list too): every account. Every 5 seconds while an
account is not on the ledger yet or any anos are held or pending, the
watched accounts are read again, quiet in the log, as the polls are: the
accounts that are not on the ledger yet and the ones with anos held or
pending (2026-11-11, section 11; balances.service's poll, 8.3; until
then every account was read again every 5 seconds). When such a round
changed a watched account (it landed, its balance moved or its held
amount changed), every account is read once, so a move between two of
the person's own accounts does not leave the total short for longer than
about one round. While something is held on one account, the other
accounts are not read again by themselves: anos that arrive on them show
when Home or the Wallet page is next opened, or with the card's refresh
button, as it already is when nothing is held. Then "Open a new
account": a type select (spending,
guarded, vault, assisted) and Create anos account, which first asks in
the confirmation box (8.9; 2026-11-10, section 11): the title "Open a new
spending account?", with the type from the select, the line "The account
is added to the ledger and stays there for good.", and the buttons Cancel
and Create anos account. Cancel makes nothing. Retry asks the same way,
since it is the same button; Resubmit does not ask, since it makes no new
account. While the encryption key or the key blob key is not in RAM the
button shows that key's sentence and no box. Create anos account in the
box runs
account-creation.service's createAccount (8.3; since 2026-11-08 the steps
live there, so the recovery's finish opens accounts the same way, 12.3)
with the type the box showed, the select keeping its value,
and shows its steps as a progress list:
1. pair one, pair two, the break-glass seed and its two keys; the
   wallet public keys from /api/sign/public-keys; accountId; the
   creation payload (the test wallet's buildCreateAccountTransaction,
   with the wallet keys from the server) signed by the six keys here;
2. the break-glass seed deposited (section 6, breakglasskey);
3. /api/sign: the two wallet signatures added;
4. /create-anos-account with keyBlob (under the key blob key, section 7;
   2026-11-08) and the signed creation; when the masterpod answers 403
   account limit reached (4.4; 2026-11-10) the error under the steps is
   "This anoPod has reached the limit for new anos accounts. Try again
   later." in place of the route and its reason;
5. /api/anos/1/create-account with the signed creation; a 202, or a 400
   saying the account or its transaction already exists, counts as
   submitted;
6. /mark-anos-account-submitted;
then the service waits for the account to be on the ledger, /get-account
with the new pair one every 5 seconds for up to 90 seconds, the page busy
meanwhile. A failure before step 4 shows Retry, which starts over with
fresh keys. A failure at step 5 or 6 leaves the row unsubmitted; its card
shows Resubmit, which re-posts the stored creation (step 5) and marks it
(step 6) through the service's submitCreation. After step 4 and after
step 6 the service reads the list and the balances again, so the new card
shows "Waiting for the ledger…" until the wait sees it land; past 90
seconds the page says "The account is not on the ledger yet after 90
seconds. It may still land: refresh in a moment." and the 5-second poll
picks it up.

The balance sheet (2026-11-10, section 11; balance-sheet.component,
8.3), what a row of the balance card opens, on Home and on the Wallet
page: a panel that slides up from the bottom of the screen and lies over
the page (MatBottomSheet, as the marketplace's two sheets, 8.7), closed
by a tap outside it. Its title is the row's label and amount, "Staked ·
250 anos". Under it one row per item, in the accounts' order, each with
its account's name in bold ("Spending account", account-names.ts):
- Available: one row per account that has anos available, the amount at
  the right. A tap opens the account's page.
- Staked: one row per account and purpose, the purpose under the name,
  in the words of the Stake for list, and the amount at the right; an
  account's purposes in the order of STAKE_PURPOSES (crypto.service).
  Nothing to tap.
- In escrow: one row per open trade the account sells in, as the account
  page lists it: under the name "25 anos to a1b2c3d4…e5f6" (the buyer's
  id in short form), then in small type the stage in words from the
  seller's side and the date. A tap opens the trade's page.
- Being sent: one row per waiting transfer, under the name the Wallet
  page's sentence for its kind: "25 in an assisted transfer", "15
  waiting out a lock", "5 pending". A tap opens the assisted transfer's
  page, or the account's page for the other two. A pending row with no
  amount (the validator answers "0" for it) sends no anos and is no row.
A row that leads somewhere is a link, and a tap on it closes the sheet.
The sheet reads the balances service itself, as the card does, so it
follows a refresh and the 5-second poll while it is open, and its rows
add up to the amount in its title.

Account. The account id in the title with a copy button (8.5). Then, in
this order: balance, type, the latest transaction id, created; Refresh,
and a 5-second poll while something is pending, an escrow trade is open,
an assisted transfer is waiting or a transfer is waiting out its lock;
Send; Pending, the pending transaction if any; Escrow trades, the open
trades from /list-escrows (section 5.4); Assisted transfer, on an
assisted account, the held transfer from /get-assisted-transfer (section
5.4); Locked transfer, on a guarded or vault account, the transfer
waiting out its lock from /get-locked-transfer (section 5.4); a
"Transaction history" button to the history page below. The two folded
panels of the test wallet, the guardian vote on a proposal id pasted by
hand and the fund proposal form, left this page on 2026-11-08 (section
11) for the Guardians page under the DAO (/dao/guardians, below); the
stake form on a spending account's Send stays. The transaction list left
this page for the history page on 2026-11-05 (section 11);
/list-transactions is still read here, for the pending list. Under the balance, while this
account is the seller of an open escrow trade, one line: "5 anos of this
are in an open escrow trade."; while an assisted transfer of this account
is held, "5 anos of this are waiting in an assisted transfer."; while a
guarded or vault transfer of this account waits out its lock, "5 anos of
this are waiting out a lock." (2026-11-06, section 11). The validator
moves a balance only when the trade or the transfer is written, so the
balance stays whole while the anos are spoken for.

A lost account (2026-11-08, section 11), whose keyBlob does not open under
the key blob key, shows "Lost with the old passkey" with the lock-off icon
and "The keys of this account were lost with the old passkey. Its money
moves to a new account through the recovery." in place of the summary,
then the move's state as the Wallet card shows it; Refresh and the
Transaction history button stay (the history page itself shows the lost
line, since its read needs pair one), and Send, Pending, the trades and
the lock sections are left out. Every other page that
opens a keyBlob treats one that does not open the same way: the escrow
trade, assisted transfer and history pages show "Lost with the old
passkey" where the read's refusal would show; the attestor's and the
moderator's account pickers, the pinned listing's account lists and the
Home to-do lines list the usable accounts only (balances.service,
usableAccounts); Cases shows the id where the account's transactions
would be known.

Escrow trades (2026-11-05, section 11), after Pending: one row per
open trade, "5 anos to <buyer>" when this
account is the seller or "5 anos from <seller>" when it is the buyer,
the stage in words from this account's side, and the date; "No open
escrow trades." when there are none; the read's refusal in red when it
fails (a validator without the route). The stage words, from the
validator's stage (anossoftware spec 16.2): waiting, "Waiting for the
validators"; held, "Waiting for you to release the anos" to the seller
and "Waiting for the seller to release the anos" to the buyer;
releasing, "Being released"; cancelling, "Being cancelled"; disputed,
"In dispute, attestors are deciding"; a word the wallet does not know,
"Open". A row opens the trade page.

Assisted transfer (2026-11-06, section 11), after Escrow trades, on an
assisted account only: the held transfer from /get-assisted-transfer as
one row, "5 anos to <receiver>", the stage in words and the date; "No
transfer is waiting." when there is none; the read's refusal in red when
it fails (a validator or doorman without the route), the rest of the
page unharmed. The stage words, from the validator's stage (anossoftware
spec 17.2): waiting, "Waiting for the validators"; attesting, "Waiting
for attestors"; locked, "Locked until <unlocksAt>" (2026-11-08: a
break-glass move out of a guarded or vault account with both attestations
in, waiting out its lock; the wallet knows the word for completeness,
since a lost account's page reads nothing); writing, "Attested, being
written"; cancelling, "Being cancelled"; a word the wallet does not know,
"Open". The row opens the transfer page. On any other account type nothing is read and nothing
shows.

Locked transfer (2026-11-06, section 11), after Escrow trades, on a
guarded or vault account only: the transfer waiting out its time lock
from /get-locked-transfer as one row that is not a link, since a locked
transfer has no page of its own: "5 anos to <receiver>", then "Waiting
out the lock · until <the unlock moment>" while the stage is locked,
else the stage in words and the date it was made; "No transfer is
waiting." when there is none; the read's refusal in red when it fails (a
validator or doorman without the route), the rest of the page unharmed.
The stage words, from the validator's stage (anossoftware spec 18.2,
locked-stage.ts): waiting, "Waiting for the validators"; locked,
"Waiting out the lock"; due, "Unlocked, being written"; cancelling
(2026-11-11), "Being cancelled"; a word the wallet does not know,
"Held". On any other account type nothing is read and nothing shows.

The sender can cancel the locked transfer from its row (2026-11-11,
section 11; the plan is forclaude/locked-transfer-cancel-plan-1.md, the
validators' part anossoftware spec sections 27 and 28, the doorman's
doormansoftware spec section 9). Until then nothing could be done with
it. The button: "Cancel transfer", stroked, and red since 2026-11-12
(section 11; the class `danger`, 8.9), under the row, while the
stage is locked or due, that is from the moment every validator has
accepted the transfer until it is written; off while the page is busy.
It does not show while the stage is waiting, when the validators would
refuse the cancel, nor while it is cancelling. The button asks in the
confirmation box (8.9): the title "Cancel this transfer?"; Amount, "12
anos"; To, the receiver's full account id; the note "The 12 anos stay in
this account. It cannot be undone."; the buttons Back and "Yes, cancel
the transfer", the second one red since 2026-11-12 (the box's `danger`,
8.9). The first button reads Back in this box, where Cancel
would read as the cancel itself. Back does nothing. Yes builds the
follow-up lockedTransferCancel for the transfer the box showed,
{ type: "lockedTransferCancel", transactionId, accountId } with signedAt
added (crypto buildFollowUp, pair one from the keyBlob); /api/sign adds
the wallet pair; /locked-transfer-cancel takes it (anos-api
lockedTransferCancel); the page refreshes. While the cancel is on its
way a progress bar shows under the row, with no words, as on the
assisted transfer page, and the page's buttons are off; the bar and
"Sending…" under the Send form are the send's and do not show then. The
line under the row, in
green: "Sent. The transfer is being cancelled; the anos stay in this
account." The row then reads "Being cancelled · <the date it was made>"
until every validator has accepted the cancel. Then the row is gone, the
section reads "No transfer is waiting." and the account can send again.
The wallet shows nothing more about a cancelled transfer, no line in the
history and no notification, as for a cancelled assisted transfer. The
line under the row stands until the next cancel or the next send starts.

The wait. The validators refuse a cancel in the transfer's first
minutes, for as long as they would still take the same signed transfer
in again (anossoftware spec 27.2): with the wallet's dating that is the
offset after sending, 5 minutes on the testnet. The wallet shows nothing
about the wait ahead of time. The button is there from the start, a
press inside the wait goes to the validators, and their refusal reads
under the row, in red: "A transfer can be cancelled 5 minutes after it
is sent. Try again in a few minutes.", the number being the proxy's
lockOffsetMinutes in words (section 2). The refusals in plain words
(`cancelRefusal`), by what the validator's reason holds: "not approved
yet", "The validators have not all accepted this transfer yet. Try again
in a moment."; "cannot be cancelled yet", the sentence of the wait, or,
while the lock numbers have not loaded, the refusal as it came; "a
cancellation is already present", "This transfer is already being
cancelled."; "no locked_transactions transaction", "This transfer is no
longer held: it was written or cancelled."; "not the transfer's sender",
"This account cannot cancel this transfer." Every other refusal reads
"/locked-transfer-cancel: HTTP <status>: <reason>": against a doorman
without the route, "/locked-transfer-cancel: HTTP 404: Not Found".

Send: recipient account id (typed, or by the paste button at the right
end of the box, which reads the clipboard and takes the run of exactly 64
hex characters in it, lower-cased; with none, the hint under the box says
"Nothing on the clipboard looks like an account id."; when the browser
refuses, "The browser did not allow reading the clipboard. Paste into the
box the usual way."; Safari asks with its own Paste bubble first; 2026-11-05,
section 11), amount in anos, and the kind the account type allows, ported
from the test wallet:
spending picks plain, escrow or stake with a purpose; guarded and vault
date the transfer the lock plus the offset ahead by the numbers
/api/config gives (section 2: the proxy's env, the validators' numbers;
10 + 5 and 20 + 5 minutes on the testnet, 1 + 1 and 2 + 1 locally;
2026-11-06, section 11), with the line "A guarded transfer is dated 15
minutes ahead and waits out its lock on the validators. You can cancel
it until it is written." under Send (the last sentence since 2026-11-11,
section 11), the
minutes in words (minutes-words.ts: "7 days and 10 minutes" in
production); while the numbers have not loaded, Send is off and the line
reads "The lock settings have not loaded from the proxy. Refresh to try
again."; assisted sends
assistedAnosTransfer. The Stake for list shows the purposes this anoPod
may stake for (2026-11-10, section 11): daoVote and guardian for
everyone, and the role the pod holds, if it holds one: moderator,
attestor, validator or masterPod (4.3). While the status carries no
role (no status yet, an older masterpod, or role null) the list is
daoVote and guardian. From 2026-11-08 until then the list followed the
role for moderator and attestor only: validator and masterPod showed to
everyone, and all six showed while the status carried no role. A pick
that leaves the list goes back to daoVote.
Stake for starts at daoVote and the amount box starts empty (2026-11-10,
section 11; they started at attestor and at 1), so the form on a fresh
page and the form after a send are the same.
A guardian stake goes in whole thousands (2026-11-12, section 11; the
plan is forclaude/wallet-case-chats-plan-1.md, its step 5): while Kind
is stake and Stake for is guardian, Send stays off unless the amount is
a whole multiple of 1,000 anos, at least 1,000 (`GUARDIAN_STAKE_STEP_ANOS`
in constants.ts, which is the validators' GUARDIAN_VOTE_ANOS, the anos
staked for one guardian vote), and the line "A guardian stake goes in
whole thousands: 1,000, 2,000, 3,000 anos and so on." shows under the
form. So 1,500 anos cannot be sent for guardian. The stake for daoVote
and the other four purposes take any amount, as before.
A stake for moderator, attestor, validator or masterPod that the
validator refuses for the appointment reads "Only an appointed attestor
can stake for attestor.", with the stake's purpose in both places, or "The
validator could not confirm this anoPod with the masterpod. Try again
in a moment."; every other refusal shows as the validator says it. The
fund proposal's Returns stake list keeps all six: a guardian returns
any account's stake. Send first asks in the confirmation box (8.9;
2026-11-10, section 11), for every kind of send. The box shows what the
form held when the box opened: the title "Send 100 anos?"; Kind, the
transaction type as the button names it ("transferToFund"); From, the
account's name and short id ("Spending account 1 · a1b2c3d4…e5f6", the
short id kept whole where the line wraps); To,
the recipient's full account id, or for a stake Stake for, the purpose;
for a stake one more line, "A stake stays with the fund. It comes back
only through a fund proposal that the guardians vote for."; the buttons
Cancel and Send. A stake for daoVote or guardian has a box of its own
(2026-11-12, section 11), so that it does not read like an ordinary
send. Its title: "Stake 100 anos for DAO votes?" or "Stake 1000 anos as
a guardian?". Its lines: the same three, Kind, From and Stake for. Its
notes, three, in this order: "A DAO stake gives you one vote for each
anos. It is locked for one month since your last vote." or "A guardian
stake gives you one vote on fund proposals for each 1,000 anos. It is
locked for one year since your last vote."; then the line about the
fund, as above; then "To confirm, type your username below." Under the
notes a text box, "Your username" (the box's `typed`, 8.9). The buttons
are Cancel and Stake, and Stake stays off until the anoPod's username
is in the text box, compared without regard to capital letters and to
spaces around it. Stake does what Send does in the other boxes. The
month and the year are the user's words (the plan's decision 11): no
code holds a stake for that time, and a stake comes back by a fund
proposal, as the second note says. A stake for moderator, attestor,
validator or masterPod and every transfer keep the box described
first. Cancel sends nothing and leaves the form as it was
typed. Send in the box empties the form at once, before the answer
comes: Kind back to plain, Stake for back to daoVote, the recipient and
the amount empty, the paste hint gone. The form stays empty whatever the
answer is, accepted, refused or no answer at all, so the same send cannot
go out a second time after an answer that got lost on the way, and the
page's Send button stays off until a new amount is typed. What is sent
is what the box showed, not what the form holds. While the send is on
its way the page shows a progress bar and "Sending…" under the form;
then the outcome line as before, "accepted: <id>" or the refusal.
previousTransactionId is /get-account's
latestTransactionId, fetched right before building, after the box, and
the date of a guarded or vault transfer is worked out there too, so the
time spent reading the box does not use up the lock's offset. The payload is
signed by pair one (keyBlob opened for the signature and dropped),
/api/sign adds the wallet pair, the validator gets it, the page
refreshes. Send is disabled while the account has a pending transaction,
is the seller of an open escrow trade, holds an assisted transfer or has
a transfer waiting out its lock (one held transaction per account; the
validator refuses a second) or, on a guarded or vault account, while the
lock numbers have not loaded, with the line "An escrow trade is open.
This account can send again when it closes.", "An assisted transfer is
waiting. This account can send again when it is written or cancelled."
or "A transfer is waiting out its lock. This account can send again when
it is written or cancelled." (the last two words since 2026-11-11,
section 11). Under Send, an assisted account
reads "An assisted transfer waits until two attestors have checked it.
An attestor will open a case and ask for your lookup id. You can cancel
it until it is written." where a guarded or vault account reads its lock
line. Follow-ups (the guardian vote only) and the fund proposal form are
the test wallet's, ported with the same fields and the same signing
path; the escrow follow-ups (success, cancel, dispute, verdict) left
this form on 2026-11-05 for the trade page, and the attestation and
assisted transfer cancel forms on 2026-11-06: the attestor's trade case
page posts the attestation (13.3), the transfer page the cancel.

Transaction history, at /wallet/:accountId/history, opened by the
button on the account page (2026-11-05, section 11; rewritten
2026-11-06). Titled "Transaction history", the account's name and short
id under it ("Spending account 1 · a1b2c3d4…e5f6"), Back to the account,
then the date range field ("Dates", From and To, the picker's toggle
and, while a range is set, a clear button) and Refresh. The list from
/list-transactions, newest first, 20 rows at a time (HISTORY_PAGE):
Show more adds 20 older ones with beforePosition while a page came back
full. With a range the reads carry from, the start of the first day, and
to, the start of the day after the last day (local midnight, ISO 8601);
a change with both dates set, or both cleared, reads the first page
again, one alone waits for the other, and the clear button empties both
and reads again. The rows in plain words under day headings ("Today",
"Yesterday", "6 November", with the year for another year, the words of
ChatService.dayLabel): an icon; "Sent to a1b2c3d4…e5f6", "Received from
…", "Account created", "Escrow released to …", "Escrow received from …",
"Staked with the fund", "Fund proposal", "Received from the fund", "Fund
payout to …" (history-words.ts; a type word the wallet does not know
shows as it is); the time under the title; the amount at the right,
"+5 anos" in the primary colour, "−5 anos" in the on-surface colour, the
amount without a sign for a payout seen by its proposer, nothing for a
creation or a proposal. A tap opens the details under the row: Kind in
words (plain, guarded, vault or assisted transfer, escrow transfer,
stake, fund proposal, fund payout, account creation), To or From the
other side's full id with a copy button (8.5), Transaction the id with a
copy button, Position, When the full date and time. "Nothing on the
ledger for this account yet." when empty without a range, "No
transactions between these dates." with one; a failed read in red. Read
when opened, by Refresh and by a range change only, no poll.

A note per row (2026-11-07, section 11), the person's own record of what
money a transaction was for, kept on the masterpod under the pod (4.6):
the details end with "Add a note", which opens the note form under the
row: three radio choices, "Bought", "Sold" and "Received as income", a
drop-down "Other kinds" of "Transferred to stake", "Received from stake",
"Transferred to own account", "Transferred from own account" and "Other",
which shows a "Tag" box; the row presets the kind (received, Bought;
sent, Sold; a stake, Transferred to stake; a payout received from the
fund, Received as income; a transfer between two of the pod's own
accounts, the own-account kind; nothing moving, Other); "Money", the
total paid or received, with the currency button beside it (the picker
sheet, 8.7; the newest note's currency at first, else the one the
marketplace remembers on this device), the price per anos under them
("35.50 THB per anos") once both are in, required for the three radio
kinds and optional for the others ("Enter the money as a number, like
3550 or 3550.50, and pick the currency." while Save is off for that); an
optional "Memo"; Save and Cancel. The ledger's facts go in the clear and
the kind, the money, the currency, the memo and the tag in one blob under
the encryption key (7). A noted row shows its note in short after the
time ("3:50:12 PM · Sold · 3,550.00 THB") and whole in the details
("Note", the memo), with Edit, which opens the form filled, and Remove,
which asks "Remove this note?" (Yes, Back). The notes are read once when
the page opens (/list-noted-transactions, quiet); one note per
transaction (the masterpod refuses a second with 409).

Noted transactions (2026-11-07, section 11), at /wallet/notes, opened by
the "Noted transactions" button on the Wallet page: the pod's notes over
every account, newest transaction first, read from the masterpod
(/list-noted-transactions, with from and to as the history page sends
them, the start of the first day and the start of the day after the
last; the accounts are listed into the session first when it has none).
Back to the wallet; the date range field ("Dates", From and To, the
toggle and the clear button), Refresh and "Download as CSV". Then the
chips "All", "Bought", "Sold", "Income" and "Other" (the other chip is
every kind of the drop-down and every tag, and a note that cannot be
read), applied on the phone since the kind is inside the blob; the
totals per currency over the rows shown, one line per currency in the
order they first appear ("Bought 3,550.00 THB · Sold 1,200.00 THB ·
Income 0.00 THB", each sum on the digits); "Only the newest 1,000 notes
are shown. Narrow the dates to see older ones." when the read hit the
masterpod's cap; a failed read in red. The rows in day headings as the
history page's: an icon by sent or received, the title (the kind's
words, the tag for other, "(cannot read)" for a blob that did not open),
the anos with the account's name and the time ("−100 anos · Spending
account 1 · 3:50:12 PM"), the money at the right ("3,550.00 THB"). A tap
opens the details: Price per anos when there is one, Memo when there is
one, Account (the name and the short id), To or From the other account's
full id with a copy button (8.5) when there is one, Transaction with a
copy button, Position, When; then Edit, which opens the note form
(Transaction history above) filled, and Remove, which asks "Remove this
note?" (Yes, Back). "No notes yet. Open an account's transaction history
and add one." when empty without a range, "No notes between these
dates." with one. The CSV, built on the phone with no package: the
header "Date,Kind,Anos,Sent or received,Money,Currency,Price per
anos,Memo,Account,Other account,Transaction id,Position", then one line
per shown note, newest first: the date as ISO 8601, the kind's words as
on screen, the anos as a decimal, "sent" or "received", the money as
typed, the currency code, the price per anos, the memo, the account's
name, the other account's full id, the transaction id, the position,
each empty when there is none; a field holding a comma, a double quote,
a line break or a leading or trailing space is wrapped in double quotes
with its double quotes doubled; lines end with CR LF and the text starts
with the UTF-8 byte order mark, so a spreadsheet opens Thai letters
right; the file is noted-transactions.csv, or
noted-transactions-<from>-<to>.csv with a range, the dates as
YYYY-MM-DD.

Escrow trade, at /wallet/:accountId/escrow/:transactionId, opened from a
row of the Escrow trades list (2026-11-05, section 11). Titled "Escrow
trade", the subtitle "You are the seller" or "You are the buyer", Back
to the account. The trade is picked out of /list-escrows by its id
(there is no read for one trade, and the list is short by the
validator's rule): the amount, the other side's account id (Buyer to the
seller, Seller to the buyer), when it was made, the stage in the words
of the Account paragraph, the transaction id, and one sentence of what
the stage means for this side (the buyer pays outside the system; when
paid, the seller releases; the buyer can cancel and the seller keeps the
anos; either can dispute and attestors decide). While the stage is held,
the buttons for this side: the seller "Release the anos" and "Dispute",
the buyer "Cancel trade" and "Dispute". Each asks once in place
("Release 5 anos to the buyer? Do this once you have been paid. It
cannot be undone."; "Cancel this trade? The seller keeps the 5 anos. It
cannot be undone."; "Dispute this trade? Attestors will decide it, and
neither side can release or cancel it after that."), then Yes or Back.
The cancel is red (2026-11-12, section 11; the class `danger`, 8.9):
"Cancel trade", and the Yes of its question, "Yes, cancel the trade".
Release, Dispute and the Yes of each keep their colour.
Yes builds the escrowSuccess, escrowCancel or escrowDispute follow-up
(crypto buildFollowUp, pair one from the keyBlob), /api/sign adds the
wallet pair, /escrow-signature takes it, then "Sent. ..." in green or
the validator's refusal in plain words (not all accepted yet; the other
side moved first, naming what they did; already in dispute; not this
account's to sign; and, since 2026-11-11, section 11, the wait before
the buyer's cancel: the validators refuse it in the trade's first
minutes, while the same signed transfer could still be sent in again,
anossoftware spec 27.2, and the page reads "A trade can be cancelled 5
minutes after it is made. Try again in a few minutes.", the number being
the proxy's lockOffsetMinutes in words; while that number has not loaded
the refusal reads as it came), and the page refreshes. No buttons in any other
stage, nor for a stage word the wallet does not know, which reads Open.
In dispute: who disputed it (you or the other side), the verdicts so far
("No verdict yet.", or "Verdicts so far: 1 to release. Waiting for one
more.", "A third attestor decides." when the two disagree, the
verdicts not yet accepted by every validator counted apart) and, when
/list-my-cases has a dispute case with this transaction id, a "See the
case" button to /cases/:caseId. The page refreshes every 5 seconds
while the trade is open. The closed view, for someone on the page when
the trade leaves the list: the first page of /list-transactions is
read, and the id on it means "This trade is closed. The anos were
released to the buyer.", not on it "This trade is closed. The trade was
cancelled and the anos stayed with the seller.", with "after the
attestors decided" when the last stage seen was disputed; a transactions
read that fails says only that the trade is closed. A trade the page
never saw open (an old link) reads "This trade is not open. Released
trades are in the account's transactions."

Assisted transfer, at /wallet/:accountId/assisted/:transactionId, opened
from the row of the account page's Assisted transfer section or from
"See the transfer" on the My case page of its trade case (2026-11-06,
section 11). Titled "Assisted transfer", the subtitle "Held" while the
transfer is held ("Closed", "Loading" or "Not held" otherwise), Back to
the account. /get-assisted-transfer is read when the page opens and
every 5 seconds while the transfer is held; its transfer is this page's
when the id is the route's, and null or another id means the transfer is
not held. The summary: the amount, To (the receiver's account id), when
it was made, the stage in the words of the Account paragraph,
Attestations ("0 of 2 on the validators") and the transaction id; then
one sentence of what the stage means (waiting: the validators are still
accepting it; attesting: two attestors have to check it, an attestor
opens a case and meets you on a video call, you can cancel until it is
written; writing: both attestations are on the validators, the next
write moves the anos, you can still cancel; cancelling: you cancelled
it, the anos stay; an unknown word: held, nothing offered). The case,
one paragraph from /list-my-cases (quiet, on each refresh while held),
the newest trade case with this transaction id: "No case yet. An
attestor will open one and ask for your lookup id."; open, "An attestor
opened a case. Share your lookup id on the case page."; in review, "An
attestor is checking your trade."; decided, "Two attestors signed. The
attestations go to the validators and the transfer is written in the
next round."; dismissed, "The case was dismissed: <reason>. The anos
stay held until you cancel the transfer or an attestor opens a new
case.", the reason in the My case page's words from /get-my-case (quiet,
once per case), "another reason" when the event has none. The buttons:
"Go to the case" (to /cases/:caseId) when there is a case, and "Cancel
transfer" while the stage is attesting or writing, which asks once in
place ("Cancel this transfer? The 5 anos stay in this account. It cannot
be undone."), then "Yes, cancel the transfer" or Back. Both cancel
buttons are red (2026-11-12, section 11; the class `danger`, 8.9):
"Cancel transfer" and "Yes, cancel the transfer". Yes builds the
assistedTransferCancel follow-up as the removed form did (crypto
buildFollowUp, pair one from the keyBlob), /api/sign adds the wallet
pair, /assisted-transfer-cancel takes it, then "Sent. The transfer is
being cancelled; the anos stay in this account." in green or the
validator's refusal in plain words (not all accepted yet; already being
cancelled; no longer held; not this account's to cancel; and, since
2026-11-11, section 11, the wait: the validators refuse the cancel in
the transfer's first minutes, while the same signed transfer could still
be sent in again, anossoftware spec 27.2, and the page reads "A transfer
can be cancelled 5 minutes after it is sent. Try again in a few
minutes.", the number being the proxy's lockOffsetMinutes in words;
while that number has not loaded the refusal reads as it came), the rest as
"/assisted-transfer-cancel: <reason>", and the page refreshes. The
closed view, for someone on the page when the transfer leaves the
validator: the first page of /list-transactions is read, and the id on
it means "Done. The 5 anos went to <receiver>.", not on it "Cancelled.
The anos stayed in this account."; a transactions read that fails says
"This transfer is no longer held. Check the account's transactions to
see whether the anos moved." The poll stops once the transfer is closed.
A transfer the page never saw held (an old link) reads "This transfer is
not held. A written transfer is in the account's transactions."

Chat (rebuilt as a messenger 2026-11-05, section 11): two panes. The
list of chats on the left, 360 px on a desktop, and the pane for the
child route on the right; on a phone (839 px and under) one or the other,
the pane while a child route is open, every child with a back arrow on
top. The list: a header "Chats" with a pencil to /chat/new (a floating
button on a phone); a "Requests" row on top, only while invites to this
pod or join requests on its rooms wait, reading "N invites, M join
requests"; then the rooms, newest activity first (the newest message,
else the room's creation). A row shows the other person's avatar (8.6)
for a private room with one other person, member or invited, else the
kind's icon (group, public, storefront); the title; the newest message
decrypted as one line, "You: " before this pod's own, "No messages yet"
without one, "(cannot read)" when it will not open; and the time (today
the time, yesterday "Yesterday", within six days the weekday, else the
date); an unread room (below) has a dot under the time and a bold
title. A room's title: a public room's name; an old listing room's "Sell
50 anos for THB" from the listing summary the masterpod sends; a private
room's other people, the invited as "mai (invited)", or "Just you", and
for a private room about a listing (2026-11-06) the listing's words after
them, "somchai · Selling 100 anos for THB". A private room about an
attestor case (2026-11-12, section 11) has the case's kind in words after
its people: "attestorjoy · Assisted transfer case", or "Escrow dispute
case", or "Recovery case". The invited mark stays, "somchai (invited) ·
Recovery case", and with one other person the row still shows that
person's avatar. The
rooms are the latest /list-chat-rooms answer kept in the session, which
the shell's 5-second poll refreshes once setup is complete; the list
refreshes it once when it opens. "No chat keys in this tab: unlock
again." shows without chat keys.

One conversation, at /chat/:chatRoomId: a header with the avatar or icon,
the title, the members (the invited marked) and a menu with Invite
someone (the creator of a private or public room; the username search,
the person's selfie, Invite), Invite an attestor (2026-11-12, section
11: both traders of a marketplace chat, only while its trade is in
dispute and an attestor has a case open on it; the paragraph on the
attestor in a marketplace chat, below), Members (a panel of the members
and the invited with avatars) and Leave (a member who is not the
creator; the room key is dropped and the list opens). The thread opens
at the room's
newest 50 messages (/list-messages with beforePosition, MESSAGES_PAGE)
and shows "Load older messages" on top while a page came back full; the
3-second poll reads after the newest shown position; the thread scrolls
to the bottom after opening and after a send, and for a message that
arrives only while the reader is within 120 px of the bottom. Messages
by one sender within five minutes of each other, on one day, form a
group: this pod's on the right, the others' on the left with, in a room
that is not a direct chat, the sender's avatar and name once on top; the
time once under the group's last bubble; a day line ("Today",
"Yesterday", else the date) between days. A run of exactly 64 hex
characters with no hex character on either side (an account id) shows in
code font with a copy button (8.5) after it; the rest of the text shows
as written, line breaks kept. The message box at the bottom grows to
five lines; Enter sends and Shift+Enter makes a new line; Send is a
round button. A sent message shows at once as a pale bubble with
"Sending" where the tick goes; /send-message's answer gives it its id
and position and the bubble turns normal with a small tick; a refusal
removes the bubble, puts the text back in the box and shows the error
line. The room is marked seen (Unread, below) when it opens and when
new messages show. "You are not in this chat." for a room that is not in
the list.

The pinned card (2026-11-06, section 11), in a private room about a
listing, under the header and its panels and above the thread, drawn for
the room's two traders only (2026-11-12, section 11: the person who made
the room by pressing Connect, and the listing's owner; anyone else in
the room is a guest and gets no card, and "the other person" in this
paragraph and the two after it is the other trader, never a guest; 8.7,
and the paragraph on the attestor in a marketplace chat, below): the
listing in one line, "Selling 100 anos · 35.50 THB each · 3,550 THB",
with the other person's avatar (8.6) and Closed when the listing is
closed; the roles from the listing (the owner of a sell listing and the
other person of a buy listing are the seller). The buyer's "Share an
account": a menu of this pod's accounts (the id shortened, the type); one
tap posts "Please send the anos to this account: <the account id>" into
the chat, encrypted like any message, so the thread shows the id in code
font with its copy button (8.5). The seller's "Start the escrow trade",
disabled with the hint "Ask them to share an account first" until the
other person has posted an account id: a small form in the card, From
(this pod's spending accounts; one is fixed, more is a select), To (the
other person's account ids in the chat, newest first; one is fixed),
Amount in anos (the listing's quantity at first), the total at the
listing's price, Start and Cancel; Start asks once in place ("Put 100
anos into escrow for somchai? You release them once you have been paid.
Only the buyer can cancel; either side can dispute.", Yes or Back), and
Yes builds the escrowTransfer as the account page's Send does (pair one
from the account's keyBlob and the encryption key, /get-account for the
latest transaction id, buildAnosTransferTransaction with type
escrowTransfer, /api/sign, /anos-transfer). What follows the answer
(rewritten 2026-11-10, section 11, from
forclaude/wallet-trade-message-plan-1.md): an answer with a 4xx status is
a refusal and shows the validator's reason as the account page shows it,
with plain words when the account already has something waiting on the
validators ("This account already has an escrow trade or a transfer
waiting on the validators. Finish that first, or use another account.").
After any other answer the card checks the chat's trade once more
(below), and that check posts the message "Escrow trade started: 100 anos
from <my account id> to <their account id>. Transaction <id>."; Yes does
not post it. The validator stores a trade before it answers, so an answer
lost on the way (no network, the proxy's 502, the doorman's 502 or 504)
may hide a trade that started: found open, it has started and no error
shows; otherwise the card says "The validators did not answer. If the
trade started, it will show here in a moment. If it does not, try again."
and the form stays for another try. A trade the check finds, open or
released, closes the form, so its question does not come back by itself
once that trade is cancelled.

The chat's trade (rewritten 2026-11-10, section 11, from
forclaude/wallet-finished-trade-plan-1.md): the card reads it from the
validators when the conversation opens, every 5 seconds while it is open,
and once more when the seller says Yes to Start. Until the first check
ends the card says "Checking for a trade…" where Share and Start go. The
chat's account ids: the page holds the room's newest 50 messages only, so
the card reads every message of the room itself, once (/list-messages
from the first position, 200 at a time, CARD_MESSAGES_PAGE, decrypted
with the room key), and adds the ids the page feeds it, which carry what
arrived since; the form's To list and the "Ask them to share an account
first" hint follow all of them. The accounts it reads: this pod's usable
spending accounts when it is the seller, and this pod's usable accounts
named in the chat (an id in the messages that is one of
session.accounts), pair one from each keyBlob; with no account id in the
chat nothing is read. A trade is the chat's when it is between one of
those accounts and an account named in the chat, whoever posted the id.
First /list-escrows on each account: the newest open trade of the chat
shows as "Escrow trade: 100 anos · Waiting for the seller to release the
anos" (escrow-stage.ts, by this pod's side) with "See the trade" to
/wallet/<my account>/escrow/<transactionId>; Release, Cancel and Dispute
stay on that page. With none open, /list-transactions on each account
with `from` the room's createdAt, 200 rows at a time
(CARD_TRANSACTIONS_PAGE), paging back with beforePosition while a page
comes back full: an escrowTransfer of the chat is its released trade, the
newest when there are several. The open list is read first because the
validators write the link before the trade leaves /list-escrows
(anossoftware src/accounts/accounts.service.js, writeApproved), so a
released trade is never missing from both reads. A released trade ends
the chat's trading: both sides read "Released: 100 anos went to the
buyer." and "This trade is finished. To trade again, start a new chat.",
Share and Start do not come back in this chat, on this visit or a later
one, and the owner of an open listing gets "Close the listing", which
asks once and calls /close-listing; the card reads Closed once the room
list is refreshed. A new trade between the same two people needs a new
chat, and so another listing, since the masterpod allows one chat per
person per listing. A trade seen open here and then gone with nothing
released reads "Cancelled: the seller kept the anos.", from the card's
memory of this visit, and Share and Start come back. A read that fails,
on the validators or the masterpod, is never taken as "no trade": the
card keeps the trade or the Released lines it shows, and where Share and
Start go it says "Could not check for a trade. Trying again." until a
check has read everything. The Yes of Start runs one fresh check before
anything is built or signed: when it cannot be read, nothing is sent and
the card says "Could not check for an earlier trade, so nothing was sent.
Try again."; when it finds a trade open or released, nothing is sent and
the card says "Nothing was sent. This chat already has an escrow trade."
and shows that trade. Three limits: the buyer's card can match a trade
only when the seller's account id is in the chat, which the chat's
message about the trade (the next paragraph) puts there the first time
the seller has the chat open after the trade started; two chats at once
between the same two people on the same accounts both read Released after
one release; a seller who recovered the account after a lost passkey
cannot read the old account, so a release sent from it is not seen. Share
and Start show until a trade has started, and again after a cancelled
one; a closed listing's card shows only the stage of a trade when there
is one. A room whose listing the masterpod does not give shows no card.

The chat's message about its trade (2026-11-10, section 11, from
forclaude/wallet-trade-message-plan-1.md): whenever the check finds the
chat's trade, open or released, the account it was read on sent it, and
no message in the chat carries its transaction id (64 hex characters, so
it is among the ids named in the chat), the card posts the message
itself, in the seller's name, encrypted with the room key like any other:
"Escrow trade started: 100 anos from <my account id> to <their account
id>. Transaction <id>." for an open trade, "Escrow trade released: 100
anos from <my account id> to <their account id>. Transaction <id>." for
one already released. This is the only place the message is posted. So a
lost answer to the transfer, a /send-message that failed, a tab closed in
between and a trade started from the account page's Send (escrow kind) to
an account named in the chat all end with the chat told, the next time
the seller has the chat open; the message puts the seller's account id
into the chat, and the buyer's card then finds the trade. The card keeps
the transaction ids it posted about, per room (`told`), so a check that
runs before the thread shows the message does not post it again; a post
that fails is tried again by the next check; two devices of the seller in
the same chat at the same moment can post it twice. The buyer's card
never posts about a trade.

The attestor in a marketplace chat (2026-11-12, section 11; the plan is
forclaude/wallet-case-chats-plan-1.md, its decisions 9, 26 and 27; the
masterpod's part is its spec's section 18): an attestor on an escrow
dispute can be brought into the marketplace chat of the trade, and then
reads everything said there, since a room has one key and a member gets
every message from the first. Either trader can do it, without the other
agreeing, with the menu's "Invite an attestor". The entry shows for the
room's two traders only, and only while the chat's trade is in dispute
and an attestor has a case open on it: the pinned card finds that case
(8.7: /list-my-cases, and of its disputes the one on the trade's
transaction that is open or in review) and tells the page its id. Before
the dispute, before an attestor opens the case, and once the trade is no
longer in dispute there is no entry. Opening it reads /list-my-cases
again, quiet, and takes the dispute with that case id. When that case is
no longer open or in review the entry goes. Otherwise a panel shows
under the header, like the invite panel: the muted line "An attestor you
invite can read this whole chat.", then the attestors on the case, each
with avatar (8.6), username and Invite. The attestors on the case are
the ones the masterpod names on the dispute (`attestors`, masterpod
13.4.5 and 18: every attestor who acted on the case, the one who opened
it first) and, with them, the attestors who have a chat with this pod
about the case (chat.service's `caseAttestors`, 8.3), each once, without
those who are a member of this room or invited to it. So the attestor
who opened the case is on the list from the start, and no other chat
with that attestor is needed first. Invite wraps the room's key to the
attestor's chat keys (`wrapFor`), calls /invite-to-chat-room and
refreshes the room list; the attestor then shows as invited and leaves
the list, and with nobody left to invite the panel reads "The attestors
on this case are already in this chat." A refusal shows in the page's
error line as the masterpod says it; the masterpod lets a member of a
listing chat who did not start it invite an appointed attestor and
nobody else. A second click on the entry closes the panel. The attestor
gets the request on the Requests page (below) and, once in, is a guest:
no pinned card, the two traders' card keeps going by the two traders,
and the attestor's menu has Members and Leave. Nothing takes the
attestor out when the case closes. "Invite someone" stays as it was, for
the room's creator.

Requests, at /chat/requests: the invites to this pod (the inviter's
username, then `invited you to "<the public room's name>"`, `invited you
to a private chat` or, for a room about one of this pod's listings,
`wants to chat about your listing Selling 100 anos for THB`; 2026-11-06;
for a room about someone else's listing, `invited you to the chat about
the listing Selling 100 anos for THB`, which is what an attestor reads
whom a trader brings into a marketplace chat; 2026-11-12, section 11,
step 6;
for a room about an attestor case, by the case's kind, `is an attestor
and wants to chat about your assisted transfer`, `is an attestor and
wants to chat about your escrow dispute` or `is an attestor and wants to
chat about your recovery`, and in the wallet of a pod that is itself an
attestor (its role, 4.3) `invited you to a chat about a case`;
2026-11-12, section 11),
Accept (the room opens) and Decline; the join
requests on the rooms this pod created (`<username> asks to join
<title>`), Approve (the room key wrapped to the requester) and Decline;
each with the person's avatar; "No requests." when both lists are empty.

New chat, at /chat/new, three tabs. Message someone: a username, Find
(/search-usernames), the person's name, username and selfie, Start chat:
the private chat with exactly the two of you opens when it exists, else
a private room is created with a new room key wrapped to this pod's chat
keys, the person is invited with it wrapped to theirs (their chat public
keys are read first, so someone without them makes no room) and the room
opens; finding yourself reads "That is you.". New public room: a name,
Create, the room opens. Find public rooms: /list-public-chat-rooms when
the tab first opens and on Refresh, each room with its name, "by
<username> · N members" and Open (this pod is in it), Requested (asked
from this tab) or Request to join.

Unread: the last message position seen in each room is kept on this
device, in localStorage under `anopod-wallet.chat-seen.<anopodId>`, read
when the session opens and raised by the conversation when it opens,
when new messages show and after a send (`markSeen`). A room is unread
when its newest message is by someone else and above that position (0
when the room was never opened here); the count of unread rooms shows at
the right of the Chat entry in the side navigation, and the room's row
shows a dot and a bold title. The count is per device: a new phone shows
every room with messages as unread until each is opened once. A count of
messages is not possible, since positions count across all rooms
(2026-11-05, section 11).

Marketplace (rebuilt for the phone 2026-11-06, section 11; the plan is
forclaude/wallet-marketplace-plan-1.md): four screens. Browse, at
/marketplace: one row of chips on top, scrolling sideways on a phone: All,
Selling, Buying (one chosen, All at first); Country and Currency, each
showing the chosen name or its own word and opening the picker sheet
(8.7); Sort, a menu of Newest, Price low to high and Price high to low;
Filters, with the number of ranges set, opening the filters sheet (8.7). A
chip change reads the listings again: /list-listings with the side, the
currency, the country, the sort and limit 200, open listings only. Under
the chips a "Your listings" row with a storefront icon and the line "N
open · M waiting", shown while this pod has listings or someone waits on
one (the open count from one /list-listings with mine when the page
opens, the waiting count the invites to this pod that carry a listing),
to /marketplace/mine. Then the cards (8.7) in a grid, one column on a
phone and two or three on a desktop; the quantity and price ranges are
applied on the phone over the listings loaded, the price range only once
a currency is picked; "No listings match." when nothing is left; a
refused read in red. A round + at the bottom right to /marketplace/new on
a phone, a New listing button in the chip row on a desktop. The country
and the currency picked last are remembered on the device (localStorage,
`anopod-wallet.marketplace-filters`); Browse opens with them and the
new-listing form starts from them.

Listing, at /marketplace/:listingId: /get-listing when the page opens and
after Connect, Accept, Decline and Close ("Loading" meanwhile, "This
listing does not exist." on a 404); a back arrow to /marketplace; the
price in large bold text ("35.50 THB per anos"), then "Selling 100
anos", "Total 3,550 THB", the country's name, when it was posted, and the
owner with their avatar (8.6, 56 px), username and name; a Closed banner
when closed. Someone else's listing, by this pod's own room about it
(8.3, marketplace.service): no room, a big Connect that opens the
first-message box, a textarea with "Hi, is this still available?" on a
Selling listing or "Hi, I can sell you anos. Are you still buying?" on a
Buying one, which can be changed, Send and Cancel; Send makes a private
room about the listing with a new room key, invites the owner with the
key wrapped to theirs and sends the message, and the state becomes
waiting; the owner invited, the big button disabled reading "Waiting for
somchai to accept"; the owner in, a big Open chat to the conversation; the
owner neither, "somchai did not accept." and Connect again, the box
again, the invite and the message into the same room. A closed listing
shows "This listing is closed." instead of Connect and keeps Open chat
when a room exists. The error line in red under the button; without chat
keys "No chat keys in this tab: unlock again." and Connect disabled. This
pod's own listing: the people who connected (8.7) and, for an open
listing, Close listing, which asks once in place ("Close this listing?
People can no longer connect; your chats stay.", Yes or Back) and calls
/close-listing; a closed one has nothing to do.

New listing, at /marketplace/new: a back arrow; two large toggle buttons,
"I am selling anos" and "I am buying anos" (selling at first); the
quantity in anos (up to six decimals); the price per anos (a decimal, up
to eight decimals, two usual); Currency and Country as buttons that open
the picker sheet (8.7) and show the chosen name, the remembered ones at
first; a live "Total 3,550 THB" once the three are in; Create listing,
which calls /create-listing (side, quantity in millionths, currency,
country, price; no room and no key work) and opens the listing's page; the
refusal in red.

Your listings, at /marketplace/mine: a back arrow; /list-listings with
mine and status any when the page opens and after a Close: the open
listings first, newest first, then the closed ones; each a card (8.7)
with, under it, the people who connected (8.7) and, for an open listing,
Close, asking once as on the listing page. "You have no listings yet."
with a New listing button when there are none.

The prices (src/app/prices.ts): a price shows with at least two decimals,
the whole part grouped by the browser's locale and the currency code after
the number, never a symbol ("35.50 THB"); a total is the quantity times
the price rounded to two decimals on the digits (BigInt, as amounts.ts
does amounts), shown without decimals when whole ("3,550 THB", else
"3,554.38 THB"); the currencies and their names come from
Intl.supportedValuesOf and Intl.DisplayNames, the countries' names from
Intl.DisplayNames (src/app/countries.ts, countryName). Nobody types a
currency or country code, an anopod id or an account id: the pickers show
names, people are found by username and selfie. The old group room per
listing is not made any more; old marketplace rooms stay in Chat for the
people in them, and Request to join stays for public rooms (Chat, New
chat).

DAO (2026-11-08, section 11; the plan is forclaude/dao-voting-plan-1.md,
the masterpod's routes its spec's section 15): three screens, two of them
step 4 and the third step 5. The wallet reads and writes the ledger
through the masterpod alone; it never asks a validator for DAO stake. One
staked anos of the daoVote purpose is one DAO vote; a pod's weight in a
proposal is fixed by the masterpod's snapshot when the proposal is posted
and again when it goes to a vote, so stake added later counts from the
next proposal.

DAO, at /dao: a header "DAO" with a Refresh icon button and, on a
desktop, a New proposal button (a round + at the bottom right on a
phone, as Browse); then the notice, an info icon and one paragraph in the
plain muted style on a surface-container background with 12 px corners,
never the error container: "DAO proposals come from people who staked
anos for daoVote. One staked anos is one vote. Anyone with votes can post
a proposal. It goes to a vote once 15 percent of all DAO votes support
it, and then everyone votes for or against for 14 days. An accepted
proposal records what the community decided. It moves no money and
changes nothing by itself.", the two numbers from the `settings` the
masterpod answers with every list (the minutes turned into days by
Math.round(minutes / 1440)), shown once the first list answered; then,
since 2026-11-08 (section 11; the Guardians plan,
forclaude/wallet-guardians-plan-1.md), one outlined card the width of the
page, for everyone: a shield icon, "Guardians" in bold with "The fund's
proposals and the guardians' votes" under it and a chevron at the right,
the whole card a link to /dao/guardians (the Guardians paragraphs below);
it says nothing about the caller, since the Guardians page reads the
caller's accounts itself; then three tabs, Open votes, Pending and
Decided. A tab reads
/list-dao-proposals for its status (open, pending, decided: accepted and
rejected together) when it is first shown and on Refresh, 20 at a time,
newest first, and Show more reads 20 more by offset while the last page
came back full (the list has no more flag); Refresh forgets every tab and
reads the one on screen again, the others when they are shown next. The
Decided tab has a date range above its cards, as the history page: both
days picked, or both cleared, read again, with from at the start of the
first day and to at the start of the day after the last (the masterpod
takes from inclusive and to exclusive, on decidedAt). The cards, one
column on a phone and two on a desktop: the title in bold; "by somchai ·
posted Nov 8, 2026" (the date without the time); then the state line.
Pending: "25 of 180 votes in support" with a progress bar of the support
over the support needed and "5 days left" (the whole days to
pendingUntil, or the hours, rounded up, under a day). Open: "For 120 ·
Against 40" and "closes Nov 22, 2026, 3:50:12 PM". Decided: Accepted or
Rejected as a small label, green or red, the for and against, and
"decided Nov 22, 2026, 3:50:12 PM". Under it, when the caller acted: "You
supported this" with a green thumb_up on a pending card; "You voted for"
or "You voted against" with the green thumb_up or the red thumb_down on
an open or decided one (a support is not a vote, everyone votes fresh).
The green is #2e7d32 and the red var(--mat-sys-error), Material's icons,
never emojis. A card opens /dao/<id>. The tab's empty line when nothing
came back: "No proposal is open for votes.", "No proposal is collecting
support.", "No proposal has been decided yet."; a refused read in red
under the tab ("/list-dao-proposals: HTTP 404: Not Found" against a
masterpod without the routes), and the rest of the wallet works.

New proposal, at /dao/new (step 4): a back arrow to /dao; Title (100
characters at most, a counter "12/100" under it); Your proposal, a
textarea of 10 rows (5,000 at most, its counter); under them the rule
once the settings came, read quietly with /list-dao-proposals { status:
'open', limit: 1 } when the page opens: "Your proposal needs support from
15 percent of all DAO votes within 7 days to go to a vote. Posting it
counts as your own support. You need at least 1 DAO vote(s) to post.";
Post proposal, disabled until both fields have text and while busy. Post
calls /create-dao-proposal with the trimmed fields; a 201 opens
/dao/<proposalId> (the masterpod answers status pending, or open when the
proposer's own weight alone reaches the support needed). The refusals in
words: not enough DAO votes, "You need at least 1 DAO votes to post a
proposal. Stake anos for daoVote from a spending account."; a pending
proposal is already open, "You already have a pending proposal. Wait
until it goes to a vote or expires."; validators unreachable, "The
validators did not answer. Try again in a moment."; the rest
"/create-dao-proposal: HTTP 400: invalid title" and the like.

Proposal, at /dao/:proposalId (step 5, 2026-11-08, section 11), in the
frame of the listing page: a back arrow to /dao and a Refresh icon
button; /get-dao-proposal when the page opens, after each action and on
Refresh, "Loading" until the first answer, "This proposal does not
exist." on a 404, any other refusal in red ("/get-dao-proposal: HTTP
404: Not Found" against a masterpod without the routes). Top to bottom:
the status as a small bordered label ("Pending", "Open for votes",
"Accepted" in green, "Rejected" in red, "Expired" muted); the title as
the heading; the proposer's avatar (8.6, 40 px) with "by somchai ·
posted Nov 8, 2026" (the date without the time); the text in a
paragraph with white-space pre-wrap, shown as typed, line breaks kept
and nothing rendered; the numbers: pending, and expired, "25 of 180
votes in support" with the progress bar and "until Nov 15, 2026,
12:00:00 PM"; open, "For 120 · Against 40" in large type and "closes
Nov 22, 2026, 3:50:12 PM"; decided, "For 120 · Against 40" and "decided
Nov 22, 2026, 3:50:12 PM" (the label at the top is the result); then
"1200 DAO votes in this proposal's snapshot". Your part: "Your votes in
this proposal: 12", or at 0 "You have no votes in this proposal's
snapshot. Anos staked after it was posted count from the next
proposal." Then the action, one per pod per stage, no undo, asked in
place: pending, with votes and not yet supported, one big outlined
button with the green thumb_up, "Support with 12 votes", which asks
"Add your 12 votes in support of this proposal? It cannot be undone."
with "Yes, support" and Back; Yes calls /support-dao-proposal, shows
"Your support is recorded." in green and reads the proposal again (it
may now be open). Open, with votes and not yet voted, two big outlined
buttons side by side, the green thumb_up "For" and the red thumb_down
"Against"; either asks "Vote for this proposal with 12 votes? It cannot
be undone." with "Yes, vote for" and Back; Yes calls /vote-dao-proposal,
shows "Your vote for is recorded." in green and reads again. After the
caller acted: "You supported this" on a pending proposal, "You voted
for" or "You voted against" on an open or decided one, with the icon
and no button; without votes in the snapshot, no button. The refusals
in words: already supported and already voted, "You already acted on
this proposal."; no DAO votes in this proposal, the no-votes sentence;
proposal not pending, proposal not open, proposal expired and voting
closed, "This proposal is no longer taking votes." with the proposal
read again; validators unreachable, "The validators did not answer. Try
again in a moment."; the rest "/vote-dao-proposal: HTTP 400: invalid
vote" and the like. Below, the public lists from /list-dao-votes, 50
rows at a time, newest first, Show more by offset while a page came
back full: once the proposal has opened, a heading "Votes" with the
official-stage rows; then a heading "Supported by" with the
pending-stage rows. A row: the username ("unknown pod" when the pod's
row is gone) with a small "you" tag on the caller's own row (the row's
anopodId against the session's), the time under it, and at the right
the colored thumb icon with "12 votes". "No votes yet." under an empty
heading once its list answered; a refused list in red under its heading.
The Home line "2 proposals open for your vote" is in the Home paragraph
above.

Guardians (2026-11-08, section 11; the plan is
forclaude/wallet-guardians-plan-1.md, the validator's reads anossoftware
spec 25, the doorman's lines doormansoftware spec 7): where the fund's
proposals and the guardians' votes are seen and acted on, three screens
under the DAO page, two of them step 3 and the third step 4. The guts are
the validator's as they were (the fundProposal transaction, the
guardianVote follow-up, the tally in the leader round: one vote per
GUARDIAN_VOTE_ANOS staked for guardian, the vote open for
GUARDIAN_VOTE_MINUTES, passed at GUARDIAN_VOTE_PERCENT of the votes for);
what is new is the reading side, two public reads built like
/list-dao-stakes, /list-fund-proposals and /get-fund-proposal (5.4), and
the two stake fields of /get-account. The data comes from the session's
validator (8.3; the wallet's defaultValidator until 2026-11-10) through
its doorman and the proxy, never from the
masterpod. Everyone signed in may look; an account with at least one
guardian vote acts, and every guardian account of the pod acts on its own
with its own weight, since the validators count guardian stake per
account and never per pod (a pod with two staked spending accounts votes
from each). Guardians and recipients are shown by account id in short
form, "a1b2c3d4…e5f6", with a copy button, as the history and the Home
lines show accounts: the validators know account ids only, and a username
lookup by account id is a later step. Every number in the words
(1,000 anos per vote, 70 percent, 60 minutes on the testnet and a week in
production, the 1,000 anos least stake) comes from the `settings` the
validator answers with every read, never from the wallet.

Guardians, at /dao/guardians (step 3), in the frame of the DAO page: a
header with a back arrow to /dao, "Guardians", a Refresh icon button and,
on a desktop, a New proposal button (a round + at the bottom right on a
phone); the notice, an info icon and one paragraph in the plain muted
style on a surface-container background with 12 px corners, never the
error container, once the first list answered: "Fund proposals come from
guardians, people who staked anos for guardian. One vote per 1000 anos
staked. A guardian proposes payments from the fund, and the guardians
vote for or against for 1 hour. The proposal passes when at least 70
percent of the votes are for, and the next round moves the money." (the
time through the dictionary's `minutes`, so 10080 reads "7 days"); then
"Your guardian accounts": when the page opens and on Refresh, /get-account
for each of the pod's accounts, quietly, signed by pair one opened from
the keyBlob and dropped (guardian-accounts.service, 8.3), "Reading…"
meanwhile; the accounts whose guardianVotes is at least 1, as the short
id with a copy button and "3 votes" ("1 vote" at one), the one with the
most votes first; with none, "None of your accounts has guardian votes. To
become a guardian, stake 1000 anos or more for guardian from a spending
account, on its page in the Wallet." with the least stake from the
settings and a Wallet button to /wallet (nothing under the heading while
the settings are unknown: the refusal under the tab says why). New
proposal is enabled with a guardian account and no proposal in the Open
vote tab; a refused list leaves it enabled, since the validator refuses
with words. Two tabs. Open vote reads /list-fund-proposals { status:
'open' } when the page opens and on Refresh: one card at most (the fund
holds one proposal), or "No fund proposal is open.". Decided reads {
status: 'decided', limit: 20, offset } when it is first shown and on
Refresh, newest first, Show more reads 20 more by offset while the last
page came back full, and has a date range above its cards as the DAO's
Decided tab (both days picked, or both cleared, read again; from at the
start of the first day, to at the start of the day after the last, on
the decision's moment); "No fund proposal has been decided yet." when
nothing came back. Refresh forgets both tabs, reads the one on screen
again and the accounts again. The cards, one column on a phone and two on
a desktop: "Fund proposal" and the short id in bold; "proposed by
a1b2c3d4…e5f6 · Nov 8, 2026" (the date without the time); "2 payouts ·
1500 anos" ("1 payout" at one), the count and the sum the validator
answers; then the state line: open, "For 5 · Against 2", a progress bar
of for over for plus against, "needs 70 percent for · closes Nov 8, 2026,
4:50:12 PM"; waiting, "Waiting for the validators"; closing, "Vote closed,
waiting for the next round"; decided, the status as a small label,
"Passed, the money moved" in green or "Failed" in red (a status the
wallet does not know shows its own word, neither colour), "For 5 ·
Against 2" and "decided Nov 8, 2026, 5:00:00 PM". Under it, "You proposed
this" with the green thumb_up when the proposer is one of the caller's
guardian accounts, or "You voted for" / "You voted against" with the
green thumb_up or the red thumb_down when one of them is in the votes
(the biggest account's vote when they differ). The green is #2e7d32 and
the red var(--mat-sys-error), as on the DAO page. A card opens
/dao/guardians/<id>. A refused read in red under the tab
("/list-fund-proposals: HTTP 404: Not Found" against a validator or a
doorman without the route), and the rest of the wallet works.

New fund proposal, at /dao/guardians/new (step 3), in the frame of the
DAO's New proposal page: a back arrow to /dao/guardians; "Proposing as", a
select of the caller's guardian accounts read as the Guardians page reads
them, each option the short id and "3 votes", the biggest first and
selected (a proposal is one transaction signed by one account; with one
guardian account the select has one option; without one, the
become-a-guardian sentence and Post stays disabled); the payout rows, the
form that left the account page, each in an outlined box: Recipient
account id (64 hex characters, with the paste button Send has, which
takes the run of 64 hex characters on the clipboard and says under the
box when the browser refused or nothing there looks like an id), Amount
(anos), Reason, Returns stake (no, or one of the six purposes) and a
remove button, disabled on the last row; Add payout; the rule once the
settings came, read quietly with /list-fund-proposals { status: 'open' }
when the page opens, which also tells whether a proposal is open: "The
guardians vote for 1 hour. The proposal passes when at least 70 percent
of the votes are for; your own votes count as the first votes for. One
fund proposal can be open at a time."; Post proposal, disabled while
busy, without a guardian account, or while a proposal is open, "A fund
proposal is already open. Wait until it is decided." shown as the reason
(a refused quiet read shows in red instead, and Post stays enabled: the
validator refuses with words). Post checks each row ("Payout 2: the
recipient must be an account id of 64 hex characters", "Payout 2: the
amount must be anos with up to six decimals"; the recipient lower-cased,
the amount as millionths, the reason trimmed, stakeFor only when picked),
opens pair one of the chosen account for the signature and drops it,
builds the fundProposal (crypto.buildFundProposal: the fund as accountId,
the chosen account as guardianId, no previousTransactionId), has /api/sign
add the wallet pair and posts /fund-proposal; a 202 opens
/dao/guardians/<transactionId>. The refusals in words: "a fund proposal is
already open" (the validator's held check), the sentence above; "the
proposer has no guardian vote", "This account has no guardian votes.";
the rest "/fund-proposal: HTTP 400: payload.payouts[0].reason must be a
string" and the like.

Fund proposal, at /dao/guardians/:transactionId (step 4, 2026-11-08,
section 11), in the frame of the DAO's Proposal page: a back arrow to
/dao/guardians and a Refresh icon button; /get-fund-proposal when the
page opens, after each action and on Refresh, "Loading" until the first
answer, "This proposal does not exist." on the validator's 404 unknown
proposal, any other refusal in red ("/get-fund-proposal: HTTP 404: Not
Found" against a validator or a doorman without the route). Top to
bottom: the status as a small bordered label, the five words of the
Guardians page's cards, "Passed, the money moved" in green and "Failed"
in red (a word the wallet does not know as it is, no colour); "Fund
proposal a1b2c3d4…e5f6" as the heading with a copy button for the id;
"proposed by a1b2c3d4…e5f6 · Nov 8, 2026" (the date without the time);
the payouts, one row each in the validator's index order: "1500 anos to
a1b2c3d4…e5f6" with a copy button for the recipient, the reason under
it when there is one, and "returns guardian stake" (the purpose's wire
word, as the notice says "for guardian") when the payout returns stake;
then the total line, "2 payouts · 1500 anos" ("1 payout" at one); the
numbers: "For 5 · Against 2", in large type while the vote is open, with
the progress bar of for over for plus against and "needs 70 percent for
· closes Nov 8, 2026, 4:50:12 PM" on an open proposal; the tally and the
needs and closes line on a waiting one (the label at the top says it
waits for the validators); the tally alone on a closing one; the tally
and "decided Nov 8, 2026, 5:00:00 PM" on a decided one (the label at the
top is the result). Your part (the plan's decision 8: every guardian
account of the pod votes, one at a time): "Reading…" while the pod's
guardian accounts are read (guardian-accounts.service, 8.3, as the
Guardians page reads them); with none, the become-a-guardian sentence of
the Guardians page with the least stake from the settings and no select;
else "Voting as", a select of the guardian accounts, each option the
short id, "3 votes" and its state, "You proposed this", "You voted for"
/ "You voted against" or, while the vote is open, "can vote" (nothing
for an account that neither proposed nor voted on a proposal that is
not open); the first account that can still vote is selected when the
page opens, the first in the list when none can (with one guardian
account the select has one option). Under the select the selected
account's state: "You proposed this" with the green thumb_up, "You voted
for" / "You voted against" with the colored thumb, or, while the status
is open and the account is neither the proposer nor in the votes, two
big outlined buttons side by side, the green thumb_up "For" and the red
thumb_down "Against", the DAO page's pair; either asks in place, "Vote
for with 3 votes from a1b2c3d4…e5f6? It cannot be undone." with "Yes,
vote for" and Back (a new pick in the select closes the question, which
named the account). Yes opens pair one of the selected account from its
keyBlob for the signature and drops it, builds the guardianVote
follow-up (crypto.buildFollowUp: type guardianVote, the proposal's
transactionId, the account as guardianId, the vote), has /api/sign add
the wallet pair and posts /guardian-vote; a 202 shows "Your vote for is
sent to the validators." in green (the thumb green, #2e7d32) and reads
the proposal again, where the vote shows as waiting for approval until
every validator accepted it, and the select moves to the next account
that can still vote, so the next vote is one pick away (it stays when
none can). The refusals in words, matched on the validator's own text
(anossoftware src/fund/guardian-vote.js): "the vote on this proposal has
closed", "The vote on this proposal has closed." with the proposal read
again; "this guardian has already voted on this proposal", "This account
already voted."; "the guardian has no guardian vote", "This account has
no guardian votes."; "payload.guardianId is the proposer, whose vote for
is already counted", "You proposed this"; the rest with the path,
"/guardian-vote: HTTP 400: payload.vote must be …" and the like. Below,
a heading "Votes": the first row the proposer, the short id with a copy
button (tagged "you" when it is one of the pod's accounts), the time the
proposal was made under it, and at the right the green thumb_up with
"proposer · 3 votes for" (proposerWeight, the proposer's votes when the
proposal was stored); then one row per vote in the validator's order
(guardian id order): the short id with a copy button and the "you" tag
on the pod's own, "approved" or "waiting for approval" and the time
under it, and at the right the colored thumb with "3 votes"; "No votes
yet." under the proposer alone. Refresh reads the proposal and the
guardian accounts again and clears the two messages. The green is
#2e7d32 and the red var(--mat-sys-error), as on the DAO pages. The Home
line "A fund proposal is open for your vote" is in the Home paragraph
above.

Notifications: the list, newest first, mark read; the 5-second poll
runs while a session is open and updates the status (vouched, counts),
and the chat rooms with them once setup is complete. The chat kinds
link: chatInvite and joinRequest to /chat/requests; inviteAccepted,
inviteDeclined and joinApproved to the room, /chat/:chatRoomId
(2026-11-05, section 11). The kind recoveryCaseScheduled (2026-11-12,
section 11; masterpod 14.7), which the masterpod writes to the person
when an attestor sets up the video call of their recovery case, reads "A
video call was scheduled for your recovery" and links to the person's
recovery case page, /cases/recovery/:caseId (13.3): its reference id is
the case id.

Seed: the Vouch requests page, for a seed or super seed (2026-11-08,
section 11). One small call, /list-vouch-requests, answers the open
requests without pictures, so the seed sees every card at once; until
that first answer the list's place shows a spinner and "Fetching…",
never again after it. Each card shows the requester's avatar (8.6), the
picture read through the profile cache (8.3) five at a time, the letter
disc until it arrives. Approve and Decline disable only their own card's
two buttons, so several can be approved back to back; on success, or on
a 404 (the request was handled from another device), the card goes and
nothing is fetched again; any other refusal stays on the card as its
reason. A quiet 5-second poll (VOUCH_REQUESTS_POLL_MS) re-reads the list
while the page is open, skipped while a read is in flight, and its
answer never brings back a request handled on this page since it opened.
Refresh is the manual retry after a page-level error.

Log: the test apps' call log, newest 40, path, status and answer, polls
excepted, with the keyholder and anos calls included.

### 8.3 Services and state

    config.service          GET /api/config once; the counts, the threshold, the edition, rpId and the three lock
                            numbers (2026-11-06)
    language.service        the language on screen (Thai when the browser's first language is Thai, else
                            English; English for the tab after Switch to English), words, tag, dateTime and
                            time; sets the page's lang, the date adapter's locale and Material's Optional
                            (2026-11-06)
    session.service         signals: anopodId, username, firstName, lastName, the session keys, the PRF output
                            while needed and the key blob key derived from it (2026-11-08), the encryption key,
                            the chat keys, the PLID and lookup id, the status
                            from /check-anopod-status, the keyholder receiving keys, the wallet public keys, the
                            accounts (keyBlob ciphertext and creation, never open keys), the chat rooms (the
                            latest /list-chat-rooms answer), the seen positions with markSeen and the unread
                            rooms (2026-11-05); the next-step rule
    masterpod-api.service   the keyholder test app's api.service.ts, base path /api/masterpod, the two changed
                            routes and the four new ones added; the marketplace routes of 2026-11-06: getListing,
                            listingId on createChatRoom, mine and status any on listListings, no hpkeKey on
                            createListing, the fuller RoomListing and the listing on an invite; the four noted
                            transaction routes and the two settings routes (2026-11-07); listMyBreakGlassMoves
                            and fileBreakGlassMoves (2026-11-08), storeBreakGlassBlob gone; the six DAO routes of
                            masterpod 15 (2026-11-08): createDaoProposal, supportDaoProposal, voteDaoProposal,
                            listDaoProposals (with the quiet flag), getDaoProposal and listDaoVotes, with the
                            types DaoStatus, DaoListStatus, DaoSettings, DaoListFilters, DaoProposalItem,
                            DaoProposal and DaoVoteItem; the case chats (2026-11-12, section 11): the type
                            CaseKind (trade, dispute or recovery), caseId and caseKind on RoomItem and on
                            InviteItem (a masterpod of before sends neither, and a missing one reads as null),
                            and a fifth optional parameter of createChatRoom, caseId, put into the body when
                            given
    keyholder-api.service   the keyholder test app's, base path /api/keyholder/<n>
    anos-api.service        the anos test app's account-api.service.ts, base path /api/anos/<the session's
                            validator> (2026-11-10, below; /api/anos/<defaultValidator> until then),
                            plus the five signed reads (listEscrows added 2026-11-05, getAssistedTransfer and
                            getLockedTransfer 2026-11-06; listTransactions takes from and to, 2026-11-06);
                            getAccountAs, the /get-account read with an envelope the caller signed, the
                            break-glass pair's at the recovery's finish (2026-11-08), and getAssistedTransferAs,
                            the same for /get-assisted-transfer (2026-11-10, 12.4); the two public fund
                            proposal reads of anossoftware 25 (2026-11-08), listFundProposals(filters, quiet)
                            and getFundProposal(transactionId, quiet), each a plain unsigned post with the
                            object body and no envelope, the wallet's first unsigned posts to a validator, with
                            the types FundProposalStatus, FundSettings, FundVoteItem, FundPayoutItem,
                            FundProposalItem, FundProposal and FundListFilters; AccountAnswer carries the
                            optional stakes and guardianVotes of /get-account (5.4);
                            the session's validator (2026-11-10, section 11): the wallet talks to one validator
                            per session, a session being one load of the wallet in a tab, so a reload picks
                            again; the first call picks it at random (Math.random) from 1 to the validators of
                            /api/config, and every call goes to it, since the wallet reads an account and then
                            builds a transfer on what it read and a balance refresh makes several reads at the
                            same moment; validator() answers it, picking it when none is set, for the attestor
                            case pages (13.3); no answer is status 0 (the network failed, or a read ran into
                            its time limit), 502 (the proxy's "validator n unavailable", a doorman's "worker
                            unavailable"), 503 (a just booted validator's "not counted yet") or 504 (a
                            doorman's "worker timeout"), and every other status is an answer, a refusal and a
                            500 included; with no answer the session moves to the next validator in the list,
                            the first after the last, and stays there, by one place however many calls got no
                            answer from that validator at the same moment; the nine reads (read: /get-account,
                            /list-transactions, /list-escrows, /get-assisted-transfer, /get-locked-transfer,
                            /list-assisted-transfers, /list-disputed-escrows, /list-fund-proposals,
                            /get-fund-proposal) wait at most VALIDATOR_READ_TIMEOUT_MS, 10 seconds
                            (constants.ts), and with no answer are asked again on the next validator, each
                            validator at most once per call, the last failure returned when none answers; the
                            nine submissions (write: /create-account, /anos-transfer, /transfer-to-fund,
                            /fund-proposal, /attestation, /assisted-transfer-cancel, /locked-transfer-cancel,
                            /guardian-vote, /escrow-signature; eight until 2026-11-11, when
                            lockedTransferCancel, the post of a locked transfer's cancel, was added, section
                            11) are tried once, with no time limit, and never sent again by the
                            wallet on its own, since one that got no answer may still have been taken: the
                            session moves on, the failure is shown as before, and the person's next try goes
                            to the next validator
    guardian-accounts.service
                            the pod's guardian accounts (2026-11-08): read(quiet), /get-account for each of the
                            session's accounts at once, quietly, signed by pair one opened from the keyBlob and
                            dropped, answering the accounts whose guardianVotes is at least 1, the biggest
                            first (an account that is lost, not landed, refused or on an older validator is
                            left out); pairOne(accountId), pair one of one of the session's accounts for one
                            signature; what the Guardians page, New fund proposal and the proposal page share
    balances.service        what Home and the Wallet page share (2026-11-06): one entry per account (landed,
                            balance, what is pending, in escrow, assisted or locked, held, available, partial,
                            and guardianVotes as /get-account answers them, 0 while not landed or on a validator
                            without the field, which Home's fund proposal line reads, 2026-11-08; since
                            2026-11-10, for the balance card and its sheet (8.2, Wallet): stakes, the account's
                            stake per purpose in millionths, the purposes above zero only, from stakes of the
                            same /get-account answer (5.4), empty when the answer has none; staked, their sum;
                            and the held items as the reads answered them: escrows, the open trades the account
                            sells in, the ones counted in escrow; assistedTransfer and lockedTransfer, the held
                            transfer or null; pendingTransfers, the pending rows)
                            read by refresh from /get-account, /list-transactions, /list-escrows and the
                            held-transfer read of the account's type, every account at once; the totals over
                            the session's accounts, staked among them since 2026-11-10, while total stays what
                            the accounts hold on the ledger; an entry that is not on the ledger or is lost
                            carries the empty values; needsPoll while an account is not on the ledger yet or
                            any anos are held or pending; a lost account (2026-11-08: its keyBlob does not open
                            under the session's key blob key) gets the lost entry and counts in no total and no
                            poll, isLost and usableAccounts tell the pages and the pickers, markLost tries every
                            keyBlob whenever the account list changes, and the lost accounts' break-glass moves
                            (moves, moveOf, loadMoves over /list-my-break-glass-moves and the new account's
                            history) are read with the balances; since 2026-11-11 (section 11) two reads:
                            refresh(quiet), the full read, every account, and poll(), one round of the 5-second
                            read Home and the Wallet page make while needsPoll, which reads the watched accounts
                            only (the session's accounts that are not lost and have no entry yet, an entry that
                            is not on the ledger, or anos held or pending: needsPoll's test, per account), at
                            the same time, quietly and under busy; a round returns at once while a read runs,
                            reads nothing with no watched account, and is a quiet refresh for another pod than
                            the one last read; after a round's reads a full read follows in two cases: the round
                            changed landed, balance or held in a watched account's entry and the session has an
                            account that is not lost and was not read in the round (a move between two of the
                            person's own accounts), or a full read was asked for during the round: refresh
                            leaves word when it finds a round running, where it returns when it finds another
                            refresh running, and the round runs that read when it ends, quiet only when every
                            refresh that left word was quiet; otherwise the round ends as refresh ends, the lost
                            accounts' moves when an account is lost, then readAt
    balance-sheet.component not a service: the component the balance card opens with MatBottomSheet
                            (2026-11-10; components/balance-sheet.component.ts, `BalanceSheetComponent`, the
                            data { kind }: available, staked, escrow or sending), listed here because it reads
                            balances.service, the session's accounts and their names itself, as the card does,
                            and so follows a refresh while it is open (8.2, the balance sheet); its file also
                            holds BALANCE_KINDS, the card's rows in order, and balanceLine(kind, totals, words),
                            a kind's label and amount, which the card's rows and the sheet's title share
    notes.service           the noted transactions (2026-11-07): the last list read with its blobs opened,
                            byTransaction, add, update and remove, the preset kind and the starting currency
    settings.service        the wallet settings (2026-11-07): one encrypted object on the masterpod (4.7), read once
                            per session (Home, quiet) and saved whole (setup's Continue, the protect page's Save)
    navigation.service      the one navigation list (2026-11-06): NavItem (path, label, icon, badge) and items,
                            the side panel's entries by the status and the edition, Home first once setup is
                            complete, Chat and Notifications with their unread counts; the side panel and the
                            Home tiles both draw it; DAO after Marketplace and before Account (2026-11-08);
                            Moderation and Attesting with the counts of work-badge.service, the next line
                            (2026-11-12, section 11)
    work-badge.service      the numbers on the Attesting and the Moderation entries (2026-11-12, section 11; 8.1):
                            attestingIds and moderationIds, the ids of each page's things, and seen, the ids this
                            device has seen, { attesting, moderation }, kept in localStorage under
                            `anopod-wallet.work-seen.<anopodId>`, each list cut to its newest 500, read when a
                            pod opens and emptied when the session closes, empty when the browser refuses;
                            attestingCount and moderationCount, how many of a page's ids are not seen, which
                            navigation.service puts on the two entries; a timer of CASES_POLL_MS (15 s) and one
                            read as soon as a session with setup complete is there, each with a session and
                            setup complete: in the attestor edition, unless the address starts with /attesting,
                            attesting.service's loadAccounts and, with an account picked, loadLists and
                            /list-break-glass-cases for open and inReview, each in its own try; in the moderator
                            edition, unless the address starts with /moderation, /list-recovery-cases for open
                            and inReview; all quiet, and a read that fails leaves its part of the ids as it was
                            and shows nothing; the Attesting ids are the transaction id of every
                            assistedAnosTransfer of the trade list, the transaction id of every disputed escrow
                            and the case id of every recovery case read, the Moderation ids the case ids;
                            seeAttesting(ids) and seeModeration(ids), which a page's own load calls with the ids
                            it read: they become the page's ids and are all marked seen; attestingWorkIds and
                            openCaseIds, the rule as two functions, which the two pages share with the timer
    chat.service            what the chat pages share (2026-11-05): room keys (roomKeyOf, wrapFor), decryptMessage,
                            piecesOf, a room's title, kind, icon and other person, the order by activity, shortWhen,
                            timeOf and dayLabel, requestedRooms, refreshRooms; listingWords, a listing in a few
                            words for a title or a request (2026-11-06); the case chats (2026-11-12, section
                            11): the title of a room about a case; caseRoomWith(caseId, anopodId), the
                            attestor's side: the room about the case that this pod created with the person in
                            it, a member first, else invited, and when there is none the newest room about the
                            case that this pod created with no member but this pod and nobody invited, the
                            room of a person who declined, else null; caseRoomsOf(caseId) and
                            caseInvitesOf(caseId), the person's side: the rooms and the invites about the
                            case; startCaseChat(caseId, anopodId), the Message someone flow of New chat with
                            the case, which answers the refusal of the call that failed, else the invite's
                            answer; inviteAgain(room, anopodId), for a person who declined: wrapFor, the
                            invite, the rooms refreshed; the attestor in a marketplace chat (2026-11-12,
                            section 11, step 6): isTrader(room), a private room about a listing whose creator
                            or whose listing's owner this pod is; otherTrader(room), for such a room the other
                            of the two, found among the members and the invited, else null;
                            caseAttestors(caseId), the creators of this pod's rooms about the case that another
                            pod created, each once, as the room lists its members (id and username)
    marketplace.service     what the marketplace pages share (2026-11-06): load, get, mine and close (the reads
                            and the close), sideWords, mySide and firstWords, the rooms and invites about a
                            listing out of session.chatRooms (roomsAbout, myRoomAbout, invitesAbout,
                            waitingCount), stateOf, connect and connectAgain, and the country and currency this
                            device remembers (remembered, remember)
    profile-cache.service   one /get-anopod-profile per pod per tab, quiet, as a signal: undefined while it loads,
                            null when there is no such pod (2026-11-05); at most PROFILE_READS_AT_ONCE (5) reads
                            in flight, the other ids queued, so a page with many faces gets them a few at a time
                            (2026-11-08)
    signing.service         /api/sign/public-keys and /api/sign
    crypto.service          the keyholder test app's crypto.service.ts plus the anos test app's (keys, the
                            builders, signing), plus section 7 and the public ledger id; wrapJson and
                            unwrapJson (2026-11-07); deriveKekKeys, the key blob under it and KeyBlobLostError
                            (2026-11-08); the break-glass transfer and the account envelope signed by the
                            break-glass pair (buildBreakGlassTransferTransaction, signAccountEnvelopeAsBreakGlass,
                            2026-11-08); the follow-up payloads that buildFollowUp signs, FollowUpPayload:
                            AttestationPayload, AssistedTransferCancelPayload, LockedTransferCancelPayload
                            (2026-11-11, section 11), GuardianVotePayload, EscrowSignaturePayload and
                            EscrowVerdictPayload
    passkey.service         the keyholder test app's, unchanged
    shares.service          the deposit rule of section 6, one function: deposit(secret, shareType)
    account-creation.service
                            opening an anos account (2026-11-08): createAccount(type, onStep) runs the six steps
                            of 8.2 Wallet (the keys and the creation, the seed's deposit, the signing server,
                            /create-anos-account, /create-account, /mark-anos-account-submitted), reads the list
                            and the balances again after steps 4 and 6, then waits up to 90 seconds for
                            /get-account to answer with the new pair one; resolves { accountId, pairOne };
                            at step 4 the masterpod's 403 account limit reached (4.4) is thrown as the sentence
                            wallet.accountLimit, every other refusal as the route and its reason (2026-11-10);
                            submitCreation runs steps 5 and 6 alone, for Resubmit; ALREADY_THERE, the validator's
                            "already there" wording, the holding tables' included; used by the Wallet page and
                            the recovery finish's Move your money (12.3)
    log.service             the activity log

Keys are regenerated from blobs at each unlock; nothing secret touches
localStorage, sessionStorage or IndexedDB.

### 8.4 The camera component

One component for the selfie, the recovery photos and any photo: when
getUserMedia is available it shows the live camera (facingMode from a
facing input, user by default or environment for the back camera, which
the ID steps use; width and height ideal from a quality input: normal
1280 by 720, high 1920 by 1080), a Take photo button, the frame drawn to
a canvas and encoded as JPEG (quality 0.92 normal, 0.95 high), preview,
Retake. Below it always a file input, accept image/*, with capture set to
the same facing so a phone offers that camera, as the fallback when the
camera is refused or absent. The output is { contentType, bytes } for the
caller to encrypt or send. Since 2026-11-08 (section 11) a chosen file
whose longer side exceeds the quality's width (1280 normal, 1920 high) is
scaled so that side is the width, the aspect kept, and encoded as JPEG at
the quality's factor (0.92, 0.95), the size and quality a photo from the
live camera has, before anything else is done with it. Since 2026-11-12
(section 11) a smaller file is redrawn too, at its own size, as a JPEG at
the same factor, so every chosen file goes out as its pixels and nothing
else, with the type `image/jpeg`; a file the browser cannot read as a
picture is refused with a line under the file input, and nothing is
emitted.

### 8.5 The copy button

One small component, src/app/components/copy-button.component.ts
(`<app-copy-button>`), for every account id a person may want to share
or paste (2026-11-05, section 11): an icon button that copies the text
it is given (navigator.clipboard.writeText) and shows "copied" next to
the icon for two seconds, or "could not copy" when the browser refuses.
It sits after the account id in the Account title, in the footer of each
account card on the Wallet page (2026-11-06, section 11), after an
account id in a chat message, and in a history row's details beside the
other side's id and the transaction id (2026-11-06). The case pages of
sections 12 and 13 keep their own copy code.

### 8.6 The avatar

One small component, src/app/components/avatar.component.ts
(`<app-avatar>`, inputs `anopodId`, `username` and `size`, 40 by default;
2026-11-05, section 11): a round selfie when the pod's profile has one,
else a round disc in the primary-container colour with the first letter
of the username. The profile comes from profile-cache.service (8.3), one
/get-anopod-profile per pod per tab. In the chat list, the conversation
header, the members panel and the chat requests; since 2026-11-06 also on
the listing cards (24 px), the listing page (56 px), the people who
connected and the pinned listing card (8.7), and on Home beside the
greeting (56 px); since 2026-11-08 on the cards of the Vouch requests
page (72 px) and beside the proposer on the DAO proposal page (40 px);
since 2026-11-12 (section 11) in the person's chats about an attestor
case on My case and My recovery case (8.7), and beside each attestor in
the conversation's "Invite an attestor" panel (8.2, Chat; 40 px).

### 8.7 The marketplace components and the case chat components

Five small components (2026-11-06, section 11), under
src/app/components/:

- listing-card.component.ts (`<app-listing-card [listing]>`): the card of
  Browse and Your listings, a link to the listing's page. Line 1 in bold,
  "35.50 THB per anos"; line 2, "Selling 100 anos · 3,550 THB"; line 3,
  the owner's avatar (24 px), username, country name and the short time
  of the chat list (shortWhen). Small labels when so: Yours, Closed,
  Waiting (this pod's room about it, the owner not yet in), Chat open
  (the owner in).
- listing-people.component.ts (`<app-listing-people [listing]
  (changed)>`): the owner's block of the listing page and Your listings:
  the people waiting (the invites to this pod about the listing: avatar,
  "somchai wants to chat", Accept, which calls /accept-invite and
  refreshes the rooms, and Decline), then the chats (the rooms about it:
  avatar, username, Open chat to /chat/:chatRoomId); "Nobody has
  connected yet." when both are empty. Live from session.chatRooms;
  `changed` fires after an answer so the listing page reads its listing
  again.
- picker-sheet.component.ts (`PickerSheetComponent`), opened with
  MatBottomSheet for a country or a currency, on Browse and on the
  new-listing form: a title, a search box, "Any" on top when the sheet
  allows it, the options `{ code, name }` whose code or name contains the
  typed letters; tapping one closes the sheet with the code. Without any
  option (a browser that does not know the currencies) a typed
  three-letter code can be used as it is.
- filters-sheet.component.ts (`FiltersSheetComponent`): the quantity
  range (least and most anos) and the price range (least and most,
  disabled with the hint "Pick a currency first" while Browse has no
  currency), Apply and Clear.
- pinned-listing.component.ts (`<app-pinned-listing [room]
  [accountIds] (disputeCase)>`): the pinned card of a private room about a
  listing (8.2, Chat), drawn by chat-room.page.ts under its header, above
  the thread.
  `accountIds` is the page's computed of the account ids found in the
  decrypted messages (the 64-hex pieces of `piecesOf`), each with its
  sender and position, newest first; the page changes only to draw the
  card and feed it. The card posts its own messages (Share an account,
  Escrow trade started and, since 2026-11-10, Escrow trade released, the
  last two from its check) encrypted with the room key, and the thread's
  poll shows them. It exports `FoundAccountId`. Since 2026-11-10 the card
  also reads the room's messages itself for their account ids (8.2,
  Chat): the page's computed holds the ids of the newest 50 messages and
  of what arrived since, which is not the whole chat. Since 2026-11-12
  (section 11, step 6) the card is drawn for the room's two traders only
  (chat.service's `isTrader`, 8.3) and goes by the other trader: `other`,
  whose avatar and username the card shows, is `otherTrader(room)`, the
  other of the room's creator and the listing's owner, and the form's To
  list takes the account ids that trader posted, so a guest's messages
  never feed the trade form. Only when the other trader is neither a
  member nor invited any more does the list take the ids anyone else
  posted, as before. The card also finds the dispute case of its trade,
  as the escrow trade page does: on a check that shows the chat's trade
  in the stage `disputed` while no case is known, /list-my-cases, quiet,
  and of its disputes the one with the trade's transaction id whose
  status is open or inReview. The output `disputeCase` gives the page
  that case's id, for "Invite an attestor" (8.2, Chat), and null when the
  chat has no open trade, when the trade is not disputed and when no such
  case is there; it fires when the value changes. A case found stays
  until the trade is no longer disputed.

Two more small components, for the chat on an attestor case (2026-11-12,
section 11; the plan is forclaude/wallet-case-chats-plan-1.md), under
src/app/components/ too:

- case-chat-start.component.ts (`<app-case-chat-start [caseId] [person]
  [open]>`): the attestor's button on the three attestor case pages
  (13.3), under the person's facts. `person` is the profile the case page
  has (its `anopodId` and `username`), or null, which draws nothing;
  `open` is false on a closed case. It goes by chat.service's
  `caseRoomWith` (8.3), live from session.chatRooms. No room: a stroked
  Start chat, shown while `open`, which runs `startCaseChat`. A room with
  the person invited: Open chat, a link to /chat/:chatRoomId, and the
  muted line "somchai has not accepted the chat yet." A room with the
  person a member: Open chat. A room the person is not in: the muted line
  "somchai did not accept the chat." and, while `open`, Invite again,
  which runs `inviteAgain`. Start chat and Invite again are off while one
  of them runs and without chat keys, and then "No chat keys in this tab:
  unlock again." shows. A refusal shows in red under the button: the
  masterpod's `403 not an attestor` as "This anoPod is not an attestor.",
  the rest as the masterpod says it.
- case-chat-list.component.ts (`<app-case-chat-list [caseId]>`): the
  person's block on My case and My recovery case (13.3), in the shape of
  listing-people.component.ts. The invites to this pod into a room about
  the case (`caseInvitesOf`): the attestor's avatar (8.6), "attestorjoy is
  an attestor on this case and wants to chat with you", Accept, which
  calls /accept-invite, refreshes the rooms and opens /chat/:chatRoomId,
  and Decline. Then the rooms about the case (`caseRoomsOf`): the avatar
  and username of the room's creator, who is the attestor, and Open chat.
  "No attestor has started a chat with you about this case yet." when
  both are empty. Live from session.chatRooms.

### 8.8 The languages

The app speaks two languages, English and Thai (2026-11-06, section 11;
the plan is forclaude/wallet-languages-plan-1.md). English is the
default: the language is Thai when the browser's first preferred
language (the first entry of navigator.languages, else
navigator.language) begins with "th", else English; nothing is stored.
One button, "Switch to English", always in those English words, under
the landing card while the app is in Thai: after it the app is English
for as long as the tab lives, like the unlock itself, and a new tab
follows the browser again. There is no button to Thai and no language
toggle anywhere else.

The words live in a dictionary, src/app/i18n/en.ts and th.ts, no
package: one section per page or component, `common` for the sentences
several pages share, `dates` for the day words, `material` for
Material's visible word "Optional". `Words` is the English object's
shape and th.ts must match it, so a sentence missing in Thai fails the
build. A sentence with a number, a name, an amount, a date or an id in
it is a function, so each language keeps its own grammar (English its
plurals, Thai none). language.service (8.3) holds the language in a
signal; a page reads `t = this.lang.words` and writes `t().page.key`,
a sentence with a variable as `t().page.sentence(n)`. The page's `lang`
attribute follows the language, so Chrome sees a Thai page as Thai and
does not offer to translate it; nothing is blocked and nothing is
marked untranslatable. Dates and times go through the service's
dateTime ("Nov 6, 2026, 3:50:12 PM"; "6 พ.ย. 2026 15:50:12") and time
("3:50:12 PM"; "15:50:12"), or pass its tag to the browser's own
formatting: en-US, and th-TH-u-ca-gregory for Thai, so a Thai date
reads with Thai month names and the Western year, never the Buddhist
one; "Today" and "Yesterday" come from the dictionary; the date
pickers' calendar and Material's "Optional" follow the language.

The English on screen does not change: every English sentence moves
into en.ts letter for letter, and this spec's descriptions quote it.
In both languages these stay as they are: the messages of the servers
(the validators, the doormen, the masterpod), shown inside the Thai
page as they come, and the wallet's pattern checks on them; every wire
word, id, code, path, field name and key ("Send guardedAnosTransfer",
"Fund proposal transactionId"); the product names, in Latin letters
(anoPod, anos, anoSphere, masterpod, seed, super seed, PRF); the
browser tab's titles; Material's screen-reader labels ("Open calendar"
and the like); the developer-worded errors of crypto.service.ts; the
test-site notice's two paragraphs, English and Thai, whatever the
language on screen (only its headline follows it). Every edition
speaks both languages, the staff pages of the moderator and attestor
editions too. The Thai was written by the build chat from the plan's
style and glossary, for Thai readers to correct; a correction is an
edit of th.ts.

The pages done so far, a list the later steps extend:

- step 1 (2026-11-06): the shell (the toolbar), the navigation (the
  labels of the side panel and the Home tiles), the landing page.
- step 2 (2026-11-06): the create stepper, the vouching page, the
  identity page and its form, the setup page, the seed page, the
  notifications, the log; the camera and the copy button; the services'
  own sentences (the passkey ceremonies, the deposits, the signing
  server, the no-session answer of the two API services, the log's
  network error); the country names, in the identity form and the
  marketplace.
- step 3 (2026-11-06): Home, the Wallet page, the Account page and the
  recovery walkthrough, the balance card, the balances service and the
  account names.
- step 4 (2026-11-06): the account page, the transaction history, the
  escrow trade and the assisted transfer, with the stage words, the
  history words, the minutes in words and the chat's day and time words.
- step 5 (2026-11-06): the chat: the list of chats, the new chat, the
  requests and the conversation, with the room titles and the listing
  words of the chat service.
- step 6 (2026-11-06): the marketplace: Browse, the listing, the new
  listing and Your listings, with the five components (the card, the
  people, the pinned card, the filters and the picker sheets), the
  marketplace service's words and the currency names.
- step 7 (2026-11-06): the recovery flow (the Recover page, the
  locked-out stepper, My recovery) and the cases (the list, My case),
  with the case statuses.
- step 8 (2026-11-06): the moderation page and its case page, the
  attesting page and its trade and dispute case pages, with the
  attesting service's words. Every page of every edition is done.

Later changes add their words to the section of the page they change, in
both files at once: the Protect your passkey pane of setup, in `setup`
(2026-11-07, section 11); the note form and the notes of the history
page, in `notes` (2026-11-07, section 11); the Noted transactions page,
in `notes`; the protect page and the Home line, in `common` and `home`.
The DAO page, the New proposal page and the proposal page (2026-11-08,
section 11) take their words from `dao` and `daoNew`, with `nav.dao`,
like every page, and Home's "2 proposals open for your vote" its words
from `home` (2026-11-08); the Thai is the build chat's, by the glossary
("โหวต DAO" for DAO votes), for Thai readers to correct. The Guardians
page and New fund proposal (2026-11-08, section 11) take their words from
`guardians` and `guardianNew`, and the entry card on the DAO page from two
entries in `dao`; the words of the two account panels left `account` with
the panels; the five status words are one table, `guardians.statuses`,
keyed by the validator's word; the Thai is the build chat's, by the
glossary ("ผู้คุ้มครอง" guardian, "ข้อเสนอกองทุน" fund proposal), for Thai
readers to correct. The Fund proposal page (2026-11-08, section 11)
takes its words from `guardians` too, where step 3 had already put them,
plus `guardians.payoutTo`, the payout row's "1500 anos to
a1b2c3d4…e5f6"; Home's "A fund proposal is open for your vote" is
`home.openFundVote`; the Thai is the build chat's, for Thai readers to
correct.

### 8.9 The confirmation box

One small component, src/app/components/confirm-dialog.component.ts
(`ConfirmDialogComponent`, `app-confirm-dialog`), and one function in the
same file, `askConfirm(dialog, data)` (2026-11-10, section 11; the plan
is forclaude/wallet-confirm-box-plan-1.md): the wallet's one pop-up box,
a Material dialog (`@angular/material/dialog`) in the middle of the
screen, for what nobody should start by accident. A page injects
`MatDialog` and calls `askConfirm`, which opens the component and
resolves true only when the box closed by its second button.

What it is given, `ConfirmData`: `title`; `lines`, each a `ConfirmLine`
`{ label, value, code? }`, drawn as a two-column grid, the label in the
on-surface-variant colour and the value beside it, in the id font when
`code` is true; `notes`, each a paragraph under the lines;
`confirmLabel`, the words on the second button; since 2026-11-11
(section 11), `cancelLabel`, which a caller may leave out: the words on
the first button; and, since 2026-11-12, `typed` and `danger`, which
are described two paragraphs down. A value too long for its
column wraps at a space, and is cut inside a word only when the word
alone is too long (`overflow-wrap: anywhere`); a value in the id font is
cut anywhere, by the global rule for `code`, so a 64-character id wraps
on a phone (2026-11-10, section 11: at first every value was cut
anywhere). The two buttons, at the right: the first, which closes with
false and reads Cancel (`common.cancel`), or the caller's `cancelLabel`
when one is given; and the caller's button, which closes with true.

The box closes only by those two buttons. A click outside it and the
Escape key do nothing (`disableClose`), so the second click of a double
click on the page's button cannot close the box or answer it. The second
button cannot be pressed for the first half second after the box opens
(`CONFIRM_ARM_MS`, 500, in constants.ts), so that second click can never
land on it. Nothing in the box has the focus when it opens (`autoFocus:
'dialog'`: the focus goes to the box itself), so the Enter key answers
nothing. The box is 480 px wide, or the screen's width less 32 px where
that is narrower.

Two more fields, each of which a caller may leave out (2026-11-12,
section 11; the plan is forclaude/wallet-case-chats-plan-1.md, its step
5). `typed`, `{ label, expected }`: the box shows one text box under the
notes, an outlined field with the caller's label, as wide as the box,
with the browser's suggestions and its capital first letter turned off
(`autocomplete="off"`, `autocapitalize="none"`). The second button then
stays off until what is typed equals `expected`, both trimmed and in
small letters, and the half second has passed. The text box stands in
no form, so the Enter key in it answers nothing. The focus still goes
to the box itself when it opens, so the person taps the text box to
type. `danger`, true or left out: with true the second button carries
the class `danger`. That class is one rule in src/styles.css, the
wallet's global style file. It sets five of Material's button variables
to the theme's error colours: a filled button is red with the on-error
colour for its words, an outlined button has red words and a red
outline, a text button has red words. The rule colours a button that
can be pressed; a button that is off keeps the theme's disabled look.
The same class stands on the cancel buttons of three pages (8.2):
"Cancel transfer" under the Locked transfer row of the account page,
"Cancel transfer" and "Yes, cancel the transfer" on the assisted
transfer page, "Cancel trade" and "Yes, cancel the trade" on the escrow
trade page.

Three places use it (8.2): the Send form of the account page, before
every kind of send; "Open a new account" on the Wallet page, before
Create anos account and Retry; and, since 2026-11-11 (section 11),
"Cancel transfer" under the Locked transfer row of the account page.
That third place is the only one that gives `cancelLabel`: Back
(`common.back`), since Cancel there would read as the cancel itself; the
other two keep Cancel. It is also the only one that gives `danger`. The
Send form is the only one that gives `typed`, and only for a stake for
daoVote or guardian: the label "Your username" and the anoPod's
username. Each does nothing while a box is already open.

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

The three lock numbers come from the proxy: on this machine its defaults
1, 2 and 1 match the local validators and no env file is needed; on the
testnet network/wallet.env says 10, 20 and 5, the validators'
network/testnet.env numbers (2026-11-06, section 11).

## 10. Out of scope, not built

- Recover account: the locked-out flow and the case view are built
  (section 12, build 1, 2026-10-26); the moderator section is build 2 and
  the finish build 3.
- Sending anos to a username: the recipient is a typed account id.
- The real signing server (the serversigner software, tomorrow): no
  checks of what it signs, no auth.
- Keyholder discovery and ceremonies: the proxy's list is the truth.
- A retry of a failed keyholder deposit: the step restarts with a new
  secret. A catch-up that gives a keyholder the shares it missed while
  it was down (2026-11-07, forclaude/wallet-deposit-floor-plan-1.md
  decision 1): the user's list for after the production launch.
- Reads of the holding tables: the pending row has /list-transactions,
  the open escrows /list-escrows (2026-11-05), the assisted transfer
  /get-assisted-transfer and the locked transfer /get-locked-transfer
  (2026-11-06), and the fund proposals, open and decided, the two public
  reads /list-fund-proposals and /get-fund-proposal (2026-11-08).
- From the Home plan (forclaude/wallet-home-plan-1.md, 2026-11-06): a
  nickname for an account (would need a masterpod column); a QR code of
  an account id (would need a package); the Log as a tile on Home; a
  count of waiting vouch requests on Home for a seed (needs a read); the
  receiver's view of an incoming assisted transfer; a username for an
  account id; a notification when a transfer is written; asking several
  validators instead of one; "Anos" with a capital. A cancel for a
  locked transfer stood in this list, with "none exists on the
  validator", until 2026-11-11, when
  forclaude/locked-transfer-cancel-plan-1.md built it on the validators,
  the doormen and here (8.2, Account; section 11).
- Asking a validator for its lock numbers, so that they live in one
  place, set aside 2026-11-06 (forclaude/wallet-locks-plan-1.md): the
  proxy's env carries the validators' numbers and the two files are
  changed together.
- Any check by a validator that walletKey in a creation is the signing
  server's key: the binding check with the masterpod is the check.
- From the languages plan (forclaude/wallet-languages-plan-1.md,
  2026-11-06): languages other than English and Thai (one more
  dictionary file each); remembering the language on the device; a
  button to switch to Thai; translating the servers' reasons (needs
  error codes on the validator, the doorman and the masterpod); the
  browser tab's titles; Material's screen-reader labels; the
  developer-worded errors of crypto.service.ts; the Buddhist year; a
  Thai web font; blocking Google Translate or marking pieces
  untranslatable; right-to-left languages.
- From the protect plan (forclaude/wallet-protect-plan-1.md,
  2026-11-07): a second ask on Skip; the pane on an
  iPhone (the passkey is in iCloud Keychain, end to end encrypted behind
  the Apple ID's two-factor, nothing to sign up for) or on a computer
  (Chrome there may keep the passkey with Google too); knowing whether
  the passkey really is with Google (the user agent says Android, no
  more; a Samsung or password-manager passkey reads the same pane, hence
  "usually"); Android 16's device setting of the same name.
- From the notes plan (forclaude/wallet-notes-plan-1.md, 2026-11-07): a
  note on a pending transaction; the masterpod checking that a noted
  transaction is on the ledger; gift kinds (a buy or a sale at zero); a
  note's ledger facts changing after it is written; filtering the notes
  by account or by currency on the page (the CSV and a spreadsheet do
  that); paging past the newest 1,000 notes; a nickname or any setting
  beyond the Protect answer (the settings blob is ready for them); the
  Protect line for a pod with no recorded answer; the Protect pane on an
  iPhone or a computer.
- From the break-glass plan (forclaude/break-glass-plan-1.md, 2026-11-08):
  the owner's dispute path for a false recovery (a cached key blob, a
  "Dispute a recovery" button, a warning) and a cancel page for either
  key; forwarding, a closed flag or a repeat sweep for money that lands
  in an old account after the move; a notification to the person or the
  attestors about a move; a migration of old key blobs (the testnet is
  reset with a fresh genesis instead); the break-glass blob's removal
  from the masterpod.
- From the DAO voting plan (forclaude/dao-voting-plan-1.md, 2026-11-08,
  its section 8): a moderator hide for a proposal's text; votes signed by
  pair one of a staked account instead of the pod's session keys;
  notifications about proposals; editing or withdrawing a proposal;
  comments on a proposal (the chat is there); a quorum; any weighting but
  one staked anos one vote; a cursor on the lists (offset paging
  instead); a vote list export; a logged-out public view of the
  proposals; the stake withdrawal lock (the guardians work it by hand
  from the vote rows' times).
- From the Guardians plan (forclaude/wallet-guardians-plan-1.md,
  2026-11-08, its section 7): usernames for guardians and recipients
  (the validators know account ids only; a masterpod lookup by account
  id is a later step); notifications about fund proposals; a poll
  (Refresh, and a reread after each action); editing or withdrawing a
  proposal (no validator rule exists for it); a stake withdrawal page of
  its own (a payout with stakeFor is the way, and the form has it);
  several open proposals (the validator holds one); merging the DAO and
  the guardians into one page; an entry of their own in the side panel
  or a Home tile (a card on the DAO page instead, since very few people
  are guardians).
- From the locked transfer cancel plan
  (forclaude/locked-transfer-cancel-plan-1.md, 2026-11-11): a cancel by
  the break-glass key, for someone who lost their passkey; a line in the
  history or a notification for a cancelled transfer; the receiver's
  view of a locked transfer.
- Several passkeys, push delivery, a custom theme, rate limits.

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

### The account recovery walkthrough (2026-11-05)

- Why: testers did not know what to do on the bucket pages, did not
  notice moving from the first to the second (both opened with the front
  camera), and "security bucket" is a server word that had reached the
  screen. Decided in chat the same day, no plan file, built in three
  commits.
- The change (sections 8.1, 8.2 and 8.4): the two bucket pages became one
  linear stepper, `src/app/pages/account-recovery.page.ts`, seven steps
  and a done view; the camera component took a `facing` input and the ID
  steps use the back camera; a new Account page,
  `src/app/pages/account-home.page.ts`, at /account, and an Account entry
  in the navigation in place of the two bucket entries; the addresses
  /account/recovery/selfie and /account/recovery/details, the old
  /security ones forwarding; the next-step rule answers the new
  addresses. The server calls, the share types and the forms of the info
  entries are unchanged, with one new form, "bank: bank, name on the
  account, number". The moderator and attestor case pages still say
  Bucket one and Bucket two, by decision.
- By decision: the friend or family contact stays required on a first
  visit; the bank account and anything else are optional; no
  country-specific document is named on screen; no field for a moderator
  to note the two deposit amounts, for now.
- Checked here: `ng build` clean after each of the three commits. The
  pages need a live session, so the run-through is the user's, after the
  deploy.

### The escrow trades, step 2 (2026-11-05)

Planned 2026-11-05 in chat, no plan file: the validator read of section
5.4 (anossoftware section 16, step 1), this step, and the trade page
(step 3). Why: nothing showed a waiting escrow on either side, and every
follow-up needed the transaction id pasted from the one-time "accepted"
line.

- `anos-api.service.ts`: `listEscrows(pairOne, accountId, quiet)`, the
  account envelope as `getAccount` builds it, with `EscrowItem`,
  `EscrowStage` and `EscrowVerdictSummary`; `EscrowItem.stage` is typed as
  the five words or any string, so a word added on the validator later
  compiles here and reads "Open".
- `account.page.ts`: the read joins `refresh()` beside the other two, its
  refusal kept apart (`escrowsError`) so the balance and the transactions
  still show, which matters while a validator runs without the route
  (its doorman answers 404, shown as "/list-escrows: HTTP 404: Not
  Found"). The Escrow trades list; the balance line (`heldAsSeller`, the
  amounts of the open trades where this account is the seller, summed as
  BigInt, one by the validator's rule); the Send rule (`sellerEscrowOpen`);
  the 5-second poll while a trade is open; `stageWords`. The escrow block
  of the follow-ups form, its three signals, `ESCROW_SIGNATURES` and
  `sendEscrowSignature()` are gone; `anosApi.escrowSignature` stays for
  the trade page and the attestor's verdict page (13.3).
- The rows are not links yet: the trade page and its route are step 3,
  and a link to a page that does not exist would land on the catch-all.
  Step 3 adds the link.
- The Transactions list is unchanged by decision: its raw type words wait
  for a cleanup of their own.
- `npx ng build` clean.

### The escrow trades, step 3 (2026-11-05)

- `src/app/pages/escrow-trade.page.ts` (`EscrowTradePage`, inputs
  `accountId` and `transactionId` bound from the route), the route in
  `app.routes.ts` behind the session guard, and the rows of the Escrow
  trades list now link to it (`account.page.ts`).
- The stage words moved to `src/app/escrow-stage.ts`
  (`escrowStageWords(stage, side)`), used by both pages so the list and
  the trade page cannot drift apart; the account page's own copy went.
  The one change beyond the plan's letter.
- The page reads the whole list (/list-escrows) and picks its trade. A
  trade seen open and then missing is the closed view; one never seen
  open is "not open". The 5-second poll stops once the trade is closed.
  The case link is looked up (/list-my-cases, quiet) on each refresh of a
  disputed trade until a case is found.
- The follow-up is built and signed exactly as the removed form did
  (`buildFollowUp` with pair one, `/api/sign`, `/escrow-signature`); the
  validator's refusals are mapped to plain sentences by their reason
  text (`plainReason`), the rest shown as "/escrow-signature: HTTP
  <status>: <reason>".
- `npx ng build` clean. Not run against a validator here; the user tests
  on the testnet.

### Copy and paste buttons (2026-11-05)

Step 1 of the send upgrade, settled in chat (no plan file): sharing an
account id, and getting one into the Recipient box, meant selecting 64
hex characters by hand.

- `src/app/components/copy-button.component.ts` (`CopyButtonComponent`,
  `<app-copy-button>`, inputs `text` and `label`): the copy button of
  8.5. "copied" for two seconds, "could not copy" when `writeText`
  throws; the timer is cleared on destroy. The case pages of sections 12
  and 13 keep their own copy code, untouched.
- `account.page.ts`: the copy button after the id in the title. The
  paste icon (`content_paste`, `matSuffix`) in the Recipient account id
  box: `pasteRecipient()` reads `navigator.clipboard.readText()`, takes
  the first run of exactly 64 hex characters with no hex character on
  either side (`ACCOUNT_ID_IN_TEXT`), lower-cases it into `accountIdTo`
  and clears the hint; otherwise one of the two hints of 8.2
  (`pasteNote`, a `mat-hint`). The field has `subscriptSizing="dynamic"`
  so a two-line hint pushes the row down instead of overlapping it, and
  the Send row is top-aligned (`.send`) with the Send button 8 px down
  so it stays level with the boxes. Chrome asks once whether the site
  may read the clipboard; Safari shows its Paste bubble at every tap,
  and a dismissed bubble ends as the "did not allow" hint.
- `wallet.page.ts`: the copy button at the end of each row, after
  Resubmit when that shows.
- `chat.page.ts`: a message is split into pieces when decrypted
  (`piecesOf`, the same 64-hex rule); an account id piece renders as
  code with the copy button after it. `ShownMessage` holds `pieces`
  instead of `text`.
- Spec: 8.2 Wallet, Account (the title, Send) and Chat, the new 8.5,
  this note.
- `npx ng build` clean.

### The transaction history page (2026-11-05)

Step 2 of the send upgrade: the transaction list sat between the
balance and Send, so Send was hard to find and the list read as part of
it.

- `src/app/pages/transaction-history.page.ts`
  (`TransactionHistoryPage`, input `accountId` from the route), the
  route `/wallet/:accountId/history` in `app.routes.ts` behind the
  session guard. The rows are the account page's rows, moved as they
  were (the raw type words included, by decision); `pairOne()` is the
  trade page's copy; Refresh and Load more set `busy`, which shows the
  progress bar and disables the buttons. No poll.
- `account.page.ts`: the Send block moved up to right after the Refresh
  row, so the page reads balance, Refresh, Send, Pending, Escrow trades,
  the "Transaction history" button (a stroked link button with the
  history icon), the two panels. The Transactions heading, list and Load
  more are gone, with the `transactions` and `canLoadMore` signals,
  `loadMore()`, `counterpart()` and the `TransactionItem` import.
  `refresh()` still reads the first page of /list-transactions, now only
  for the pending list. The class comment rewritten for the order.
- Spec: 8.1 (the two route lines), 8.2 Account (the order, the Escrow
  trades and Send sentences) and the new Transaction history paragraph,
  this note.
- `npx ng build` clean.

### The vouched screen and the vouching instructions (2026-11-05)

Step 1 of the vouching upgrade: being vouched was easy to miss (one small
line and a Continue button above the seed search), and the page said
nothing about what vouching is or what to do.

- `src/app/pages/vouching.page.ts`: once `session.vouched()` is true the
  card shows only a centred block, "You've been vouched" as a 2 rem
  headline, "N people vouched for you. You can continue to the next
  step." ("1 person" when it is one) and a 52 px Continue; the subtitle,
  the status line, the instructions, the search, the profile card and the
  sent-requests list are all inside the `@else`. Until then: the one-line
  subtitle "Someone who already has an anoPod confirms they know you.",
  the status line, the instruction block (`section.how`: "How vouching
  works", "What to do" as a four-point list, "While you wait"), then the
  search and the lists as they were, one indent level deeper. New
  `vouchCount` computed (the status's vouchCount, 0 without a status),
  used by the status line and the vouched block. The class comment
  rewritten.
- The wording of the instructions was agreed line by line in the planning
  chat; the old "check back" sentence lives on in "While you wait".
- Spec: 8.2 Vouching, this note.
- `npx ng build` clean.

### The test-site notice (2026-11-05)

Step 2 of the vouching upgrade: the live site is a testnet, and the
landing page said nothing about it.

- `src/app/pages/landing.page.ts`: a `div.notice` above the card, in
  every edition, the full width of `main`: a 40 px warning icon
  (`MatIconModule` imported), "This is just a test site." at 1.75 rem
  bold, the rest of the English, then the Thai translation in a
  `lang="th"` paragraph. Error-container background and text colours
  from the theme. The class comment names it.
- The Thai text is the planning chat's translation, to be checked by a
  Thai reader before deploy.
- Spec: 8.2 Landing, this note.
- `npx ng build` clean.

### The chat as a messenger, step 2 (2026-11-05)

Steps 2 and 3 of forclaude/wallet-chat-plan-1.md, built as one round
after step 1 (the masterpod's lastMessage, listing and invited in
/list-chat-rooms, beforePosition on /list-messages). The chat was one
page of two cards with four fold-out panels; on a phone the panels came
before the messages.

- `masterpod-api.service.ts`: `RoomItem` gains `listing` (`RoomListing`:
  side, quantity, currency), `invited` and `lastMessage`; `MessagesQuery`
  and `listMessages(chatRoomId, query, quiet)`. `constants.ts`:
  `MESSAGES_PAGE = 50`. `session.service.ts`: `chatRooms`, the latest
  /list-chat-rooms answer, cleared by `close()`. `app.ts`: the 5-second
  poll adds `listChatRooms(true)` once setup is complete.
- `src/app/services/chat.service.ts` (`ChatService`): `roomKeyOf`,
  `wrapFor` (by room id; the key from the session or the listed room),
  `piecesOf` and `ACCOUNT_ID_IN_TEXT`, moved from the old chat page;
  `decryptMessage` (null when it will not open), `title`, `kind`,
  `otherPerson`, `icon`, `activityAt`, `sorted`, `shortWhen`, `dayLabel`
  (for step 4), `requestedRooms` with `markRequested`, `refreshRooms`.
- `src/app/services/profile-cache.service.ts` and
  `src/app/components/avatar.component.ts`: 8.6.
- `app.routes.ts`: `chat` keeps `ChatPage` and gets the children
  `requests`, `new` and `:chatRoomId`.
- `src/app/pages/chat.page.ts`, rewritten: the list and the pane (8.2
  Chat). The page takes the height under the toolbar (64 px, 56 px under
  600 px, less main's padding) so the list and the pane scroll inside
  it; a signal from the router's url says whether a child is open; the
  previews are decrypted once per message id by an effect on the room
  list.
- `src/app/pages/chat-room.page.ts` (`ChatRoomPage`, input `chatRoomId`):
  the conversation. An effect opens the route's room once the list has
  it, and again when the id changes; opening reads `beforePosition:
  lastPosition + 1`; Load older reads before the oldest shown and keeps
  the reader's place (scrollTop moved by the added height); the poll
  reads after the newest shown, quiet, skipped while busy; new messages
  are deduplicated by id. The invite form and Members are panels under
  the header, opened from the menu.
- `src/app/pages/chat-requests.page.ts` (`ChatRequestsPage`): the invites
  and the join requests, moved from the old page's panels.
- Spec: 8.1 (the four chat lines), 8.2 Chat (rewritten) and
  Notifications (the poll), 8.3, the new 8.6, this note.
- `npx ng build` clean (1.46 MB initial).

### The chat as a messenger, step 3 (2026-11-05)

Built in the same round as step 2.

- `src/app/pages/chat-new.page.ts` (`ChatNewPage`): the three tabs of 8.2
  Chat, New chat. Start chat reads the person's chat public keys before
  creating the room, so a person without them makes no empty room;
  `justUs` finds the existing private chat with exactly the two of you.
- `marketplace.page.ts`: the owner's Room link to the listing's room;
  Open chat, Requested or Request to join on another's listing (`inRoom`,
  `ChatService.requestedRooms`); `requestToJoin` marks the room on
  success. The class comment says so.
- `notifications.page.ts`: `isCase` became `linkOf(kind, referenceId)`:
  the case kinds to the case, chatInvite and joinRequest to
  /chat/requests, inviteAccepted, inviteDeclined and joinApproved to the
  room; joinDeclined has no link.
- Spec: 8.1 (/chat/new), 8.2 Chat (New chat), Marketplace and
  Notifications (the links), this note.
- `npx ng build` clean.

### The chat as a messenger, step 4 (2026-11-05)

Steps 4 and 5 of forclaude/wallet-chat-plan-1.md, built as one round.
The bubbles were one per message with the sender's name on every one,
the box a single line, and the thread always jumped to the bottom.

- `chat-room.page.ts`: `thread`, a computed over the messages, groups
  them (`Group`: one sender, five minutes, one day; `ThreadItem` a day
  line or a group); the template draws a day line, then a group with the
  avatar (28 px) and the name on top for someone else's group in a room
  that is not direct, the bubbles, and the time once below. The box is a
  textarea with `cdkTextareaAutosize` (`TextFieldModule`, one to five
  rows); `enter()` sends on Enter without Shift; Send is a
  `mat-mini-fab`. `nearBottom()` (120 px) is measured before new polled
  messages are added and decides the scroll. `send()` appends a pending
  bubble (`pending: true`, a `pending-N` id) and clears the box at once;
  the answer turns it into the real message by id and position, and the
  poll after the send replaces it with the server's row; a refusal or a
  thrown error removes it and puts the text back. `ShownMessage` gains
  `pending`. The thread's element reference is `threadBox`, since
  `thread` is the computed.
- `chat.service.ts`: `timeOf(iso)`, the time of a group.
- Spec: 8.2 Chat (the conversation), 8.3, this note.
- `npx ng build` clean.

### The chat as a messenger, step 5 (2026-11-05)

Built in the same round as step 4.

- `session.service.ts`: `seenPositions` (room id to position), read from
  localStorage under `anopod-wallet.chat-seen.<anopodId>` in `open()`
  and cleared in `close()`; `markSeen(chatRoomId, position)` raises and
  writes it (a browser that refuses leaves the copy in memory);
  `unreadRooms` and `unreadRoomCount`; the three helpers `seenKey`,
  `readSeen` and `writeSeen` at the end of the file.
- `chat-room.page.ts`: `markSeen` after opening, after new polled
  messages and after a send.
- `chat.page.ts`: `unreadIds`; an unread row has the class `unread`
  (bold title, the preview in the surface colour) and a 10 px dot under
  the time (`.meta`).
- `app.ts`, `app.html` and `app.css`: `NavItem.badge`; the Chat entry's
  badge is `unreadRoomCount()`, drawn as a pill (`matListItemMeta`,
  `.badge`) when above zero.
- Spec: 8.1 (the navigation), 8.2 Chat (the list row, the conversation's
  marking, Unread), 8.3, this note.
- `npx ng build` clean (1.49 MB initial).

### The marketplace, step 2 (2026-11-06)

Step 2 of forclaude/wallet-marketplace-plan-1.md, the wallet's screens,
on the masterpod of step 1 (its /get-listing, the listingId on
/create-chat-room, the listing on every room and invite). The old
marketplace page was a Material list with typed codes and one group room
per listing.

- `src/app/services/marketplace.service.ts` (`MarketplaceService`, 8.3):
  the reads, the words and roles, the rooms and invites about a listing
  out of `session.chatRooms`, `stateOf`, `connect` (the Message someone
  flow of chat-new.page.ts with the listing and the first message) and
  `connectAgain`, and `remembered` with `remember`. `firstWords` holds
  the ready-made first message of the plan's decision 3.
- `src/app/prices.ts`: `formatPrice(amount, currency, minimumDecimals =
  2)`, `totalOf`, `currencyOptions`, and `priceUnits`, the parser they
  share (a price scaled to eight decimals, a BigInt), which the new
  listing form and the price range use too. A total is rounded to two
  decimals and shown without decimals when whole, so a card reads "3,550
  THB" as the plan writes it, and "3,554.38 THB" otherwise.
  `src/app/countries.ts`: `countryName`.
- The four components of 8.7. The picker and filters sheets open with
  `autoFocus: 'dialog'`, so a phone does not raise its keyboard before
  the person taps the search box.
- `marketplace.page.ts` (Browse) rewritten: the chip row
  (`mat-chip-listbox` for the side, `mat-chip`s with `role="button"` for
  the pickers, the sort menu and the filters), the Your listings row, the
  grid, the fab; `inRanges` applies the two ranges on the digits. The
  pages `listing.page.ts`, `listing-new.page.ts` and
  `my-listings.page.ts` are new; the routes `marketplace/new` and
  `marketplace/mine` come before `marketplace/:listingId`.
- `masterpod-api.service.ts`: `RoomListing` in its fuller form,
  `listingId` and `listing` on `InviteItem`, `ListingItem.chatRoomId`
  nullable, `ListingFields` without `hpkeKey`, `ListingFilters.mine` and
  `status: 'any'`, `getListing`, `createChatRoom` with the optional
  `listingId`. `chat.service.ts`: `title` adds the listing's words to a
  private room about a listing; `listingWords` is shared with the
  Requests wording in `chat-requests.page.ts`.
- Readings where the plan left a detail open: the remembered country and
  currency are written by Browse's pickers and by a created listing;
  Clear in the filters sheet closes it with no ranges; the people who
  connected show the room's creator, who is the person who connected; a
  closed listing in the waiting state reads "This listing is closed."
  too.
- Spec: 8.1, 8.2 (Marketplace rewritten; Chat, the title and the
  Requests wording), 8.3, 8.6, the new 8.7, this note.
- `npx ng build` clean (1.60 MB initial).

### The marketplace, step 3 (2026-11-06)

Step 3 of forclaude/wallet-marketplace-plan-1.md, the trade from the chat:
the pinned card of 8.7 and its paragraph in 8.2 Chat. Only one page
changes.

- `src/app/components/pinned-listing.component.ts`
  (`PinnedListingComponent`): the card. The roles come from
  `MarketplaceService.mySide(room.listing)`; the first line from
  `formatPrice` and `totalOf`; the stage words from `escrowStageWords`.
  `start()` copies the account page's Send for the escrowTransfer, with
  `createdAt` now (a spending account has no lock); a refusal shows as
  "The validator refused the trade: " and the reason as `reasonOf` gives
  it, the account page's words. `poll()` runs when one of this pod's
  accounts is first named in the chat and every ACCOUNT_POLL_MS; a quiet
  read that fails keeps the card as it is. `post()` sends an encrypted
  message with the room key from `ChatService.roomKeyOf`; the thread's
  3-second poll shows it.
- `chat-room.page.ts`: `accountIds`, a computed over `messages()`
  (lower-cased ids, newest position first), and the card drawn under the
  panels when the room is private and has a listing. The thread and the
  composer are untouched.
- Readings where the plan left a detail open: the card carries the other
  person's avatar at the left of its first line (8.6 names the card as an
  avatar's use); Share and Start come back after a cancelled trade, so a
  second trade can be started in the same chat, and stay away after a
  release; Close the listing refreshes the room list at once rather than
  waiting for the shell's poll; the seller's From starts as the first
  spending account and the To as the newest account id the other person
  posted.
- Spec: 8.2 Chat (the pinned card), 8.6, 8.7, this note.
- `npx ng build` clean (1.61 MB initial).

### The assisted transfer, step 2 (2026-11-06)

Step 2 of forclaude/wallet-assisted-plan-1.md, the account page. Step 1,
the validator read /get-assisted-transfer (anossoftware section 17) and
the doorman's route line, was built and committed first; steps 2 and 3
were built together on the user's word. Why: the only way to see from
the wallet that an assisted account had a transfer waiting was the Cases
page, once an attestor had opened a case, and the cancel needed the
transaction id pasted into the follow-ups form.

- `anos-api.service.ts`: `getAssistedTransfer(pairOne, accountId,
  quiet)`, the account envelope as `getAccount` builds it, with
  `HeldAssistedTransfer` and `AssistedStage`; `stage` is typed as the four
  words or any string, so a word added on the validator later compiles
  here and reads "Open".
- `src/app/assisted-stage.ts`: `assistedStageWords(stage)`, the words of
  the plan's decision 8, shared by the account page's row and the
  transfer page as `escrow-stage.ts` is.
- `account.page.ts`: on an assisted account the read joins `refresh()`
  beside the other three, decided after `pairOne()` has run, since that
  reloads the accounts when the page's account is not in the session;
  its refusal kept apart (`assistedError`) so the balance and the rest
  still show while a validator or doorman runs without the route (the
  doorman answers 404, shown as "/get-assisted-transfer: HTTP 404: Not
  Found"). On any other account type no call is made. The Assisted
  transfer section, one row linking to the transfer page (the link from
  this step, since the steps were built together); the balance line; the
  Send rule and its line; the line under Send for an assisted account;
  the 5-second poll while a transfer is held. The attestation form and
  the assisted cancel form left the follow-ups panel with their three
  signals, `sendAttestation()` and `sendCancel()`; the guardian vote
  form, `followUp()`, `sendVote()` and the fund proposal panel stay.
  `AnosApiService` keeps `attestation()` (the attestor's trade case page)
  and `assistedTransferCancel()` (the transfer page).
- Readings where the plan left a detail open: the section's row is a
  one-item `mat-list`, as the Escrow trades rows are; the stage words
  reach the template as the function itself (`assistedStageWords`), as
  `millionthsToAnos` does, since no side is needed; a refused read leaves
  the last answer in place and shows the refusal, as the escrow read
  does.
- Spec: 5.4, 8.2 Account (the refresh line, the balance line, the
  Assisted transfer section, the Send rule and the line under Send, the
  follow-ups sentence), 8.3, 10, this note.

### The assisted transfer, step 3 (2026-11-06)

- `src/app/pages/assisted-transfer.page.ts` (`AssistedTransferPage`,
  inputs `accountId` and `transactionId` bound from the route), in the
  frame of `escrow-trade.page.ts`: the summary grid, the ask-once
  question, the progress bar, the closed view, the 5-second poll with
  `ACCOUNT_POLL_MS`. The route in `app.routes.ts` behind the session
  guard.
- The page reads /get-assisted-transfer and takes the answer's transfer
  when its id is the route's; null or another id means not held. A
  transfer seen held and then gone is the closed view (the first page of
  /list-transactions: the id on it is "Done. The 5 anos went to
  <receiver>.", not on it "Cancelled."); one never seen held is "not
  held". The poll stops once the transfer is closed. The case is looked
  up (/list-my-cases, quiet) on each refresh while held, the newest trade
  case with the transaction id; a dismissed case's reason comes from
  /get-my-case once per case id, in the words of `DISMISS_WORDS`, now
  exported from `my-case.page.ts`.
- The cancel is built and signed exactly as the removed form did
  (`buildFollowUp` with pair one, `/api/sign`,
  `/assisted-transfer-cancel`); the validator's refusals are mapped to
  plain sentences by their reason text (`plainReason`), the rest shown as
  "/assisted-transfer-cancel: HTTP <status>: <reason>".
- `my-case.page.ts`: "See the transfer" under the transaction id of a
  trade case, to the transfer page of the sending account;
  `DISMISS_WORDS` exported; nothing else changed. `cases.page.ts`:
  `knownTransactions` also reads /get-assisted-transfer (quiet) for each
  of this pod's assisted accounts on the cases, so a trade row reads
  "Assisted trade · 5 anos · with <receiver>…" through the template as
  it is.
- Readings where the plan left a detail open: Go to the case hides with
  Cancel transfer while the question is asked, as the trade page's
  buttons do; "Go to the case" is an `<a mat-flat-button>` with a
  routerLink; a dismissed case whose /get-my-case read fails reads
  "another reason" and is not asked again (once per case id); the
  assisted read in `knownTransactions` runs before /list-transactions,
  so a list read that fails does not skip it; the closed view keeps the
  transfer as last seen, for the amount and the receiver of "Done".
- Spec: 8.1, 8.2 (the Assisted transfer page paragraph), 13.3 (Cases, My
  case), this note.
- `npx ng build` clean (1.63 MB initial). Not run against a validator
  here; the user tests on the testnet.

### Home and the account cards, step 2 (2026-11-06)

Step 2 of forclaude/wallet-home-plan-1.md: the balances, the Wallet page
and the account page. Step 1, the validator's /get-locked-transfer and
the date range on /list-transactions (anossoftware section 18) and the
doorman's route line, was built and committed first; steps 2, 3 and 4
were built together on the user's word. Why: the Wallet page was a bare
list of ids with nothing saying how many anos a person has in all, and
nothing counted the anos a guarded or vault transfer holds while it waits
out its lock.

- `anos-api.service.ts`: `getLockedTransfer(pairOne, accountId, quiet)`,
  the account envelope as `getAccount` builds it, with
  `HeldLockedTransfer` and `LockedStage` (`stage` typed as the three
  words or any string, as the assisted one is); `listTransactions`'s
  body takes `from` and `to`.
- `src/app/locked-stage.ts`: `lockedStageWords(stage)`, the words of the
  plan's 4.2; `src/app/short-id.ts`: `shortId(id)`, the first 8 and the
  last 4 characters; `src/app/account-names.ts`:
  `accountNames(accounts)`, the names by type in list order.
- `services/balances.service.ts`: `BalancesService` with `byAccount`,
  `busy`, `readAt`, `totals`, `needsPoll` and `refresh(quiet)`, which
  reads every account at once by `readOne` (/get-account,
  /list-transactions with limit 1, /list-escrows and the held-transfer
  read of the account's type, together); the entries of the plan's 4.2.
- `components/balance-card.component.ts`: `<app-balance-card>`, no
  inputs, over the two services.
- `wallet.page.ts`: the subtitle gone; the balance card, the Accounts
  heading and the cards, "Open a new account" over the row and the
  progress list as they were. `ledger`, `LedgerState`, `checkLedger()`
  and `pollLedger()` left; `load()` lists the accounts and then
  `balances.refresh()`; the 5-second timer calls
  `balances.refresh(true)` while `needsPoll()` and nothing is busy.
- `account.page.ts`: on a guarded or vault account /get-locked-transfer
  joins `refresh()` as a fifth read, its refusal kept apart
  (`lockedError`); the Locked transfer section after the Assisted one,
  one row with no link; the balance line; the Send rule and its line;
  the poll while a transfer is locked.
- Readings where the plan left a detail open: the balance card's small
  lines are built in a computed (`lines`) and the account card's by
  `balanceWords` and `heldWords`, since a template cannot write a bigint
  such as `0n`; `heldWords` names every held kind above zero joined by
  " · ", one in practice since an account holds one transaction at a
  time; a card with no entry yet reads "Reading…" even for an
  unsubmitted account, until the first read answers; the entry's field
  comments are doc comments rather than end-of-line ones; the card's
  refresh button takes the card's text colour through the icon-button
  colour token.
- Spec: 5.4, 8.2 Wallet (rewritten) and Account (the refresh line, the
  balance line, the Send rule and its line, the Locked transfer
  paragraph), 8.3, 8.5, 10, this note.
- `npx ng build` clean (1.63 MB initial). Not run against a validator
  here; the user tests on the testnet.

### Home and the account cards, step 3 (2026-11-06)

Step 3 of forclaude/wallet-home-plan-1.md: Home. Why: the app opened on
the Wallet page, and the side panel behind the menu button was the only
way around the app.

- `services/navigation.service.ts`: `NavigationService` with `NavItem`
  (moved here from `app.ts` and exported) and `items`, the body of the
  shell's `navItems` moved as it was, with Home first once setup is
  complete and the Notifications entry's badge; the side panel and the
  Home tiles both draw it.
- `app.ts`: `navItems = this.navigation.items`; the interface and the
  computed body left, `computed` left the import line. `app.html`: the
  brand is a link to /home once setup is complete, the span as before
  until then. `app.css`: `.brand` inherits its colour and has no
  underline.
- `landing.page.ts`, `unlock()`: a next step of /wallet goes to /home;
  the rule's own answer stays Wallet, so `setup.page.ts`,
  `account-recovery.page.ts` and `recover-case.page.ts` were not touched.
- `app.routes.ts`: /home before /wallet, behind the session guard.
- `pages/home.page.ts`: `HomePage`, no outer card: the greeting
  (`<app-avatar>` at 56 px and "Hello, <first name>", the username when
  it is empty); the list refusal in red; `<app-balance-card>`; "Things to
  do" as a `mat-nav-list` only while `todo()` has lines, in the plan's
  order; the tiles from `navigation.items()` without Home and Log, each
  a square link with the icon, the label and the badge at the top right.
  On open /list-anos-accounts (quiet) into the session, `accountsLoaded`
  on success, then `balances.refresh()`; the 5-second timer as the
  Wallet page's.
- Readings where the plan left a detail open: the balances are read
  after the account list whether or not the list was refused, so the
  card still shows what the session knows; the greeting is an `<h2>`;
  the to-do lines are tracked by index; the "Add your recovery details"
  line waits for the status to be read, as the selfie line does.
- Spec: 8.1 (the route line, the navigation sentence, the next-step
  sentence, the brand link), 8.2 (the Home paragraph), 8.3
  (navigation.service), 8.6, this note.
- `npx ng build` clean (1.64 MB initial). Not run against a validator
  here; the user tests on the testnet.

### Home and the account cards, step 4 (2026-11-06)

Step 4 of forclaude/wallet-home-plan-1.md: the transaction history page.
Why: the history was a list of raw type words and full ids, 50 rows at a
time, with no way to look at one month.

- `constants.ts`: `HISTORY_PAGE = 20`, after `MESSAGES_PAGE`.
- `src/app/history-words.ts`: `historyWords(t, accountId)`, the table of
  the plan's 4.6 (the title, the kind in words, the sign, the icon), the
  other side shortened by `shortId`; `HistoryWords` exported for the
  page.
- `transaction-history.page.ts`: rewritten. The subtitle is the
  account's name (account-names.ts) and short id; the date range field
  (`mat-date-range-input` with `matStartDate` and `matEndDate`, the
  toggle, a clear button while a date is set, `mat-date-range-picker`),
  `from` and `to` as signals of `Date | null` set by `dateChange`;
  `changed()` reads the first page again when both are set or both
  cleared; `clearDates()` empties both and reads again. The reads carry
  `{ limit: HISTORY_PAGE }` plus, with a range, `from` the local midnight
  of the first day and `to` the local midnight after the last day, as
  ISO 8601; Show more adds `beforePosition` and keeps the range;
  `canLoadMore` while a page came back with `HISTORY_PAGE` rows. The
  rows are grouped by `ChatService.dayLabel` into day headings (a
  computed `days`), each row a full-width button with the icon, the
  title, the time (`timeOf`) and the amount at the right ("+5 anos" in
  the primary colour, "−5 anos" in the on-surface colour, the amount
  alone in muted for a payout seen by its proposer, nothing for a
  creation or a proposal); a tap opens the details (Kind, To or From
  with a copy button, Transaction with a copy button, Position, When).
  `MatListModule` left the imports.
- Readings where the plan left a detail open: `FormsModule` is not
  imported, since the two date inputs are bound with `[value]` and
  `(dateChange)` and nothing uses `ngModel`; the subtitle reads "Account"
  for the name until the account is in the session (the first read loads
  it); an open row stays open across a refresh while its id is still in
  the list; the day headings are tracked by their label, unique while the
  rows are in position order; the route line of 8.1 was reworded for the
  page it now describes.
- Spec: 8.1 (the route line), 8.2 Transaction history (rewritten), 8.5,
  this note.
- `npx ng build` clean (1.67 MB initial; the range picker's code joined
  the bundle). Not run against a validator here; the user tests on the
  testnet.

### The lock numbers from the proxy, step 1 (2026-11-06)

Step 1 of forclaude/wallet-locks-plan-1.md: the proxy and the env file;
steps 1 and 2 were built back to back on the user's word. Why: a
transfer from a guarded account on the testnet was refused with
"payload.createdAt must be at least 10 and at most 15 minutes ahead of
now". The wallet dated a guarded or vault transfer by three numbers
typed into src/app/constants.ts (1, 2 and 1, the local validators'
numbers, baked into every build), while the testnet validators read
theirs from anossoftware's network/testnet.env (10, 20 and 5). The
three are facts about the network the wallet talks to, like the
validator list and the threshold, so they move to the proxy's committed
env file beside those and reach the browser through /api/config. The
validators and their env file are not touched.

- `network/wallet.env`: `GUARDED_LOCK_MINUTES=10`, `VAULT_LOCK_MINUTES=20`
  and `LOCK_OFFSET_MINUTES=5` as a block of their own at the end, with a
  comment saying they are the validators' numbers and that the two files
  are changed together.
- `server/config.js`: `guardedLockMinutes`, `vaultLockMinutes` and
  `lockOffsetMinutes` by `integer`, with the local defaults 1, 2 and 1
  (this machine's validators'); a value that is not a positive integer
  is refused at boot, as the other integers are.
- `server/app.js`: the three answered in `/api/config` after `rpId`.
- `server/index.js`: one boot line after the rp id line, "locks guarded
  10 min, vault 20 min, offset 5 min".
- Readings where the plan left a detail open: the three new rows of the
  variable table in section 2 keep the plan's own spacing rather than
  the table's columns, since the names are longer than the column; the
  README's proxy paragraph and deploy bullet were re-wrapped only where
  the words grew.
- Spec: 2 (the table, the sentence under it, the /api/config row), 9,
  this note; README (the proxy paragraph, the variables, the deploy
  bullet).
- `node --check` on the three server files, clean. No proxy was booted
  here; the first caller of the new fields is step 2.

### The lock numbers from the proxy, step 2 (2026-11-06)

Step 2 of forclaude/wallet-locks-plan-1.md: the app. Why: with step 1
the proxy answers the three lock numbers, but the account page still
dated a guarded or vault transfer by the constants 1, 2 and 1, so a
guarded transfer on the testnet was dated 2 minutes ahead where 10 to
15 are required.

- `services/config.service.ts`: `WalletConfig` gains
  `guardedLockMinutes`, `vaultLockMinutes` and `lockOffsetMinutes`,
  optional since an older proxy does not send them; `load()` as it was.
- `constants.ts`: `GUARDED_LOCK_MINUTES`, `VAULT_LOCK_MINUTES` and
  `LOCK_OFFSET_MINUTES` gone with their comment; the account page was
  their only importer.
- `src/app/minutes-words.ts`: `minutesWords(minutes)`, the days, hours
  and minutes in words, the parts that are not zero joined "a, b and c".
- `account.page.ts`: `TRANSFERS` is `TRANSFER_TYPES`, the type words
  only; `minutesAhead` is a computed over the config, 0 on a spending or
  assisted account, the lock plus the offset on a guarded or vault one,
  null while the numbers have not loaded; Send is off while it is null,
  with the line "The lock settings have not loaded from the proxy.
  Refresh to try again.", else the lock line says the minutes in words;
  `refresh()` asks the config service to load (the shell's fetch is
  shared; a new one only after a failure); `send()` throws the same
  sentence as a backstop when the numbers are missing.
- README: the layout line of `constants.ts` no longer names the lock
  minutes (the user's word; the plan did not name the line).
- Readings where the plan left a detail open: the two new imports sit
  in the file's path order; the config line in `refresh()` carries its
  comment as a line comment above it; the class comment's new words end
  a line of their own so the lines after it stay as they were;
  `minutesWords` joins the parts with a slice rather than naming three
  cases.
- Spec: 8.2 Account (the Send sentences), 8.3 (config.service), 10,
  this note.
- `npx ng build` clean (1.67 MB initial). Not run against a proxy or a
  validator here; the user tests on the testnet.

### The languages, step 1 (2026-11-06)

Step 1 of forclaude/wallet-languages-plan-1.md: the dictionary, the
language service, the shell, the navigation and the landing page. Why:
the app was English only, about 1,300 pieces of English across 34
pages, and the first people to use it are Thai. Their only help was
Chrome's page translation, which rewrites every piece of text behind
Angular's back, so a changed amount or status can show stale or mixed
words; a wallet cannot rely on it. From this step the app speaks both
languages, Thai when the browser's first language is Thai, and each
later step turns its pages Thai.

- `src/app/i18n/en.ts`: the English words, the sections `shell`, `nav`,
  `landing`, `material` and `dates` and an empty `common`, every
  sentence moved letter for letter; `Words`, the object's shape.
  `src/app/i18n/th.ts`: the Thai, the same shape, typed `Words`, so a
  sentence missing in Thai fails the build; written from the plan's
  style and glossary (its 1.6) for the Thai readers to correct.
- `services/language.service.ts`: `LanguageService`, root-provided:
  `language`, a signal, Thai when the browser's first preferred
  language begins with "th", else English; `words`, the dictionary of
  that language; `tag`, en-US or th-TH-u-ca-gregory; `useEnglish()`;
  `dateTime` and `time`, what `date: 'medium'` and `date:
  'mediumTime'` gave. An effect sets the page's `lang` attribute, the
  date adapter's locale (the native adapter app.config.ts provides)
  and MatStepperIntl's `optionalLabel`, and fires its `changes`: once
  at start and again after Switch to English.
- `app.ts`: `lang` and `t` after `config`, so the service is created
  with the shell. `app.html`: the menu button's aria label, the two
  brand lines and Lock from `t().shell`.
- `services/navigation.service.ts`: the fourteen labels from
  `t().nav`, read inside `items`, so the side panel and the Home tiles
  follow the language.
- `pages/landing.page.ts`: the notice's headline and the card's words
  from `t().landing`; the English paragraph of the notice carries
  `lang="en"`, the Thai one stays as it was; under the card, in Thai
  only, the button "Switch to English" (a literal, English in every
  language), which calls `useEnglish()`.
- `index.html` is not changed: its `lang="en"` is the start value the
  service overwrites.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
- Readings where the plan left a detail open: the landing page's
  `lang` and `t` sit after its five private injections, protected,
  since the template reads them; the README's `language.service.ts`
  line wraps onto a second line, as the block's other long lines do;
  the 8.2 Landing paragraph was re-wrapped from the new sentence on.
  No sentence of this step read odd.
- Spec: 8.1 (the dictionary paragraph), 8.2 Landing (the headline and
  the button), 8.3 (language.service), 8.8 (new), 10, this note;
  README (the layout block, the languages paragraph).
- `npx ng build` clean (1.67 MB initial). Not run in a browser here;
  the user tests with `ng serve`: a browser whose first language is
  Thai shows the Thai shell, navigation and landing page and the
  button, any other shows English.

### The languages, step 2 (2026-11-06)

Step 2 of forclaude/wallet-languages-plan-1.md: the sign-up and setup
pages, the notifications and the log, with the camera, the copy button
and the services' own sentences. Why: after step 1 a Thai reader saw a
Thai toolbar and landing page and English pages; these are the pages of
the first visit, from Create to Setup.

- `i18n/en.ts` and `th.ts`: the sections `create`, `vouching`,
  `identity`, `identityForm`, `setup`, `seed`, `notifications`, `log`,
  `camera`, `copy`, `passkey`, `shares`, `signing` and `api`, and the
  first `common` entries: Next, Back, Continue, Retry, Refresh, Search,
  Approve, Decline, Start, Clear, Copy, Username, the `selfie` alt and
  "None yet.", each a sentence two or more pages show. The sentences with
  a number or a name are functions (`vouchedBy`, `notYet`, `notSeed`,
  `usernameAvailable`, `usernameTaken`, `markRead`, `asked`,
  `retryFresh`, `couldNotOpen`, `refused`, `keyNotFetched`,
  `publicKeys`, `sign`).
- `create.page.ts`: the four step labels as `[label]`; the username
  hints from the dictionary, the rule as the signal's first value; the
  placeholder as a binding. `vouching.page.ts`: the plural sentence and
  the two with a count or a username as functions; the time of a sent
  request with the service's tag. `identity.page.ts`: the three
  subtitles, the seven points, the warning, the review table's headings
  from the form's section. `setup.page.ts`: `STEPS` left the file for
  `setup.steps`, read into the `steps` signal as before; the thrown and
  shown sentences from the dictionary. `seed.page.ts` and
  `notifications.page.ts`: `DatePipe` left, `lang.dateTime` in its
  place; the fifteen notification labels are `notifications.labels`,
  read with today's fallback to the raw kind. `log.page.ts`: its four
  pieces; the log's text stays raw.
- `components/identity-form.component.ts`: `TextField` lost `label`;
  the seven labels are `identityForm.fields`, keyed by the field key.
  `IdentityFormState` injects the language service (a plain class, but
  both pages make it in a field initializer, an injection context):
  `countries` is a computed over the tag, `dateText` passes the tag.
  `camera.component.ts` and `copy-button.component.ts`: their words
  from the dictionary; the copy button's `label` input defaults to
  null and the template falls back to `common.copy`.
- `countries.ts`: `countryOptions(tag)` and `countryName(code, tag)`
  name and sort in the app's language (they named in English before,
  whatever the browser's language); the callers pass `lang.tag()`: the
  identity form now, and `marketplace.page.ts`, `listing.page.ts`,
  `listing-new.page.ts` and `listing-card.component.ts` with their
  `lang` injection, their sentences waiting for step 6.
- The services: `passkey.service.ts` (the three thrown sentences;
  `asPublicKeyCredential`, a function outside the class, takes the
  sentence as a parameter), `shares.service.ts` (`DepositError` takes
  the finished sentence, built by its two throw sites from
  `shares.refused`; the no-identity sentence), `signing.service.ts`
  (the two sentences as functions of the reason),
  `keyholder-api.service.ts` and `masterpod-api.service.ts`
  (`api.noSession`), `log.service.ts` (`api.network`; the log's time
  stamp with the tag).
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): `notifications.labels`, the
  fifteen kinds. `setup.steps` is a `string[]` whose length the type
  cannot check either: eight in both.
- Readings where the plan left a detail open: `identityForm.fields` is
  typed by its seven keys rather than `Record<string, string>`, so a
  missing Thai label fails the build, and the identity page reads the
  form's section for the labels, "Unknown", "Country of birth" and
  "Date of birth"; "First name" and "Last name" live both in `create`
  and in `identityForm.fields`, since a keyed table needs all its keys;
  a page title that equals its navigation label (Setup, Vouch requests,
  Notifications, Log) lives in the page's section; the create stepper's
  "Username" step label is `create.stepUsername`, the field label
  `common.username`; Retry, Start, Clear, Search and Copy joined
  `common` here, the first step to meet them, as the rule of the plan's
  1.1 says, though its step 3 names some of them. Thai: the instruction
  lines of the vouching page put the Thai button words in quotation
  marks ("ค้นหา", "ส่งคำขอ", "ปลดล็อก", "การแจ้งเตือน"), which the
  English does not need, since Thai has no capital letter to mark a
  button word; words outside the plan's glossary: lookup id รหัสค้นหา,
  a share (of a secret) ส่วนแบ่ง, session เซสชัน, hash แฮช, wrap
  ห่อหุ้ม, authenticator ตัวยืนยันตัวตน. One sentence read odd and was
  moved as it is: "Ask a couple people you know who are a part of the
  anoSphere for their username."
- Spec: 8.8 (the list), this note.
- `npx ng build` clean (1.71 MB initial). Not run in a browser here;
  the user tests with `ng serve`, a browser set to Thai for the Thai
  pages, any other for English.

### The languages, step 3 (2026-11-06)

Step 3 of forclaude/wallet-languages-plan-1.md: Home, the Wallet page,
the Account pages and the balance card. Why: after step 2 the pages of
the first visit were Thai, while Home, the Wallet page and the Account
pages, the pages of every day after it, were still English.

- `i18n/en.ts` and `th.ts`: the sections `home`, `wallet`,
  `accountHome`, `recovery`, `balanceCard` and `accountKinds`, and the
  `common` entries "Reading…", "<n> anos" (a function), "Copy the
  account id", 'The encryption key is not in RAM: unlock again', Done,
  Remove, "Account recovery" and the step label "Selfie". The sentences
  with a count, a name or an amount are functions (`hello`,
  `finishCreating`, the three unread counts; the wallet's `available`
  and the four held kinds; `selfiesOnFile`, `detailsOnFile`;
  `doneOnFile`, `onFile`; the card's `available`, its four held lines,
  `notLanded`, `notRead`; the two `retryFresh`).
- `account-names.ts`: `accountNames(accounts, kinds)`; the name of one
  of a type is `kinds[type]`, else the type word and "account"; the
  numbering as it was. The callers pass `t().accountKinds`: Home, the
  Wallet page and, with its `lang` injection, the history page, whose
  sentences wait for step 4.
- `home.page.ts`: the greeting and the to-do lines from functions;
  `count()` gone. `wallet.page.ts`: `STEPS` left the file for
  `wallet.steps`; the type select shows `typeOption(type)`, the raw word
  in English and the glossary's in Thai; `balanceWords` and `heldWords`
  from functions; the sentences from the dictionary.
- `account-home.page.ts`: the two rows' counts from functions; the
  `count` import gone. `account-recovery.page.ts`: the seven step labels
  as `[label]`, the six long paragraphs, `onFile` a function of the
  three counts, `finishLabel` from entries, the five progress sentences,
  the alt and aria words; the exported `count()` gone with its last
  importer. The two optional steps show Material's "Optional" from the
  service (step 1).
- `components/balance-card.component.ts`: the `lines` computed from
  functions, the aria label as a binding. `services/balances.service.ts`:
  `common.noKeyInRam`.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): `accountKinds`, the four types.
  `wallet.steps` is a `string[]` of six, its length unchecked.
- Readings where the plan left a detail open: the Wallet page's 'The
  encryption key is not in RAM: unlock again.' ends with a period where
  the balances service's does not, so it is `wallet.noKeyInRam`, its own
  entry, and `common.noKeyInRam` is the one without, each English letter
  for letter; 'This account is not one of this anoPod's accounts', named
  by the plan among this step's `common` entries, has no reader in this
  step's files and is added in step 4, the first step that meets it;
  "<n> anos" (the card's total, an account card's balance) is one
  function, `common.anos`; the Account page's subtitle and the
  walkthrough's title, both "Account recovery", are
  `common.accountRecovery`; "Remove" (the aria label, also on the
  account page) is `common.remove`; "Done" is `common.done` as the plan
  says, though only the walkthrough shows it today; the step label
  "Selfie" moved from `create.stepSelfie` to `common.selfieStep`, one
  line of `create.page.ts`, since this step met it on a second page
  (the rule of the plan's 1.1); `finishCreating` takes the account's
  name with `?? ''`, since `Map.get` is typed as possibly undefined
  though every account has a name; the walkthrough's "Email", a step
  label and a field label, is one entry. Thai: "Finish" and "Done" both
  read เสร็จสิ้น; the progress lines keep bucket in Latin letters, the
  security buckets' name; "break-glass seed" reads seed ฉุกเฉิน; "Up
  to five photos" reads สูงสุด 5 รูป, digits by the style rule. No
  sentence read odd.
- Spec: 8.8 (the list), this note.
- `npx ng build` clean (1.73 MB initial). Not run in a browser here;
  the user tests with `ng serve`.

### The languages, step 4 (2026-11-06)

Step 4 of forclaude/wallet-languages-plan-1.md: the account page, the
transaction history, the escrow trade, the assisted transfer, the three
stage helpers, the history words, the minutes words and the chat
service's day and time words. Why: these are the pages of sending and
receiving anos, the heart of the wallet, and the last English pages a
person meets before the chat and the marketplace.

- `i18n/en.ts` and `th.ts`: the sections `account`, `history`,
  `escrow`, `assisted`, `escrowStages`, `assistedStages`, `lockedStages`,
  `historyWords`, `sides`, `dismissReasons` and `minutes` (a function of
  the minutes: the English body of minutes-words.ts moved as it was, the
  Thai "15 นาที", "1 ชั่วโมง 30 นาที", "7 วัน 10 นาที", the parts joined by
  a space), and the `common` entries Account, Type (moved from `wallet`,
  since the account page shows the same label), Kind, Amount, Made,
  Stage, Transaction, To, From, Reason, Closed, Loading, "Copy the
  transaction id", "Transaction history", "Assisted transfer", the two
  "This page refreshes every 5 seconds…" sentences, 'This account is not
  one of this anoPod's accounts' (left over from step 3) and "another
  reason". th.ts gained a module-level `KINDS` table of the four account
  types' words, read by `wallet.typeOption`, `account.title` and the
  lock line.
- `escrow-stage.ts`, `assisted-stage.ts`, `locked-stage.ts`: each
  function takes `words`, the dictionary's table for it; the switches
  stay. `history-words.ts`: `historyWords(t, accountId, words)`, the
  titles as entries and functions of the short id, the kinds as entries,
  `TRANSFER_KINDS` as `historyWords.transferKinds`; the signs, the icons
  and the default branch stay. `minutes-words.ts` moved to the
  scratchpad: `t().minutes(n)` replaces it.
- `account.page.ts`: every sentence from `t().account`, `common` and
  `nav` (the Wallet back link); the spending kinds, the stake purposes
  and the votes show words from tables while their values stay; the lock
  line a function of the type and `t().minutes(ahead)`; the five date
  pipes are `lang.dateTime` and `DatePipe` left. Kept as they are, by
  decision 14: the labels "Fund proposal transactionId" and "Recipient
  accountId", the buttons "Send guardianVote" and "Send fundProposal",
  the wire word after Send, the paths and reasons in thrown lines.
- `transaction-history.page.ts`: its words, "To" / "From" from `common`,
  the day headings and times from the chat service (below); `DatePipe`
  left. `escrow-trade.page.ts`: `YES_LABELS` and `SENT` left the file
  for `escrow.yes` and `escrow.sent`; `explain`, `verdictsText`,
  `question`, `closedText` and `plainReason` read entries and functions;
  "You are the seller" is `escrow.youAre(t().sides[side()])`.
  `assisted-transfer.page.ts`: `caseText`, `explain` and `plainReason`
  likewise; the dismissal reasons are read from `t().dismissReasons`,
  the import from `my-case.page.ts` gone (that file keeps its own table
  until step 7). `chat.service.ts`: `shortWhen`, `timeOf` and `dayLabel`
  pass the service's tag and read Today and Yesterday from `dates`.
  `pinned-listing.component.ts`: its `lang` injection and the words
  passed to `escrowStageWords`; its sentences wait for step 6.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): `historyWords.transferKinds`
  (the four transfer types) and `dismissReasons` (the six reasons). The
  stage tables, `sides`, the spending kinds, the stake purposes, the
  votes and `historyWords.kinds` are typed by their keys, so the type
  checks them.
- Readings where the plan left a detail open: the templates of the
  account, history, escrow and assisted pages named their block or loop
  variable `t` (`@if (trade(); as t)`, `@for (t of day.rows)`), which
  would shadow the dictionary's `t()` inside those blocks, so those
  variables are now `open` (the trade), `held` (the assisted transfer),
  `waiting` (the locked transfer) and `row` (a history row), nothing
  else about them changed; the assisted page's closed sentence "Done.
  The 5 anos went to <id>." keeps the id in code font, so it is two
  entries, `doneWentTo` before the id and `doneEnd` after it (the
  English period, nothing in Thai); "another reason" is both the
  `dismissReasons.other` entry and `common.anotherReason`, the fallback
  when a dismissal carries no reason; the account page's "Type" label
  made `wallet.type` of step 3 a `common.type`, one line of
  `wallet.page.ts`; the Wallet back link reads `nav.wallet`; the "Escrow
  trade" title stays in `escrow`, since the pinned card's "Escrow
  trade: …" is another sentence. Thai: the account types inside
  sentences come from the `KINDS` table ("การโอนจากบัญชีหน่วงเวลา…");
  "It cannot be undone" reads เปลี่ยนกลับไม่ได้; "Held" reads ถูกกันไว้;
  the stake purpose daoVote reads โหวต DAO and masterPod stays as it
  is. No sentence read odd.
- Spec: 8.8 (the list), this note.
- `npx ng build` clean (1.78 MB initial). Not run in a browser here;
  the user tests with `ng serve`.

### The languages, step 5 (2026-11-06)

Step 5 of forclaude/wallet-languages-plan-1.md: the chat, its four
pages and the rest of the chat service. Why: after step 4 every page of
the wallet's own money was Thai, while the chat, where a Thai buyer and
seller meet, still spoke English; its day and time words came in step
4, the rest comes here.

- `i18n/en.ts` and `th.ts`: the sections `chat`, `chatNew`,
  `chatRequests`, `chatRoom` and `rooms` (the room titles and the
  listing words the chat service builds), and the `common` entries
  Chats, "New chat", Requests, "Back to chats", Find, Accept, Create
  (moved from `create`, the step label of the create stepper, since the
  new public room's button shows the same word), Send (moved from
  `account`, since the conversation's send button shows the same word),
  Name, the shown "No chat keys in this tab: unlock again." (the chat
  list, the new chat and the listing page), and the thrown 'No chat
  keys in this tab', 'That anoPod has no chat keys (setup not
  complete)', 'No room key for this room in this tab', 'No room key for
  this room' and 'Find the username first', each thrown by two files;
  the marketplace files read them in step 6. The sentences with a
  number or a name are functions (`requestLine` of the two counts,
  `byAndMembers`, `aboutListing`, `invitedToRoom`, `asksToJoin`, and
  the room words `sell`, `buy`, `selling` and `buying` of the amount
  and the currency, `invited` of the username).
- `services/chat.service.ts`: `title` and `listingWords` read
  `t().rooms`; the two thrown sentences from `common`. Kept: the room
  types, `listing.side`, the icon names, the console line.
- `pages/chat.page.ts`: `count()` gone, the Requests row's line a
  function of the two counts; "You: ", "(cannot read)", "No messages
  yet" and the list's pieces from the dictionary; the two "New chat"
  aria labels as bindings. `pages/chat-new.page.ts`: the three tab
  labels as `[label]`; "by <username> · N member(s)" a function; the
  thrown sentences from `common` and `chatNew`.
  `pages/chat-requests.page.ts`: `inviteText` reads the three functions
  and entries; "asks to join <room>" a function, the username in bold
  before it; "your room". `pages/chat-room.page.ts`: the menu items,
  the aria words More, Send and "Back to chats" as bindings,
  "(invited)", "(cannot decrypt)", "(no room key)", "Sending", "Load
  older messages", the copy button's label as a binding; the members
  line reads `rooms.invited` for the invited; the thrown sentences.
  `pages/create.page.ts` and `pages/account.page.ts`: the one and the
  two lines that now read `common.create` and `common.send`.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
- Readings where the plan left a detail open: a word the grep found on
  another page, even one of a later step, went to `common` now rather
  than to the page's section and a move later: Accept (the listing
  people, step 6), Name (the staff pages' profile label, step 8), Send
  (the listing page's button, step 6) and the shown and thrown chat-key
  sentences; "Back to chats", an aria label on three chat pages, is
  `common.backToChats` though the plan lists it under the conversation;
  "No messages yet" (the list's preview, no period) and "No messages
  yet." (the empty thread) are two entries, `chat.noMessages` and
  `chatRoom.noMessages`, each English letter for letter; "<username>
  (invited)" is one function, `rooms.invited`, read by the service's
  title and by the conversation's members line, while the members
  panel, where the username is its own element, reads the bare
  `chatRoom.invited`; `invitedToRoom` takes `string | null`, the type
  of an invite's `name`, so the English stays what it was; the " · "
  between the people and the listing's words stays in the code,
  punctuation the same in both languages. Thai: "Sell" and "Selling"
  both read ขาย and "Buy" and "Buying" both ซื้อ, since Thai has no
  participle ("ขาย 50 anos รับ THB", "ซื้อ 50 anos ด้วย THB"); Find
  reads ค้นหา like Search; Leave reads ออกจากห้อง, the room named as
  Thai needs; members are counted with their classifier ("สมาชิก 3
  คน"). No sentence read odd.
- Spec: 8.8 (the list), this note.
- `npx ng build` clean (1.79 MB initial). Not run in a browser here;
  the user tests with `ng serve`.

### The languages, step 6 (2026-11-06)

Step 6 of forclaude/wallet-languages-plan-1.md: the marketplace, its
four pages, the five components and the marketplace service, with the
currency names. Why: after step 5 a Thai buyer and seller could chat in
Thai, while the place they meet, the marketplace, still spoke English;
the country names already followed the language (step 2), the currency
names and the words follow now.

- `i18n/en.ts` and `th.ts`: the sections `marketplace`, `listing`,
  `listingNew`, `myListings`, `listingCard`, `listingPeople`, `pinned`,
  `filters`, `picker` and `market` (the service's side words and the two
  first messages), and the `common` entries Side, Country, Currency,
  Filters, "New listing", "Your listings", "Back to the marketplace",
  "Total …" and "… per anos" (functions), "Quantity, anos", "Price per
  anos", the close question ("Close this listing? People can no longer
  connect; your chats stay."), Yes, Cancel, "Open chat", 'This chat is
  not about a listing' and 'No latest transaction on the ledger yet'
  (moved from `account`, since the pinned card throws it too). The
  sentences with a number, a name or an amount are functions
  (`filtersCount`, `mineLine`, `sideAnos`, `posted`, `waitingFor`,
  `didNotAccept`, the card's `line` and `where`, the pinned card's
  `summary`, `tradeLine`, `atListingPrice`, `askStart`, `released`,
  `refused` and the two posted messages `shareMessage` and
  `startedMessage`).
- `services/marketplace.service.ts`: `sideWords` and `firstWords` read
  `t().market`, so the first message of Connect goes in the sender's
  language (decision 10); the four thrown sentences from `common`.
  `prices.ts`: `currencyOptions(tag)` names the currencies in the app's
  language; Browse and the new-listing form pass `lang.tag()`.
- `pages/marketplace.page.ts`: `SORT_WORDS` left the file for
  `marketplace.sorts`, read by the sort chip and the three menu items;
  the chips All, Selling and Buying, the Country and Currency chips and
  picker titles, the Filters chip with its count, the Your listings row
  and its line from the dictionary. `pages/listing.page.ts`: its words
  from `listing` and `common`; "posted <date>" with `lang.dateTime` and
  `DatePipe` gone; "This listing is closed." one entry for its three
  places. `pages/listing-new.page.ts`: the toggle's words, the labels,
  the total, the picker titles and the three thrown sentences.
  `pages/my-listings.page.ts`: its nine pieces.
- `components/listing-card.component.ts`: the labels Yours, Waiting and
  "Chat open" from `listingCard.labels`, Closed from `common`, still the
  `@for` track key; the three lines as functions.
  `components/listing-people.component.ts`: "wants to chat" after the
  username in bold, Accept, Decline, "Open chat", "Nobody has connected
  yet.". `components/pinned-listing.component.ts`: every sentence from
  `pinned` and `common`; the account menu shows `account.title(type)`,
  as the plan says ("spending account" where it read "spending"); the
  labels From and To from `common`; the two posted messages in the
  sender's language. `components/filters-sheet.component.ts` and
  `picker-sheet.component.ts`: their words; the picker's search matches
  the typed letters against the names, so Thai names are found by Thai
  letters, and the three-letter code rule stays Latin.
  `pages/account.page.ts`: the one line that now reads `common.noLatest`.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
  `marketplace.sorts` and `listingCard.labels` are typed by their keys.
- Readings where the plan left a detail open: the Browse chips Selling
  and Buying read `market.selling` and `market.buying`, the service's
  side words, rather than entries of their own; the card's Closed label
  reads `common.closed` (step 4's entry) rather than a fourth entry of
  `listingCard.labels`; the pinned card's template variable `t` (the
  trade) is now `open`, as the trade page's is, since it would shadow
  the dictionary's `t()`; "wants to chat" is an entry after the username
  in bold, as the requests page's "asks to join" is, not a function of
  the username; the pinned card's Start button reads `common.start` and
  its "No latest transaction…" the moved `common.noLatest`; the words
  the grep found on another page went to `common` now (Cancel is also
  on the staff pages of step 8); the "Total …" and "… per anos"
  functions live in `common`, each on two files. The English of the
  pinned card's account menu changes by the plan's own instruction
  (its section 6): "spending account" after the short id, where it read
  the raw "spending". Thai: "Selling" / "Buying" read ขาย / ซื้อ, as the
  chat's room words do; "each" in the summary reads ต่อ anos; "People",
  the heading of the people who connected, reads ผู้ติดต่อ; "Any" reads
  ใดก็ได้; "Apply" reads นำไปใช้; "Quantity, anos" and "Amount, anos"
  both read จำนวน, anos; the counts of the Your listings row carry their
  classifiers ("เปิดอยู่ 2 รายการ · 1 คนกำลังรอ"). No sentence read odd.
- Spec: 8.8 (the list), this note; 8.7 is not reworded, it quotes the
  English.
- `npx ng build` clean (1.80 MB initial). Not run in a browser here;
  the user tests with `ng serve`.

### The languages, step 7 (2026-11-06)

Step 7 of forclaude/wallet-languages-plan-1.md: the recovery flow (the
Recover page, the locked-out stepper and My recovery) and the cases (the
list and My case). Why: after step 6 the pages of every day were Thai;
these are the pages of a bad day, a lost device or a dispute, where a
Thai reader needs the words most.

- `i18n/en.ts` and `th.ts`: the sections `recover`, `recoverOpen`,
  `recoverCase`, `cases`, `myCase` and `caseStatus` (the four case
  statuses of `attesting.page.ts`'s `STATUS_WORDS`), and the `common`
  entries "I'm locked out", "Recover account" (moved from `landing`,
  since My recovery links to it), "checking…" (moved from `create`,
  since the locked-out stepper's username hint reads it), "I have
  written it down, complete" (moved from `setup`, since the new backup
  code's button reads it), "Case <id>" (a function), "Copy the case id",
  "Could not copy; select the id by hand.", Timeline, "Nothing yet.",
  "Meeting link", Evidence, "Loading your case…", "Video call scheduled
  for <at>." and "a time to be confirmed", and "Dismissed: <reason>" (a
  function; the status line of My case, which ends with a period, has
  its own). The sentences with a number, a name, an amount or a date are
  functions (`found`, `statusOpen`, `statusDelivering`,
  `noCodeRebuilt`, `notTakingFinish`, `retryDeposits`, the plurals
  `codesRecovered`, `seedsRecovered`, `sharesSkipped`, `seedsUnmatched`
  and `storedOn`; the cases' `anos`, `line` and `youAre`; My case's
  `youAre`, `upload`, `yourFiles`, `fromCase`, `decidedDispute`,
  `statusDismissed`, `badType`, `tooLarge`, `encrypting`, `uploading`,
  `uploaded`, `refusedValues`, `eventAdded` and `eventDecided`).
- `pages/recover.page.ts`: its eight pieces and the thrown sentence from
  the dictionary. `pages/recover-open.page.ts`: the three step labels as
  `[label]`; the username hint's three states ("the username of the
  anoPod you lost", "checking…", "<username> found") and the thrown
  sentences; the hint still shows the server's reason as it comes.
  `pages/recover-case.page.ts`: `DISMISS_REASONS` left the file for
  `recoverCase.dismissReasons`; `statusText`, `combinedText`,
  `breakGlassText`, `dismissReason` and `textOf` read entries and
  functions; the five step labels as `[label]`, Done from `common`; the
  two `toLocaleString` calls are `lang.dateTime`.
- `pages/cases.page.ts`: the row's pieces from `cases` (the "· N anos",
  "· with" and "· transaction" fragments before their ids, the status
  line as a function with `lang.dateTime`; `DatePipe` left); the status
  words from `t().caseStatus`, the `STATUS_WORDS` import gone, the icons
  still imported. `pages/my-case.page.ts`: its `DISMISS_WORDS` table and
  export gone (the assisted transfer page reads `t().dismissReasons`
  since step 4, and this page now does too); the status words from
  `t().caseStatus`; `title`, `statusText`, `refusal`, `dismissReason`
  and `textOf` read entries and functions; "You are the <side> of this
  escrow." a function of `t().sides`; the three `toLocaleString` calls
  are `lang.dateTime`. `pages/create.page.ts`, `pages/landing.page.ts`
  and `pages/setup.page.ts`: the one line each that now reads the moved
  `common` entry.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): `caseStatus` (open, inReview,
  decided, dismissed) and `recoverCase.dismissReasons` (selfieMismatch,
  documentsMismatch, unknownLookupId, noShow, other: the "you" wording
  of the recovery, whose keys differ from the trade cases'
  `dismissReasons` of step 4).
- Readings where the plan left a detail open: the Cases page's title is
  `cases.title` and My case's back link reads `nav.cases`, as a page
  title equal to its navigation label lives in the page's section (step
  2) and a back link reads the label (step 4); the status words are
  read with a fallback to the raw status (`t().caseStatus[c.status] ??
  c.status`), as the other `Record` tables are, though the typed table
  of `attesting.page.ts` had none; "Dismissed: <reason>" without a
  period, in three places, is `common.dismissed`, and My case's status
  line with the period is `myCase.statusDismissed`; "no anoPod has that
  username" (the hint) and "No anoPod has that username" (thrown) are
  two entries, each letter for letter; "Upload <n>" keeps today's shape
  as a function of the count, `Upload ${n || ''}`, so the button reads
  "Upload" with nothing picked; the " · " before the skipped shares and
  the unmatched seeds stays in the code; "Combine", "Get back in" and
  "Open my case" are one entry each for the step label and its button;
  "copied" reads the copy button's `copy.copied`; the file link text
  "PDF", a format name, and the raw verdict and event kinds stay as
  they are. Thai: Combine reads รวมส่วนแบ่ง, the shares named as Thai
  needs; the bankers read นายธนาคาร; "break-glass keys" reads
  กุญแจฉุกเฉิน after step 3's seed ฉุกเฉิน; Timeline reads ไทม์ไลน์;
  Dismissed reads ถูกยกคำร้อง, the glossary's word. No sentence read odd.
- Spec: 8.8 (the list), this note; 12.3 is not reworded, it quotes the
  English.
- `npx ng build` clean (1.85 MB initial). Not run in a browser here;
  the user tests with `ng serve`.

### The languages, step 8 (2026-11-06)

Step 8 of forclaude/wallet-languages-plan-1.md, the last: the moderation
and attesting pages of the staff editions, with the attesting service.
Why: the staff pages were the last English in the app; with them every
page of every edition speaks both languages, and the plan is built.

- `i18n/en.ts` and `th.ts`: the sections `moderation`, `moderationCase`,
  `attesting` (the attesting list page and the sentences the three
  attesting pages and the attesting service share), `tradeCase`,
  `disputeCase`, `recoveryStatus` (the six recovery statuses of
  `moderation.page.ts`'s `STATUS_WORDS`), `dismissReasonsStaff` (the
  "the person" wording, the union of the moderation case's five keys and
  the attesting pages' six) and `buckets` (the two titles); and the
  `common` entries the moderation and attesting pages share: Status,
  "unknown pod", "The person", "public selfie", "Copy the lookup id",
  "<status> · opened <date>", "Loading the case…", Schedule, "Video
  call", "Meeting link (https)", Save, "Anos account", "Pull key", the
  bucket summary and its locked-rows fragment, "bucket image", Verdict,
  Note, Dismiss, "Confirm dismissal", "Pick one of your anos accounts
  first.", "Enter the time of the call.", the scheduled line, the pull's
  progress and refusal sentences, "This case is closed: nothing more can
  be done to it.", the two signature refusals, "Could not copy; select
  the text by hand.", "pod <id>…", "Note: <note>", "<who> scheduled the
  video call for <at>", "<who> read bucket one/two (N keys)", "<who>
  dismissed the case: <reason>" and "<username> · <first> <last>". Eight
  words earlier steps put in page sections moved to `common`, since a
  staff page shows them too: "Your account" (from `accountHome`), 'The
  encryption key is not in RAM: unlock again.' with its period (from
  `wallet`), Seller and Buyer (from `escrow`), Email (from `recovery`),
  "· N anos" (from `cases`), the refused-values sentence and 'Decided:
  two attestors signed' (from `myCase`); one line of each of those pages
  changed.
- `services/attesting.service.ts`: `attestingError` and
  `validatorRefusal` take the dictionary (`words: Words`) as a third
  parameter, since they are plain functions that cannot inject; every
  caller passes `this.t()` or `this.lang.words()`; the regexes and the
  `${path}: ${reason}` fallbacks stay. `pages/moderation.page.ts`:
  `moderationError` likewise; `STATUS_WORDS` left the file for
  `recoveryStatus`; the person line and the approvals line are
  functions with `lang.dateTime`.
- `pages/moderation-case.page.ts`: `DISMISS_WORDS` and the `BUCKETS`
  titles left the file (the paths and share types stay); the status and
  reason words from `recoveryStatus` and `dismissReasonsStaff`; the
  sign-offs, the bucket summary, the timeline's `itemOf` and the
  refusals read entries and functions; the two date pipes and three
  `toLocaleString` calls are `lang.dateTime`; the note's placeholder
  translates with its "14:00 UTC"; the URL placeholder and the native
  `datetime-local` input stay.
- `pages/attesting.page.ts`: `STATUS_WORDS` and `DISMISS_WORDS` left the
  file; `CASE_STATUSES`, `REVIEW_STATUSES` and `STATUS_ICONS` stay
  exported; the tab labels as `[label]` functions of the counts; the
  attestations and verdicts plurals, the "disputed by" words and the
  person line from the dictionary; `DisputeRow.disputedBy` is a string
  of the dictionary's words; the three pipes are `lang.time` and
  `lang.dateTime`. `pages/attesting-trade-case.page.ts` and
  `pages/attesting-dispute-case.page.ts`: `BUCKETS` titles from
  `t().buckets`; the explain switches, the plurals, "The <side>'s files",
  the Success / Cancel and reason options, the sending lines and the
  refusals from the dictionary; the English appended to a username after
  a file that did not open is `disputeCase.didNotOpen`; the pipes and
  `toLocaleString` calls as above.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): `recoveryStatus` (six statuses)
  and `dismissReasonsStaff` (seven reasons). `buckets` is typed by its
  keys.
- Readings where the plan left a detail open: the attesting service's
  sentences live in `attesting`, the section the three attesting pages
  share, as `market` holds the marketplace service's; sentences the
  three attesting pages share ("Send to the validators", "an attestor",
  the no-account hint, the validator's refusal line) live in `attesting`
  too, while sentences the moderation pages share with them live in
  `common`; the plan's `common.noKeyInRam` for the service is the
  sentence with its period, so it is `common.noKeyInRamSentence`, moved
  from `wallet`, and `common.noKeyInRam` without the period stays as it
  was; "This account is not one of this anoPod's accounts." with its
  period is `common.notMyAccountSentence` beside the step 4 entry
  without one; the account pickers show `wallet.typeOption(type)` for
  the raw type word, as the Wallet page's select does; the status words
  are read with a fallback to the raw status, as the other `Record`
  tables are; the trade case page's template variable `t` (the trade)
  is now `held`, as the assisted transfer page's is; the dispute case
  page's party sides are `'seller' as const` and `'buyer' as const`, so
  the template can read `t().sides`; the moderation case's back link
  "Cases" reads `nav.cases`; the "→ HTTP <status>" fragments, the
  "data:" URL, the URL placeholder and the "…" after an id stay in the
  templates; the person line prints an empty name where the masterpod
  sends null, as the template did. Thai: "the bankers" read นายธนาคาร;
  bucket stays Latin ("Bucket หนึ่ง", "Bucket สอง"); "sign off" reads
  ลงนามรับรอง; "the person" reads บุคคล; Reject reads ไม่อนุมัติ. No
  sentence read odd.
- Spec: 8.8 (the list, now complete), this note; 13.3 is not reworded,
  it quotes the English.
- `npx ng build` clean (1.89 MB initial). Not run in a browser here;
  the user tests with `ng serve`.

### Protect your passkey, step 1 (2026-11-07)

Step 1 of forclaude/wallet-protect-plan-1.md, its only step: the Protect
your passkey pane at the end of setup on an Android phone. Why: on an
Android phone the wallet's passkey is usually kept by Google Password
Manager, under the person's Google account, so whoever takes over that
Google account is within reach of the passkey and of the anoPod it
opens. Google's Advanced Protection Program makes a Google account very
hard to take over: signing in needs a passkey or a security key, account
recovery is slow and strict, and most outside apps are kept out; a
person can enrol with a passkey on the phone itself, free, in a few
minutes. Nothing in the wallet told people this. A step at the end of
setup, strongly recommended with the why and the benefits, that nobody
can pass without choosing, will get many of them to do it.

- `pages/setup.page.ts`: `MatRadioModule`, new to the app (the identity
  page's checkbox was the only such control); the module constant
  `ADVANCED_PROTECTION_URL`, Google's page; the fields `android` (the
  user agent string contains "Android"), `advancedProtectionUrl`,
  `choice` (a signal: done, skip or null) and `nextUrl`; a new template
  branch for `phase() === 'done'` on Android, between the idle branch
  and the progress list: the title, "Strongly recommended." in bold with
  the benefits, the why, what it does, the caution, the button to
  Google's page (a new tab, `rel="noopener"`), "Then choose one:", a
  radio group of the two choices and Continue, off until one is picked;
  `complete()` keeps the next-step rule's page in `nextUrl` and on
  Android returns instead of leaving, so the pane shows in place of the
  progress list; `goOn()`, Continue, goes to that page. The 409 path
  leaves at once, as before, without the pane; on an iPhone or a
  computer nothing changes. One style line, `.choices`.
- `i18n/en.ts` and `th.ts`: ten entries in `setup`, after
  `alreadyComplete`: `protectTitle`, `protectRecommended`,
  `protectBenefits`, `protectWhy`, `protectWhat`, `protectCaution`,
  `protectOpen`, `protectThen`, `protectDone` and `protectSkip`; the
  English the plan's 1.2 letter for letter, the Thai written from the
  glossary and style of the languages plan's 1.6 and the Thai settled in
  the notes above. Continue is `common.continue`, already there; nothing
  goes to `common`. No entry is a function.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
- Readings where the plan left a detail open: the template branch and
  the fields take the file's own indentation, the plan's snippets being
  relative; the `.choices` line is the last of the styles block; the new
  fields sit right after `backupCodeText`, before the comment over the
  secrets' fields, with no blank line between; the class comment was
  re-wrapped from the new sentence on, and the 8.2 Setup paragraph
  likewise. Thai: "Strongly recommended." reads แนะนำอย่างยิ่ง;
  "security key" reads คีย์ความปลอดภัย, as Google's Thai pages write it;
  "takes over" reads เข้าควบคุม and "that takeover" การเข้าควบคุมนั้น;
  "within their reach" reads เขาก็เข้าถึงพาสคีย์ของคุณได้ (they can then
  get at your passkey); "It is free" reads ไม่มีค่าใช้จ่าย; "Then choose
  one:" reads จากนั้นเลือกข้อใดข้อหนึ่ง:; "I turned it on" reads
  ฉันเปิดใช้แล้ว and "Skip for now" ข้ามไปก่อน; the button reads
  เปิดหน้า Advanced Protection ของ Google, "open the page", since เปิด
  alone also means "turn on" and would read like the choice under it;
  Google, Android and Advanced Protection stay in Latin letters with a
  space on each side. No sentence read odd.
- Spec: 8.2 Setup (the pane), 8.8 (the paragraph after the list), 10
  (the bullet), this note; README: nothing to change.
- `npx ng build` clean (1.92 MB initial). Not run in a browser
  here; the user tests with `ng serve` (Chrome's device toolbar
  emulating a Pixel sends an Android user agent, so the pane shows on
  the Mac too) and on an Android phone on the testnet, after Complete.

### The wallet memory, step 2 (2026-11-07)

Step 2 of forclaude/wallet-notes-plan-1.md: the wallet's side of the
notes, on the transaction history page. Why: people who report income
or capital gains need, for every transaction, what money they paid or
received and in which currency; the ledger knows the anos, the time and
the other account, not the money, and until now the wallet kept nothing
of its own. Step 1 gave the masterpod the two tables and the six routes
(4.6, 4.7); this step gives the history page a note per row, the private
part encrypted on the phone before it leaves.

- `services/crypto.service.ts`: `wrapJson` and `unwrapJson`, a JSON
  value as UTF-8 under a key (section 7), after the identity blob
  methods.
- `services/masterpod-api.service.ts`: `NoteFields`,
  `NotedTransactionItem` and `NoteRange`, and the four noted transaction
  methods in a group after the anos accounts.
- `services/notes.service.ts`, new: `NOTE_KINDS`, `MONEY_KINDS`,
  `OTHER_KINDS`, `NoteDetails` and `Note`; the `notes` and `more`
  signals and `byTransaction`; `load`, `add`, `update` and `remove`,
  each wrapping or opening the private part under the encryption key;
  `presetKind`, `startingCurrency` and `clearOf`.
- `prices.ts`: `perAnosOf`, the price per anos behind a total, rounded
  down to eight decimals on the digits.
- `components/note-form.component.ts`, new: the form of 8.2, used under
  a history row now and under a Noted transactions row from step 3; the
  currency through the picker sheet as the new-listing page opens it.
- `pages/transaction-history.page.ts`: the notes loaded once, quiet; the
  note in short after the time; the Note and Memo lines in the details;
  Add a note, Edit and Remove with its ask, and the form under the grid.
- `i18n/en.ts` and `th.ts`: the section `notes`, after `history`;
  `kinds` typed by its keys, so a missing Thai kind fails the build.
  Reused from `common`: Note, Save, Cancel, Remove, Yes, Back, Currency
  and "per anos". Nothing goes to `common`.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
- Readings where the plan left a detail open: the notes are loaded
  inside the constructor's effect, so a change of the account input
  reloads them with the rows, and `load` checks the encryption key
  before the call, so a tab without it makes none; "the newest note" for
  the starting currency is the note made last (`createdAt`), not the one
  on the newest transaction; the plan's one `@if (noteOf(row))` block is
  split in two, the Note and Memo lines inside the details grid (whose
  children are `display: contents`) and the buttons after it, with the
  form in a `div.form` of the same left padding; the history page
  imports `perAnosOf` beside `formatPrice` for the per-anos part of the
  Note line; a note's money shows only with its currency, on the row and
  in the details (a drop-down kind may be saved with money and no
  currency, as the plan's Save rule allows); the Remove ask closes
  whether the remove succeeded or failed, a failure in red under the row;
  the form takes the amount from the note when editing and from the row
  otherwise; a price shows with two decimals as every price does, so the
  row reads "Sold · 3,550.00 THB". Thai: a "note", the record the person
  keeps of a transaction, reads บันทึก ("Add a note" เพิ่มบันทึก,
  "Remove this note?" ลบบันทึกนี้หรือไม่), while the details label is
  `common.note`, หมายเหตุ, as the moderation pages have it; "Memo" reads
  บันทึกช่วยจำ, as Thai banking apps name the free text on a transfer;
  "Tag" reads แท็ก; "Money" reads จำนวนเงิน; "Received as income" reads
  ได้รับเป็นรายได้; "Transferred to stake" โอนไปวางหลักประกัน and
  "Received from stake" ได้รับจากหลักประกัน; "own account" reads
  บัญชีของตนเอง; "Other" reads อื่น ๆ and "Other kinds" ชนิดอื่น ๆ (Kind
  ชนิด, as settled); "Edit" reads แก้ไข, as the identity page's. No
  sentence read odd.
- Spec: 4.6, 4.7, 7, 8.2 (Transaction history), 8.3, 8.8, 10, this note;
  README: the layout block (the note form, the notes service).
- `npx ng build` clean (1.94 MB initial). Not run in a browser here; the
  user tests with `ng serve` against a masterpod with the step 1 tables
  (locally `npm run db:setup` in the masterpod folder adds them).

### The wallet memory, step 3 (2026-11-07)

Step 3 of forclaude/wallet-notes-plan-1.md: the Noted transactions page,
every account's notes in one place for the tax return. Why: the history
page shows a note on its own row, account by account; the person doing
their taxes needs all of a year's notes together, the totals per
currency, and a file a spreadsheet opens.

- `app.routes.ts`: `/wallet/notes` before `/wallet/:accountId`, since
  the router takes the first match.
- `pages/wallet.page.ts`: a "Noted transactions" button under the
  balance card.
- `pages/noted-transactions.page.ts`, new: the history page's card
  layout; the Dates field, Refresh and "Download as CSV"; the chips All,
  Bought, Sold, Income and Other; the totals per currency; the capped
  line; the rows in day headings with the details, Edit (the note form,
  the amount from the note) and Remove; the CSV of the plan's 3.4 built
  on the phone.
- `pages/marketplace.page.ts`: the All chip reads `common.all`.
- `i18n/en.ts` and `th.ts`: eleven entries in `notes` after `withMoney`;
  `marketplace.all` moved to `common.all`, the house rule for a sentence
  two pages share; nothing else goes to `common`.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
- Readings where the plan left a detail open: the Other chip is every
  note whose kind is not bought, sold or income, a note that cannot be
  read among them, so no note hides from every chip but All; the rows
  keep the masterpod's order (newest transacted_at, then the highest
  position) and the day headings group them as the history page does; a
  note with money contributes a totals line for its currency even when
  its kind adds to none of the three sums, which then read 0; the sums
  are in price units (10^-8, as `priceUnits` counts them) and a private
  `unitsToText` in the page turns a sum into the decimal string
  `formatPrice` takes, since prices.ts is not among the step's files;
  `startOfDay` is repeated from the history page for the same reason;
  the page's per-anos method is `priceOf`, since `perAnosOf` is the
  imported function; the account's name falls back to "Account" for an
  account the session does not hold; the CSV's kind column is the row's
  title, so a blob that did not open writes "(cannot read)"; the Remove
  ask closes whether the remove succeeded or failed, as on the history
  page. Thai: "Noted transactions" reads ธุรกรรมที่บันทึกไว้; "Income",
  the chip, reads รายได้; "Download as CSV" reads ดาวน์โหลดเป็น CSV;
  "sent" and "received" in the CSV read ส่ง and รับ; the CSV header is
  translated as a whole, its commas kept, with "Other account" as
  บัญชีอีกฝ่าย (the other side's account) and "Anos" kept in Latin
  letters; "Narrow the dates" reads จำกัดช่วงวันที่ให้แคบลง. No sentence
  read odd.
- Spec: 8.1, 8.2 (Wallet, Noted transactions), 8.8, this note; README:
  the pages line.
- `npx ng build` clean (1.95 MB initial). Not run in a browser here; the
  user tests with `ng serve`: the Wallet page's button, the chips, a
  range, the download.

### The wallet memory, step 4 (2026-11-07)

Step 4 of forclaude/wallet-notes-plan-1.md, the last: the wallet
settings in use, the Protect your passkey answer first. Why: the Protect
pane of setup (2026-11-07, above) could keep no answer, so nothing could
remind someone who skipped it; with the masterpod's wallet_settings row
(4.7) the wallet remembers the answer under the pod's encryption key and
Home can show "Protect your passkey" until it is on.

- `services/masterpod-api.service.ts`: `getWalletSettings` and
  `setWalletSettings` in a group after the noted transaction methods.
- `services/settings.service.ts`, new: `WalletSettings` ({ v: 1,
  protect? }); the `settings` signal, null until read; `load`, quiet by
  default, which gives { v: 1 } for a null blob, a refusal or a blob that
  does not open and skips the read without the encryption key; `save`,
  the merged object wrapped under the encryption key and sent whole,
  after a load when nothing was read.
- `constants.ts`: `ADVANCED_PROTECTION_URL`, from the setup page.
- `pages/setup.page.ts`: the constant imported; `SettingsService`
  injected; the ten `t().setup.protect*` reads are `t().common.protect*`;
  Continue (`goOn`) records 'on' or 'skipped' before leaving, a failed
  save logged by the API service and not holding the person up.
- `pages/account-protect.page.ts`, new, at `/account/protect` after the
  two recovery routes: the pane's lines from `common`, the button to
  Google's page, the two choices and Save, which records the answer and
  goes to Home.
- `pages/home.page.ts`: `SettingsService` injected; `android`, the setup
  page's test; the "Protect your passkey" line after the two recovery
  lines while the recorded answer is skipped; `load` reads the settings
  after the accounts.
- `i18n/en.ts` and `th.ts`: `home.protectPasskey`; the ten
  `setup.protect*` entries moved to `common` under the same keys, the
  English and the Thai as they were, since the setup page and the
  protect page share them.
- Tables typed `Record<string, string>` added to the dictionaries (the
  type cannot check their keys in Thai): none in this step.
- Readings where the plan left a detail open: a refused
  `/get-wallet-settings` goes to the browser's console, since the read is
  quiet and so not in the activity log; the API service's class comment
  now names 4.7 beside 4.6; the Android comment on Home speaks of the
  line, not the pane; the protect page has an `.error` style line beside
  `.choices`, for the refusal in red; the ten entries sit at the end of
  `common`, after `all`; `home.protectPasskey` and `common.protectTitle`
  are the same English, as the plan lists them; the Home line sits after
  `addDetails` in the dictionary, in the order of the list. Thai: the
  Home line reads ปกป้องพาสคีย์ของคุณ, the pane's title; nothing else is
  new, the ten sentences moved as they were. No sentence read odd.
- Spec: 4.7 (the wallet's side), 8.1, 8.2 (Home, Setup, Protect your
  passkey), 8.3, 8.8, 10 (the protect bullet), this note; README: the
  pages and services lines.
- `npx ng build` clean (1.96 MB initial). Not run in a browser here; the
  user tests with `ng serve`: a pod set up on a Pixel-emulating Chrome
  that picks "Skip for now" sees "Protect your passkey" under Things to
  do on Home, and the page's Save with "I turned it on" removes it.

### The deposit floor (2026-11-07)

Built in the planning chat from `forclaude/wallet-deposit-floor-plan-1.md`
(FINAL), one commit.

- Proxy: `DEPOSIT_FLOOR_PERCENT`, default 80, 1 to 100 through a new
  `percent()` helper in `server/config.js`, answered by `/api/config` as
  `depositFloorPercent`; `network/wallet.env` carries 80.
- Browser: `SharesService.deposit` sends every share at once (one `send`
  per keyholder inside `Promise.all`, nothing in it throws), counts the
  201s and compares them with needed = max(ceil(keyholders × percent /
  100), shareThreshold), every keyholder when the proxy sends no percent.
  `DepositError` carries `stored`, `needed` and `failed` (the keyholders'
  numbers) instead of one keyholder; the five callers use `instanceof`
  and `message` only and did not change. `LogService.post` takes an
  optional `timeoutMs` (rxjs `timeout`; a `TimeoutError` becomes
  `{ ok: false, status: 0, body: { error: api.noAnswer(seconds) } }`, so
  it is logged and `reasonOf` reads it like any refusal);
  `KeyholderApiService.getPublicKey` and `receiveShare` pass it through;
  `KEYHOLDER_DEPOSIT_TIMEOUT_MS` is 15 000 in `constants.ts`.
- Words: `shares.floorNotReached(stored, keyholders, needed, keyholder,
  reason)` replaces `shares.refused`, which nothing else used;
  `api.noAnswer(seconds)` is new. The Thai lines were written here and are
  to be checked by a Thai reader.
- Spec: sections 2, 6, 10 and this note; README: the variables line.
- `npx ng build` clean (1.96 MB initial); `node --check` on the two server
  files. Not run in a browser here: the user deploys and tries a create
  account with one keyholder's VMs stopped, expecting the step to go green
  after about 15 seconds and the log to show that keyholder's two calls at
  status 0.

### The key blob under the passkey's key, step 4 (2026-11-08)

Built from `forclaude/break-glass-plan-1.md` (FINAL), section 4, one
commit; steps 5 and 6 follow in this repo, and the three are deployed
together after the testnet reset. Why: the key blob was under the
encryption key, which the backup code also opens, so a backup-code
recovery handed a person the original signing keys; from now on it is
under a key from the passkey's PRF output alone, a lost passkey loses it,
and the money moves to new accounts through the break-glass transfer
(step 5). What the plan left open was decided as follows.

- `crypto.service`: `INFO.kekKeys`, `deriveKekKeys(prfOutput)`;
  `wrapKeyBlob`, `unwrapKeyBlob` and `pairOneFromKeyBlob` take the key
  blob key; `wrapBreakGlassSeed` is gone. Added beyond the plan:
  `KeyBlobLostError`, thrown by `unwrapKeyBlob` when the AES-GCM open
  fails, so the pages tell a blob that does not open (a lost account) from
  any other failure without reading error strings; the length check stays
  a plain error.
- `session.service`: `keyBlobKey` with `setKeyBlobKey`, `getKeyBlobKey`
  and `hasKeyBlobKey`, cleared in `close()`. Set right after
  `setPrfOutput` in `unlock.ts` and on the create page (null there when
  the authenticator gave no PRF output at registration, as the PRF output
  itself is). The setup page has no `setPrfOutput` of its own: it runs
  `unlockWithPasskey` when the PRF output is not in RAM and gets the key
  with it. The recovery service's PRF output is the recovery passkey's
  and is not touched.
- The key blob callers: the wallet page's create asks for the encryption
  key as before and for the key blob key, and wraps under the latter; the
  nine `pairOneFromKeyBlob` callers pass the key blob key and refuse with
  `common.noKeyBlobKey` ("The key that opens your account keys is not in
  RAM: unlock again.", one string where two forms of the old one were
  used).
- Lost accounts (`balances.service`): `AccountBalance.lost`; `readOne`
  turns `KeyBlobLostError` into the lost entry (landed false, error null,
  nothing read); the totals and `needsPoll` skip it; `isLost(accountId)`.
  Beyond the plan: `usableAccounts`, the session's accounts that are not
  lost, and `markLost()`, which tries every keyBlob without an entry under
  the key blob key with no ledger read, run by an effect whenever the
  session's account list changes and awaited by the attestor's and the
  moderator's `loadAccounts` before they pick a default account, so a
  picker neither shows nor picks a lost account even on a page that reads
  no balance. The balance card says nothing about lost accounts (the plan
  names no line); they are not counted.
- The moves: `listMyBreakGlassMoves(quiet)` in `masterpod-api.service`
  with `BreakGlassCaseItem`, `BreakGlassMove` and `BreakGlassEvent` as
  masterpod 14.4.1 answers them. Where the plan put the loading on the
  Wallet page, it lives in `balances.service` so the Account page shows
  the same state: `refresh` reads the moves (`loadMoves`) when an account
  is lost, so the page's open, Refresh, the balance card's button and the
  polls keep the state current, and the Account page calls `loadMoves`
  when it finds its account lost. One state per old account, the newest
  case's. The stage: `dismissed` from the case status; `decided` reads
  "being written" until the new account's history lists the move's
  transaction id, read from the new account's first page of
  `/list-transactions` (50 rows, newest first, signed by its pair one),
  then "Moved to <the new account's name>"; an open or in-review case
  reads "1 of 2 attestors signed" when `signOffs` is above zero, else
  "waiting for 2 attestors". `wallet.moveState` takes the stage, the count
  and the new account's name (the plan named the first two; the moved
  line needs the name).
- The Wallet card and the Account page as 8.2 now says; the lock-off icon
  is Material Symbols' `no_encryption`. On the Account page the two panels
  (follow-ups, fund proposal) are left out with Send, Pending, the trades
  and the lock sections, since every one needs pair one; History stays,
  and the history page of a lost account shows the lost line where the
  read's refusal would show, as the escrow trade and assisted transfer
  pages do. The attestor's three pickers and the moderator's (the plan
  named the attestor's; the moderator's is the same list), and the pinned
  listing's share menu, seller's From and named accounts, list the usable
  accounts; the Home to-do "Finish creating" line skips a lost account
  ("Open your first anos account" still waits for an empty list, lost or
  not). Cases already showed the id for a keyBlob that did not open. The
  notes pages have no account choice, so nothing changed there.
- `history-words`: `breakGlassTransfer` reads "Recovered from an old
  account" (+, icon `restore`) when received and "Moved to a new account"
  (−, icon `key_off`) when sent; the details' kind is "break-glass move".
- `recover-case.page`: the Break-glass keys step is gone with
  `storeBreakGlass`, `BreakGlassResult`, `breakGlassText` and
  `accountOfBreakGlassKeys` (the plan's 5.4 says the last is "kept from the
  old step"; it was removed here so the build has no unused member, and
  step 5 brings the logic back with its Move your money step); the stepper
  runs Combine, Get back in, New backup code, Done; the recovered seeds
  stay in `RecoveryService` unused; `storeBreakGlassBlob` left
  `masterpod-api.service`, `breakGlassBlob` stays on `AnosAccountListItem`
  (null from now on). The six dictionary entries of the removed step left
  `en.ts` and `th.ts`.
- Words: `wallet.lost`, `wallet.moveState`, `account.lostTitle` (the
  card's line again), `account.lostText`, `common.noKeyBlobKey`, the two
  history titles and the kind, in both languages; the Thai lines were
  written here by the glossary and are to be checked by a Thai reader.
- Spec: sections 7, 8.2, 8.3, 10, 12.3 and this note; README unchanged.
- `npx ng build` clean (1.96 MB initial, no warnings). Not run in a browser
  here: the user resets the
  testnet, deploys the three wallet steps together and runs a recovery
  through, expecting the old accounts' cards to read "Lost with the old
  passkey" after Get back in and the move line once step 5 files the
  moves.

### The finish moves the money, step 5 (2026-11-08)

Built from `forclaude/break-glass-plan-1.md` (FINAL), section 5, one
commit, after step 4 above; step 6 (the attestor edition) follows, and
the three are deployed together after the testnet reset. Why: since step
4 a lost passkey kills the old accounts' keys, so the recovery's finish
has to move the money itself: one new account per old account that holds
anos and a `breakGlassTransfer` into it, signed by the recovered seed's
break-glass pair, attested by two attestors. What the plan left open was
decided as follows.

- `crypto.service`: `TransferType` has `breakGlassTransfer`;
  `TransferSignatures` allows the two break-glass keys;
  `buildBreakGlassTransferTransaction(keys, accountId,
  previousTransactionId, accountIdTo, amount, createdAt)` with the
  private `signAsBreakGlass`, the break-glass pair's two signatures and
  nothing else; `signAccountEnvelopeWith(signer, ...)`, private, behind
  `signAccountEnvelope` (pair one) and
  `signAccountEnvelopeAsBreakGlass(keys, ...)`.
- `anos-api.service`: `getAccountAs(envelope, quiet)`, which `getAccount`
  calls; `anosTransfer` unchanged. Beyond the plan's list: `AssistedStage`
  gains `locked` and `HeldAssistedTransfer` gains `unlocksAt: string |
  null`, what `/get-assisted-transfer` answers since the validator's step
  1, so that `assistedStages.locked` has a date to show.
- `account-creation.service` (new): `createAccount(accountType, onStep?)`
  with the six steps of the Wallet page's `create()` as they were, step by
  step, then the wait; `onStep(step, state)` reports `doing`, `done` and
  `failed` per step index (0 to 5), so the Wallet page's list and its
  `failedBeforeRegister` (a failure before step 4) follow it. The plan
  said `submit` moves into `createAccount` and `resubmit` stays on the
  page: `submit` became the public `submitCreation(creation, onStep?)`
  (steps 5 and 6), which `createAccount` and the page's `resubmit` both
  call, so the code exists once. The page's `load()` after steps 4 and 6
  became the service's `reload()`: the session's account list, quiet,
  then `balances.refresh(true)`, so a caller with no page (the finish)
  still leaves the session and the balances current. The wait:
  `/get-account` with the new pair one, quiet, every `ACCOUNT_POLL_MS` (5
  seconds) for up to `LANDING_WAIT_MS` (90 seconds); any refusal means
  not yet (an unknown account while the creation has not landed, or a
  blip), and past the limit `wallet.notOnLedgerYet` ("The account is not
  on the ledger yet after 90 seconds. It may still land: refresh in a
  moment."), a sentence added beyond the plan's list because the wait
  can end that way. The Wallet page now stays busy through the wait,
  which it did not before (the card showed "Waiting for the ledger…" and
  the poll picked it up; it still does). At the finish a timeout fails
  the step after the new account was made, and Retry makes another one
  of that type: the plan names no reuse of an empty new account, so the
  one that landed late stays, empty. The key blob key is checked by the
  service (`common.noKeyBlobKey`); the page keeps its two guards.
- `recover-case.page`: the step "Move your money" after New backup code
  and before Done, as the plan's 5.4 says (its 5.5 calls it "step 3" of
  the finish list, the removed step's place; 5.4's order is the one
  built, and 12.3 numbers it 4 and Done 5). `moveMoney` as 12.3 now says,
  with these choices: every `/get-account` read happens before any
  account is created or any move posted, so a refused read stops the run
  before a side effect; `accountOfBreakGlassKeys` is back as it was,
  typed over `AnosAccountItem`; an account's type goes to `createAccount`
  as the masterpod lists it (its CHECK constrains it to the four); the
  minutes ahead come from `config.load()` as the account page computes
  them, and when the proxy sent no lock numbers the step fails with
  `account.lockNotLoaded`; a read answering no latest transaction id
  fails with `common.noLatest` (an account with a balance always has
  one); the moves of a run go to `/file-break-glass-moves` in one call
  (the masterpod takes 20 per call; a pod with more lost accounts than
  that is not handled); the result keeps the seed count, and with no
  recovered seed at all the step completes with `recoverCase.moveNoSeeds`
  ("No break-glass seeds were recovered, so there is nothing to move.")
  rather than refusing, since the stepper is linear and Done comes after;
  the `moveRefused(account, reason)` line names the account by its short
  id. `recovery.setCombined([], [])` after the wipe also drops the backup
  code candidates and clears `hasCombined`, which nothing reads by then
  (the rotation is done).
- A gap the plan leaves, recorded for a later plan: a move posted to the
  validator whose filing never reached the masterpod (a later account's
  creation or move failed in the same run, or `/file-break-glass-moves`
  was refused) is counted as filed on Retry through the validator's
  "already held" refusal, as the plan says, but the masterpod has no row
  for it, so the attestor edition never lists it and the anos stay held
  until a cancel; that Retry also opens another new account of the type
  first. Reading the held row with `/get-assisted-transfer` signed by the
  break-glass pair and filing it would close the gap; the plan did not ask
  for it, so it is not built.
- `ALREADY_THERE` moved to `account-creation.service`, exported, and
  reads `/already (exists|pending|locked|held in (assisted|escrow)_transfers|open|in the garlic chain)/`:
  the creation's three wordings and the `account_id` conflict reasons of
  the validator's five holding tables (pending, locked_transactions,
  assisted_transfers, escrow_transfers and fund_proposals' "a fund
  proposal is already open"). The creation check keeps its `400` test;
  the move checks the wording alone.
- `masterpod-api.service`: `fileBreakGlassMoves(caseId, moves)` with
  `BreakGlassMoveToFile` (the three ids of a move), answering `{ caseId,
  status, moves }`.
- `assisted-stage.ts`: `assistedStageWords(stage, words, unlocksAt = '')`
  reads `locked` as `assistedStages.locked(unlocksAt)`; the account page
  and the assisted transfer page pass `lang.dateTime(held.unlocksAt)`
  when the read answered one. The transfer page's `explain` keeps its
  default sentence for `locked` (held, nothing offered): the wallet's own
  held reads never meet the stage, since a lost account's page reads
  nothing with pair one and the new account is the receiver. Spec 5.4 and
  the Account paragraph of 8.2 name the stage and `unlocksAt`.
- Words: `recoverCase.stepMove`, `moveText` (the plan's English),
  `moveMoney` ("Move my money"), `moveResult(filed, empty, unmatched)`
  ("2 moves filed, 1 account was empty, 0 seeds matched no account", with
  the plurals), `moveNoSeeds`, `moveRefused(account, reason)`;
  `assistedStages.locked(until)` ("Locked until <date>");
  `wallet.notOnLedgerYet(seconds)`; in both languages, the Thai by the
  glossary and to be checked by a Thai reader.
- Spec: 5.4, 8.2 (Wallet, Account), 8.3, 12.3, 12.4, 12.6 and this note;
  README unchanged.
- `npx ng build` clean (1.96 MB initial, no warnings). Not run in a
  browser here: the user resets the testnet, deploys the three wallet
  steps together and runs a recovery through, expecting after New backup
  code a Move your money step that opens one new account per old account
  with anos and files the moves, the old cards reading "Moving the money:
  waiting for 2 attestors" after it, and step 6's attestor edition to
  sign them.

### The vouch requests page (2026-11-08)

Step 2 of `forclaude/wallet-vouch-requests-plan-1.md` (its section 2), one
commit. Step 1, the masterpod's list without the selfie, is
masterpodsoftware 846111b; either may be deployed first (the plan's
decision 6).

- `constants.ts`: `VOUCH_REQUESTS_POLL_MS` (5 000) under the polls and
  `PROFILE_READS_AT_ONCE` (5) beside it.
- `profile-cache.service`: `profile()` still creates the entry at once
  (undefined while the read runs) but queues it instead of starting the
  read; `pump()` starts reads from the front of the queue while fewer than
  `PROFILE_READS_AT_ONCE` are in flight, and `load()` counts itself out in
  a `finally` and pumps again, so a read that fails any way still frees
  its place. Every page with avatars gets its faces five at a time from
  now on; nothing else changed for them.
- `seed.page.ts`: `requests`, `fetching`, `acting` (a set of
  vouchIdNumbers), `cardErrors` (a map to the reason), `error` and
  `listing` as signals, `handled` a plain set. `load(quiet)` sets the list
  to the answer minus `handled` and clears the page error on success; a
  quiet poll that fails changes nothing on screen; `fetching` and `listing`
  clear in a `finally`. The poll is a `setInterval` of
  `VOUCH_REQUESTS_POLL_MS` calling `load(true)` unless `listing`, cleared
  with `DestroyRef`. `act(id, call)` disables one card's two buttons,
  removes the card on ok or on status 404, prints any other refusal on the
  card, and fetches nothing. `<app-avatar>` at 72 px replaces the `selfie`
  branch and its style; an old masterpod's extra `selfie` field in the
  list is unused.
- One deviation from the plan: `listing` is a signal, not a plain boolean,
  because Refresh's disabled state is bound to it in the template and the
  app runs without a zone, so a plain field changing would not repaint it.
- Words: `seed.fetching` ("Fetching…", Thai "กำลังดึงข้อมูล…", to be checked
  by a Thai reader).
- Spec: 8.2 (Seed), 8.3 (profile-cache.service) and this note.
- `npx ng build` clean (2.03 MB initial, no warnings). Not run in a
  browser here: the user runs it on the dev server and then on
  wallet.anocloud.com with a seed that has several open requests,
  expecting the spinner, then every card at once with the faces filling
  in a few at a time; Approve on one card leaves the others live and the
  card goes; a request from another pod appears within 5 seconds; the Log
  page shows the first list read and the approve, not the polls.

### The camera shrinks a picked photo (2026-11-08)

Step 3 of `forclaude/wallet-vouch-requests-plan-1.md` (its section 3), one
commit, independent of step 2. Why: a photo picked from the phone's camera
app went out as it came, up to 10 MB, where the live camera makes about
200 KB. The public selfie is stored plain on the masterpod and read back
by every page that shows the face; the bucket images are encrypted by the
wallet before they leave; the shrink happens before either, so the
masterpod keeps storing exactly what it receives.

- `camera.component.ts`: `fileChosen` calls a new `shrink(file)` before
  `emit`. It decodes the file with `createImageBitmap(file,
  { imageOrientation: 'from-image' })`, so a phone photo keeps the way it
  was held; when the bitmap's longer side exceeds `SIZES[quality].width`
  it draws the bitmap onto a canvas with that side at the width and the
  other scaled with it (rounded to whole pixels), encodes
  `toBlob('image/jpeg', SIZES[quality].jpeg)`, and the photo goes out as
  that JPEG with type `image/jpeg`. A bitmap no larger than the limit, a
  file `createImageBitmap` cannot decode, and a canvas whose `toBlob`
  answers null all return null, and the file is emitted unchanged with its
  own type, as before. The bitmap is closed in a `finally`. The preview
  shows the emitted blob, so what the user sees is what is sent.
  `takePhoto` is unchanged.
- Spec: 8.4 and this note. No words, no constants, no proxy change.
- `npx ng build` clean (2.03 MB initial, no warnings). Not run in a
  browser here: the user picks a phone photo on the create page of the dev
  server and reads the selfie's length on the Log page, expecting a few
  hundred thousand characters, not millions, and the preview the right way
  up.

### The DAO, step 4 (2026-11-08)

Step 4 of `forclaude/dao-voting-plan-1.md` (its section 4), one commit.
Steps 1 to 3 are in the other repos: the validator's public
/list-dao-stakes (anossoftware b8c8d32), the doorman's line
(doormansoftware 637ccd6 and 5f84895) and the masterpod's tables, routes
and clock (masterpodsoftware 68b8ba2, its spec's section 15). The wallet
is deployed last, wallet1 then wallet2, together with step 5 (the plan's
section 7). A wallet against a masterpod without the routes shows
"/list-dao-proposals: HTTP 404: Not Found" in red on the DAO page and
works everywhere else.

- `app.routes.ts`: `dao` (DaoPage, "DAO") and `dao/new` (DaoNewPage, "New
  proposal") after the marketplace routes, behind `sessionGuard`. The plan
  lists a third line, `dao/:proposalId`, and marks it step 5: a route to a
  page that does not exist yet cannot build, so the line goes in with its
  page in step 5, after `dao/new`, where the static path keeps winning.
  Until then a link to /dao/<id> (a card, a posted proposal) falls to the
  catch-all and lands on the landing page, which sends a session on to
  Home; the two steps are deployed together.
- `navigation.service`: `{ path: '/dao', label: nav.dao, icon:
  'how_to_vote' }` after Marketplace and before Account; the Home tiles
  draw the same list.
- `masterpod-api.service`: under "level setup: DAO (masterpod spec 15)" the
  types `DaoStatus`, `DaoListStatus`, `DaoSettings`, `DaoProposalItem`,
  `DaoProposal` and `DaoVoteItem`, and one the plan does not name,
  `DaoListFilters`, the list's body (status, from, to, limit, offset); the
  six methods, each `this.signed(path, body)`, `listDaoProposals(filters,
  quiet = false)` with the quiet flag as the other reads have it,
  `listDaoVotes(proposalId, stage, limit = 50, offset = 0)`.
- `dao.page.ts` (new), as 4.4 says. Where the plan was silent: Refresh
  forgets all three tabs and reads the one on screen again, the others
  when they are shown next; the notice waits for the first list that
  answers, since its numbers are the masterpod's `settings`, so a
  masterpod without the routes shows the refusal and no notice; the time
  left is the whole days to pendingUntil, or the hours rounded up under a
  day, never below zero; the card's "posted" date is the date alone
  (toLocaleDateString with dateStyle medium by the language's tag), while
  "closes" and "decided" carry the time through lang.dateTime; a pending
  card shows the caller's support, an open or decided card the caller's
  vote (a support is not a vote, the plan's decision 8); a proposer whose
  pod row is gone reads "unknown pod" (common.unknownPod); a thin
  indeterminate bar runs under the notice while a read is out, as the
  history page has one; the page size 20 is a constant of the page. The
  green `for` (#2e7d32) and red `against` (var(--mat-sys-error)) classes
  of the thumb icons are the page's own: the plan's 5.1 puts them in
  `src/app/app.css`, but that file is the shell component's own stylesheet
  (the `styleUrl` of app.ts), scoped to its template by Angular's view
  encapsulation, so a class there does not reach a page; step 5 either
  repeats the two lines in its page or puts them in `src/styles.css`, the
  global file, and takes them out of this page.
- `dao-new.page.ts` (new), as 4.5 says, in the frame of the new-listing
  page; the counters are Material hints at the end of the fields;
  `maxlength` is bound from two constants of the page; the back arrow's
  label is common.back; `notEnough` carries the settings' proposeMinVotes,
  or 1 when the quiet read did not answer; the refusals are matched on the
  masterpod's reason text, as the attesting page matches its own.
- Words: `nav.dao`; the `dao` section with every key of 4.2, the proposal
  page's words of the plan's 5.1 included now since 4.2 lists them in the
  section (step 5 adds `home.openVotes` only); the `daoNew` section. The
  side words `for` and `against` reach the sentences as the wire words:
  the English prints them, the Thai turns them into เห็นด้วย and
  ไม่เห็นด้วย (a `sideWord` helper beside `KINDS` in th.ts). The Thai by
  the glossary ("โหวต DAO" for DAO votes), to be checked by a Thai reader;
  "Pending" is the glossary's รอดำเนินการ, "Open votes" กำลังโหวต.
- Spec: 8.1, 8.2 (DAO), 8.3, 8.8, 10 and this note. README: nothing. No
  constant in constants.ts, no proxy change, no new package.
- `npx ng build` clean (2.05 MB initial, no warnings). Not run in a
  browser here: the user opens /dao on the dev server against a masterpod
  with step 3, expecting the notice with 15 and 14, the three tabs with
  their empty lines, New proposal posting and landing on /dao/<id> (the
  landing page until step 5), then the Pending tab's card with its bar and
  "You supported this"; against an older masterpod, the red
  "/list-dao-proposals: HTTP 404: Not Found" and no notice.

### The DAO, step 5 (2026-11-08)

Step 5 of `forclaude/dao-voting-plan-1.md` (its section 5), one commit,
on top of step 4 (the note above): the proposal page, its route, the
Home line. The wallet is deployed last, wallet1 then wallet2, steps 4
and 5 together, after the validators, the doormen and the masterpod
(the plan's section 7).

- `dao-proposal.page.ts` (new), DaoProposalPage at /dao/:proposalId, as
  5.1 says and 8.2 (DAO, Proposal) describes, in the frame of the
  listing page: `proposalId` is an input the router binds from the
  route, and an effect reads the proposal when it is set. Where the plan
  was silent: the status label at the top is the result label of a
  decided proposal, so Accepted or Rejected is not drawn twice; an
  expired proposal shows the pending numbers under its Expired label
  (the support over the support needed, the bar and "until" the deadline
  it missed), since it has no for and against; the proposer's row is the
  avatar and the by-line, which carries the username, so the name is
  not printed twice; the by-line's date is the date alone through
  dateOf, as the cards, the other times through lang.dateTime; the
  your-votes line shows for every status; the action buttons are
  outlined (mat-stroked-button), so the colored thumb stays visible on
  them, with Yes filled and Back plain as the listing page's confirm;
  one `asking` signal holds what is asked (support, for or against) and
  one `confirm` method sends it; the green of "Your support is
  recorded." and "Your vote for is recorded." is the thumb green
  (#2e7d32), not the primary colour the other pages' `.ok` uses; an
  action clears the two messages, Refresh clears them too, and after an
  action the proposal and both lists are read again with the old ones
  on screen meanwhile ("Loading" shows only before the first answer); a
  refusal that means the stage is over (proposal not pending, proposal
  not open, proposal expired, voting closed) shows "This proposal is no
  longer taking votes." and reads the proposal again; the supporters
  (stage pending) are read for every proposal and the votes (stage
  official) once openedAt is set, each 50 at a time (PAGE, a constant of
  the page) with Show more by offset while the last page came back full,
  a refused list in red under its heading, "No votes yet." once a list
  answered empty; a row is in the history page's shape, the username
  with a small bordered "you" tag on the caller's own row and the time
  under it, the colored thumb and the votes at the right; the body
  paragraph has overflow-wrap: anywhere besides white-space: pre-wrap,
  so a long unbroken string wraps in the column. The thumb classes `for`
  (#2e7d32) and `against` (var(--mat-sys-error)) are repeated in this
  page's styles: the plan's 5.1 puts them in `src/app/app.css`, which
  step 4 found to be the shell's own scoped stylesheet, and two one-line
  rules in each of the two pages are simpler than a global class in
  `src/styles.css`; `dao.page.ts` is unchanged.
- `app.routes.ts`: `dao/:proposalId` (DaoProposalPage, "Proposal") right
  after `dao/new`, so the static path keeps winning; the import between
  dao-new and dao. A card's link and a posted proposal's /dao/<id> now
  open the page instead of falling to the catch-all.
- `home.page.ts`: when Home opens, beside the accounts,
  /list-dao-proposals { status: 'open', limit: 100 } (quiet) into the
  signal `openVotes`, the count of items with yourWeight at least 1 and
  yourVote null; the Things to do line "2 proposals open for your vote"
  ("1 proposal open for your vote" at one), icon how_to_vote, to /dao,
  after the chat requests line and before the notifications line, when
  the count is above 0; a refusal leaves the count at 0 and shows
  nothing, the line is a convenience. No new service use: the read is
  masterpod-api.service's listDaoProposals, already there.
- Words: `home.openVotes(n)` in both files, the only key added; every key
  of the plan's 5.1 was already in `dao` since step 4 (checked against
  5.1 one by one), and `daoNew.unreachable` serves the validators'
  refusal here too. The Thai "${n} ข้อเสนอที่เปิดให้คุณโหวต", in the shape of
  the other Home lines, to be checked by a Thai reader.
- Spec: 8.1 (the route's words), 8.2 (Home's list and its open read; the
  Proposal paragraph), 8.8 (the Home line's words) and this note. 8.3
  unchanged: no service changed. README: nothing. No new package, no
  proxy change, nothing under server/.
- `npx ng build` clean (2.06 MB initial, no warnings). Not run in a
  browser here: the user opens a posted proposal from a card or lands on
  it after Post, expecting the Pending label, the title, the avatar and
  the by-line, the text, the support over the support needed with the bar
  and "until ...", the snapshot total, "Your votes in this proposal: n",
  "You supported this" (the post counts as the proposer's support) and the
  "Supported by" list with their own row tagged "you"; a second pod with
  votes sees the Support button, the ask, "Your support is recorded." and,
  once the support reaches needed, the Open for votes label with For and
  Against and the "Votes" heading; Home shows "1 proposal open for your
  vote" for a pod with votes that has not voted; a pod without votes sees
  the no-votes sentence and no button; an old link to an expired proposal
  shows the Expired label and its numbers; against an older masterpod,
  "/get-dao-proposal: HTTP 404: Not Found" in red.

### The Stake for list follows the appointment (2026-11-08)

Step 3 of `forclaude/appointments-plan-1.md` (its section 3), one commit,
after the masterpod's step 1 (masterpodsoftware 775d901:
/check-anopod-status answers role) and the validators' step 2
(anossoftware b62ac29: a moderator or attestor stake needs the pod's
appointment). The wallet learns its pod's role from the status, offers
moderator and attestor in the Stake for list only to a pod appointed for
it, and shows the validator's two new refusals in words. Nothing deploys
before the Test Net 2 relaunch; the wallet goes out after the masterpod
and the validators, wallet1 then wallet2 (the plan's section 5); against
an older masterpod the wallet shows all six purposes.

- `session.service.ts`: `StatusAnswer` gains `role`, optional,
  `'moderator' | 'attestor' | null`, since an older masterpod sends no
  field; the empty status of the next-step rule leaves it out; the
  computed `role` on the service is `this.status()?.role`: undefined
  without a status or a field, null for a pod with no appointment.
- `account.page.ts`: `stakePurposes` is a computed list: all six while
  `role` is undefined, the four without moderator and attestor when it
  is null, those four and the one the pod holds when it is a role; an
  effect in the constructor moves a pick that left the list back to
  daoVote. The pick's default stays attestor, as before: for a pod that
  is not an attestor it moves to daoVote as soon as the status is known,
  which the shell loads at unlock, before the page opens. Where the plan
  was silent: the fund proposal's Returns stake list used the same
  constant; it keeps all six through `allStakePurposes`, since a
  guardian returns any account's stake, a revoked pod's among them (the
  plan's decision 6). Send's refusal goes through `refusal(res)`: a
  reason matching /not appointed as/ reads "Only an appointed attestor
  can stake for attestor." (the picked purpose in both places), one
  matching /could not confirm/ "The validator could not confirm this
  anoPod with the masterpod. Try again in a moment.", every other as
  before, the HTTP status and the validator's reason. The two reasons
  are the validator's (anossoftware spec 24): "the sending account's
  anoPod is not appointed as <stakeFor>" and "the masterpod could not
  confirm the sending account's anoPod". They show only when the list
  and the validators disagree: a status read before a revocation, or an
  older masterpod behind new validators.
- Words: `account.notAppointed(purpose)` and
  `account.masterpodNotConfirmed` in both files, the only keys added.
  The Thai: "มีเพียงผู้ยืนยันที่ได้รับแต่งตั้งเท่านั้นที่วางหลักประกันเพื่อผู้ยืนยันได้" (the
  role word from a `ROLES` map in th.ts, the shape of `KINDS` and
  `SIDES`, so the sentence reads ผู้ดูแล or ผู้ยืนยัน where the wire word is
  moderator or attestor) and "ผู้ตรวจสอบไม่สามารถยืนยัน anoPod นี้กับ
  masterpod ได้ ลองอีกครั้งในอีกสักครู่", to be checked by a Thai reader.
- Spec: 4.3 (role on the answer), 8.2 (the Account paragraph: which
  purposes show, the two refusals, the Returns stake list) and this
  note. 8.3 unchanged: the status row covers the role; 12.2 and 13.2
  unchanged: the guards did not change. README: nothing, it does not
  state the answer or the list. No new package, no proxy change, no
  route, nothing under server/.
- `npx ng build` clean (2.07 MB initial total, no warnings). Not run in
  a browser here: the user, on a spending account with the kind stake,
  expects the Stake for list to show daoVote, guardian, validator and
  masterPod for an ordinary pod, attestor added on an appointed attestor
  pod and moderator on a moderator pod, all six against an older
  masterpod; the Returns stake list of the fund proposal still shows all
  six; a stake the validator refuses for the appointment shows its
  sentence in red under Send, as every refusal shows.

### The Guardians, step 3 (2026-11-08)

Step 3 of `forclaude/wallet-guardians-plan-1.md` (its section 3), one
commit, the wallet's first step. Steps 1 and 2 are in the other repos:
the validator's public `/list-fund-proposals` and `/get-fund-proposal`
and the two stake fields of `/get-account` (anossoftware aaacc2b, its
spec's section 25: the plan said 24, that number was taken by the
appointed stakes) and the doorman's two lines (doormansoftware 7b172ff,
its spec's section 7). The wallet is deployed last, wallet1 then wallet2,
together with step 4 (the plan's section 6), after the validators and
their doormen: the wallet asks its `defaultValidator` only, so that one
and its doorman first. A wallet against a validator or a doorman without
the routes shows "/list-fund-proposals: HTTP 404: Not Found" in red under
the tab of the Guardians page and works everywhere else.

- `app.routes.ts`: `dao/guardians` (GuardiansPage, "Guardians") and
  `dao/guardians/new` (GuardianNewPage, "New fund proposal") between
  `dao/new` and `dao/:proposalId`, behind `sessionGuard`, with a comment
  saying why they sit there (the router takes the first match, and
  `dao/:proposalId` would otherwise swallow `dao/guardians`). The plan's
  third line, `dao/guardians/:transactionId` to GuardianProposalPage, is
  step 4's page: a route to a page that does not exist cannot build, so,
  as the DAO's step 4 did with `dao/:proposalId`, the line goes in with
  its page in step 4, after `dao/guardians/new`; a comment holds its
  place. Until then a card's link and a posted proposal's
  /dao/guardians/<id> fall to the catch-all and land on the landing page,
  which sends a session on to Home; the two steps are deployed together.
  `navigation.service` is unchanged (the plan's decision 1).
- `anos-api.service`: `AccountAnswer` gains the optional `stakes` and
  `guardianVotes`; under the comment "the public reads (anossoftware 25)"
  the seven types of 3.3 and the two methods, each `this.post(path, body,
  quiet)` with the plain body, no envelope: the wallet's first unsigned
  posts to a validator. The doc comment names them.
- `guardian-accounts.service` (new), a small root service the plan does
  not name: the read of the pod's guardian accounts (3.5) is needed by the
  Guardians page, by New fund proposal and by step 4's proposal page, so
  it lives once, with the pair-one opener the two acting pages need
  (`pairOne(accountId)`, the account page's `pairOne()` for a chosen
  account); three copies of fifteen lines would have been the
  alternative. `read()` asks /get-account for every account of the
  session at once, quietly, and keeps the ones whose `guardianVotes` is
  at least 1, the biggest first (Array.sort is stable, so ties keep the
  list's order); an account whose keyBlob does not open, that is not on
  the ledger yet, whose read is refused, or whose validator sends no
  `guardianVotes` (one without section 25) is left out as a non-guardian,
  and without the key blob key in RAM the list is empty. It reads the
  session's account list from the masterpod first when it is empty, as
  the account page's `pairOne()` does before it opens a keyBlob.
- `dao.page.ts`: the entry card of 3.4 between the notice and the thin
  progress bar that runs above the tabs, a link styled like the cards
  (`.entry`), for everyone; the doc comment says so. Nothing else on the
  page changed.
- `guardians.page.ts` (new), as 3.5 says and 8.2 (Guardians) describes.
  Where the plan was silent: the New proposal button and the round + are
  `<button>`s with `routerLink`, not anchors, so `disabled` works (an
  anchor cannot be disabled); New proposal is enabled with a guardian
  account and no card in the Open vote tab, a refused list leaving it
  enabled; the notice's and the rule's time comes from the dictionary's
  `minutes` helper, so the testnet's 60 reads "1 hour" and production's
  10080 "7 days" (the plan wrote "60 minutes"); "Reading…"
  (common.reading) stands under "Your guardian accounts" while the
  accounts are read, the become-a-guardian sentence with a Wallet button
  (`account_balance_wallet`, the navigation's icon) when none came and the
  settings are known, and nothing under the heading when the list was
  refused too (the red line under the tab says why); the five status
  words are one table `guardians.statuses` keyed by the validator's word,
  as the languages plan has it for a server's words, so an unknown
  status shows its own word and no colour (anossoftware 25.2); the
  progress bar is for over for plus against, 0 before any vote, with
  "needs 70 percent for" from the settings beside "closes"; a waiting or
  closing card shows the status word and no tally, as the plan says; "You
  proposed this" carries the green thumb_up, since the proposer's votes
  are the first votes for; the "proposed by" date is the date alone
  (dateOf), "closes" and "decided" carry the time through lang.dateTime,
  as the DAO's cards do; the open list is asked with `{ status: 'open' }`
  alone, since the validator reads nothing else for it, and Show more
  exists on the Decided tab only; Refresh reads the accounts again too;
  the page size 20 is a constant of the page. The `for` and `against`
  colour lines are the page's own, as on the two DAO pages.
- `guardian-new.page.ts` (new), as 3.6 says and 8.2 (New fund proposal)
  describes. Where the plan was silent: each payout row is an outlined
  box with the recipient on its own line, the amount and the reason on
  the next and Returns stake with the remove button on the third, since
  the account page's one-line row did not fit a phone; the paste
  button's note (the browser refused, nothing looks like an id) is kept
  on its row; the 64-hex-characters pattern of the account page's paste
  is repeated here, two lines; the recipient is lower-cased and the
  reason trimmed before posting; the quiet open read's refusal shows in
  red, so a missing rule is explained, and Post stays enabled then; the
  select's pick moves to the biggest account only when the pick is not in
  the new list, so a Refresh elsewhere does not undo a choice; the
  refusals are matched on the validator's words, "a fund proposal is
  already open" (fund.queries.js, the held check) and "no guardian vote"
  ("the proposer has no guardian vote", fund.service.js; the plan's "the
  guardian has no guardian vote" is the guardian vote's wording, for step
  4), the rest with the path.
- `account.page.ts`: the accordion with its two panels left the template,
  and with it `PayoutRow`, the signals `voteTransactionId`, `vote`,
  `followUpOutcome`, `payouts` and `proposalOutcome`, the methods
  `sendVote`, `followUp`, `addPayout`, `removePayout`, `updatePayout` and
  `sendFundProposal`, the field `allStakePurposes`, `MatExpansionModule`,
  the imports `FollowUp`, `Payout` and `Vote`, and the `.followups` style;
  `PairOne` stays for `pairOne()`, `act` and `Outcome` for Send. The doc
  comment's sentence about the two forms became "The guardian features
  live on the Guardians page (2026-11-08)", and its two other mentions of
  the panels (the order of the page, the lost account's list) went with
  them. The stake form, `stakePurposes`, `spendingKind` and
  `buildTransferToFund` are as they were.
- Words: `dao.guardians` and `dao.guardiansLine`; the `guardians` section
  with every key of 3.2, the proposal page's words of 4.1 included now
  since 3.2 lists them in the section, as the DAO's step 4 did; the
  `guardianNew` section. Leaving `account` in both files: `followUps`,
  `vote`, `votes`, `fundProposal`, `returnsStake`, `no`, `addPayout`,
  `payoutAmount`, `proposalAccepted` and `followUpAccepted`; `stakeFor`
  and `stakePurposes` stay, and the New fund proposal page borrows
  `account.recipientPlaceholder`, `pasteRecipient`, `amountPlaceholder`,
  `clipboardRefused`, `clipboardNoId` and `stakePurposes`, the stake
  form's words. The side words reach `youVoted`, `askVote`, `yesVote` and
  `voted` as the wire words, the Thai through `sideWord`. The Thai by the
  glossary ("ผู้คุ้มครอง" guardian, "ข้อเสนอกองทุน" fund proposal,
  "การจ่ายออก" payout, "กำลังโหวต" for the Open vote tab as the DAO's Open
  votes), to be checked by a Thai reader.
- Spec: 8.1 (the three route lines and the order paragraph; the
  `/wallet/:accountId` line lost its "follow-ups, fund proposal", which
  the plan did not name), 8.2 (the DAO paragraph's card, the Guardians
  paragraphs, the Account paragraph), 8.3, 8.8, 5.4, 10 and this note.
  README: nothing. No new package, no constant, no proxy change, nothing
  under server/.
- `npx ng build` clean (2.07 MB initial, no warnings). Not run in a
  browser here: the user opens /dao on the dev server against a validator
  and a doorman with steps 1 and 2, expecting the Guardians card under
  the DAO notice; on the Guardians page the notice with 1000, 70 and
  "1 hour", the accounts with guardian stake under "Your guardian
  accounts" (or the become-a-guardian sentence with 1000), the two tabs
  with their empty lines; New proposal posting a payout from a guardian
  account and landing on /dao/guardians/<id> (the landing page until step
  4), then the Open vote card with "1 payout", the bar, "needs 70 percent
  for", "closes …" and "You proposed this", and after the hour and the
  next transaction of any kind the card under Decided as "Passed, the
  money moved" or "Failed"; against an older validator or doorman, the red
  "/list-fund-proposals: HTTP 404: Not Found" under the tab and no notice.
  The account page shows no panel under the Transaction history button.

### The Guardians, step 4 (2026-11-08)

Step 4 of `forclaude/wallet-guardians-plan-1.md` (its section 4), one
commit, on top of step 3 (the note above): the Fund proposal page, its
route, the Home line. The wallet is deployed last, wallet1 then wallet2,
steps 3 and 4 together, after the validators and their doormen (the
plan's section 6). Step 5, the architecture records, is another chat.

- `guardian-proposal.page.ts` (new), GuardianProposalPage at
  /dao/guardians/:transactionId, as 4.1 says and 8.2 (Guardians, Fund
  proposal) describes, in the frame of the DAO's Proposal page:
  `transactionId` is an input the router binds from the route, and an
  effect reads the proposal when it is set. Where the plan was silent:
  the status label at the top carries the status word for every status,
  so a decided proposal's result is not drawn twice and a waiting or
  closing one does not repeat its word in the numbers (the DAO's Proposal
  page does the same); the numbers block shows "For n · Against n" for
  every status, large while open, the bar only while open, the needs and
  closes line while the vote is ahead (open and waiting), "decided …"
  once decidedAt is set, so a closing proposal shows its tally as it
  stands; the payouts are rows in the shape of the vote rows, "1500 anos
  to a1b2c3d4…e5f6" with the copy button, the reason and the
  returns-stake line under it, one new word `guardians.payoutTo` (the
  plan's "to"; the Thai "ไปยัง", the history's word for a recipient), and
  the total line is the cards' `payouts(n, anos)`; `returnsStake` takes
  the purpose's wire word, as the notice and the rule say "for guardian"
  and 8.8 keeps wire words as they are; the "proposed by" date is the
  date alone through dateOf, the other times through lang.dateTime, as
  the cards; "not found" is the validator's 404 with "unknown proposal"
  in its reason, while any other 404 (a doorman or a validator without
  the route) shows in red with the path, as the Guardians page shows its
  list's 404; the select's option says "can vote" only while the status
  is open, and nothing for an account that neither proposed nor voted on
  a proposal that is not open; the pick is made once the proposal and the
  accounts are both known (the first account that can still vote, else
  the first), stays while its account is listed (a Refresh does not undo
  it), and after a vote moves to the next account that can still vote
  and otherwise stays, so the person sees their vote; a new pick closes a
  question asked for the previous account, since the question names it;
  one `asking` signal holds the side and one `confirm` method sends it,
  as on the DAO's page; the payload is typed GuardianVotePayload before
  buildFollowUp, so the wire shape is the compiler's to check; the "you"
  tag matches a row's account against the session's account list, not
  the guardian list, so an account that voted and has since returned its
  stake is still tagged; Refresh reads the proposal and the accounts
  again, with the old ones on screen meanwhile ("Loading" shows only
  before the first answer); the green of "Your vote for is sent to the
  validators." is the thumb green; the `for` and `against` lines are the
  page's own, as on the other pages. The proposer's row in the votes list
  carries the short id with the copy button, the "you" tag and the time
  the proposal was made, in the shape of the vote rows, with "proposer ·
  3 votes for" at the right, so the proposer's id is copied where every
  other id is.
- `app.routes.ts`: `dao/guardians/:transactionId` (GuardianProposalPage,
  "Fund proposal") in place of the comment after `dao/guardians/new`,
  before `dao/:proposalId`; the import between guardian-new and
  guardians. A card's link and a posted proposal's /dao/guardians/<id>
  now open the page instead of falling to the catch-all.
- `balances.service`: `AccountBalance` gains `guardianVotes`, the number
  /get-account answers (anossoftware 25.1), 0 while not landed or on a
  validator without the field; `readOne` sets it from the read Home
  already makes. The plan's 4.2 wanted the Home line's guardian votes
  "from the balance reads Home already makes" and step 3 left the choice
  open (a field here, or a second /get-account per account through
  guardian-accounts.service); the field is one line and no extra read
  for every pod at every unlock, where very few are guardians.
- `home.page.ts`: when Home opens, beside the accounts,
  /list-fund-proposals { status: 'open' } (quiet, anos-api.service) into
  the signal `openFund`, the one open proposal or null; `openFundVote` is
  computed from it and the balance entries: the status is open and one
  of the session's accounts has guardianVotes at least 1, is not the
  proposer and is not in the votes; the Things to do line "A fund
  proposal is open for your vote", icon shield, to /dao/guardians, after
  the DAO line and before the notifications line; a refusal leaves the
  signal null and shows nothing, the line is a convenience. The line
  follows the balances as they come, since the computed reads them.
- Words: `home.openFundVote` in both files, the plan's one key, and
  `guardians.payoutTo(anos, shortId)`, the payout row's sentence the plan
  wrote as the word "to"; every other key of 4.1 was already in
  `guardians` since step 3 (checked against 4.1 one by one), and
  `guardianNew.noVotes` serves the vote's no-guardian-vote refusal, as
  the plan says. The Thai "มีข้อเสนอกองทุนที่เปิดให้คุณโหวต" in the shape of
  the other Home lines and "${anos} anos ไปยัง ${shortId}" with the
  history's word for a recipient, to be checked by a Thai reader.
- Spec: 8.1 (the route's words), 8.2 (Home's list and its open read; the
  Fund proposal paragraph in place of the step 4 placeholder), 8.3
  (balances.service), 8.8 (the words) and this note. README: nothing. No
  new package, no constant, no proxy change, nothing under server/.
- `npx ng build` clean (2.09 MB initial, no warnings). Not run in a
  browser here: the user opens a card on the Guardians page or lands on
  the page after Post, expecting the Open for votes label, "Fund proposal
  a1b2…" with the copy button, "proposed by …", the payout rows and "1
  payout · 1500 anos", "For 3 · Against 0" in large type with the bar and
  "needs 70 percent for · closes …", "Voting as" with the proposing
  account and "You proposed this" under it, the "Votes" heading with the
  proposer's row tagged "you" and "No votes yet."; a second pod with a
  guardian account sees its account selected with "can vote", For and
  Against, the ask, "Your vote for is sent to the validators." and its
  row as "waiting for approval" until the other validators accepted it,
  then "approved"; Home shows "A fund proposal is open for your vote" for
  a pod with a guardian account that has not voted and nothing for the
  proposer; a pod without a guardian account sees the become-a-guardian
  sentence and no select; after the hour and the next transaction, the
  label "Passed, the money moved" or "Failed" with "decided …"; against
  an older validator or doorman, "/get-fund-proposal: HTTP 404: Not
  Found" in red.

### The pinned card reads a finished trade (2026-11-10)

Built in the planning chat from
`forclaude/wallet-finished-trade-plan-1.md` (FINAL), one commit. Bug 3 of
`test_net_phase_2/bugs-and-new-features.md`: in a marketplace chat, after
an escrow trade was complete, "Start the escrow trade" came back, so
someone could send the anos a second time. Why: the card knew a finished
trade only from its own memory (`seen`, `ended`); the card is rebuilt
whenever the person leaves the chat, and the release happens on the trade
page, so on the way back nothing was known. A /list-escrows read that
failed was also taken as "the trade is gone". And the card read only this
pod's accounts named in the chat, so the seller's card never saw a trade
whose "Escrow trade started" message was not posted (bug 1 of the same
list). Wallet only: no validator, doorman, masterpod or proxy change.

- `src/app/components/pinned-listing.component.ts`: `SeenTrade`, `Ended`,
  `ended`, `endedText()`, `polling` and `myNamedKey` are gone. `older`
  (the account ids the card read from the room itself, null until that
  read is whole) and `ids` (those and the page's `accountIds`, newest
  first) feed `theirAccountIds` and `myNamedAccounts`. `watched` is the
  seller's usable spending accounts plus `myNamedAccounts`, and
  `watchedKey` (the room's id and `watched`) drives the effect that
  `myNamedKey` drove. `released` (`{ amount }`, kept for the room once
  set), `cancelled` and `read` (null, true, false) replace `ended`.
  `poll()` queues one `check()` behind the checks before it (`last`,
  `waiting`) and resolves to `open`, `released`, `none` or `unread`; the
  timer calls it only when none is waiting. `check()`: the pod's accounts
  when the tab has none (once, `accountsAsked`), `readIds()` once per
  room, /list-escrows on each watched account, then, with none open and
  none released yet, `releasedLink()` on each. A refusal, or anything
  thrown, is `unread`: `read` becomes false and nothing else changes. A
  check that ends after the card was given another room changes nothing.
  `start()` runs `poll()` first and throws `pinned.notSentUnread` or
  `pinned.notSentAlready` before anything is built. The template: the
  Released branch with the `finished` line and the Close the listing
  block; `checking` and `cannotCheck` where Share and Start go.
- `src/app/constants.ts`: `CARD_MESSAGES_PAGE` and
  `CARD_TRANSACTIONS_PAGE`, 200 each, after `HISTORY_PAGE`.
- Words: `pinned.checking`, `cannotCheck`, `finished`, `notSentUnread`
  and `notSentAlready`, English and Thai (the Thai written here, to be
  checked by a Thai reader). `pinned.closedUnknown` left both files: a
  transactions read that fails now keeps the card as it is, so nothing
  says "Closed" any more.
- Unchanged: `chat-room.page.ts` (it draws the card and feeds it as
  before), the services, the trade page, the account page, `server/`.
- The reading of "The marketplace, step 3" that Share and Start stay away
  after a release now holds across visits. A second trade in the same
  chat after a release is not possible, by the user's decision: "The
  danger is more real than the convenience. A vulnerable person might
  send the trade several times."
- Readings where the plan left a detail open: the place of the five new
  keys inside `pinned` (`checking` and `cannotCheck` where
  `closedUnknown` was, `finished` after `released`, the two `notSent`
  lines after `pickAccounts`); the template's Released branch is an
  `@else if (released(); as done)`.
- Spec: 8.2 Chat (the chat's trade), 8.7 and this note.
- `npx ng build` clean (2.09 MB initial, no warnings). Not run in a
  browser here: the user deploys and runs it on the test net. The chat of
  bug 3, where the trade was released: "Released: … anos went to the
  buyer." and "This trade is finished. To trade again, start a new chat.",
  no "Start the escrow trade", and "Close the listing" for the listing's
  owner. The chat of bug 1: the seller's card shows the trade if it is
  still open, or Released. A new listing and a new chat between the same
  two people: Start works, and after the release on the trade page the
  chat reads Released on both phones. A trade the buyer cancels while the
  chat is open: "Cancelled: the seller kept the anos." and Start is back.
  The network off for a moment: "Could not check for a trade. Trying
  again." and no button, until it is back.

### The pinned card tells the chat of its trade (2026-11-10)

Built in the same chat from `forclaude/wallet-trade-message-plan-1.md`
(FINAL), one commit, on top of 692c5ac (the note above). The finish for
bug 1 of `test_net_phase_2/bugs-and-new-features.md`: "Start the escrow
trade" said "could not reach the wallet proxy (network error)", the trade
went through on the validators, and the chat was never told. Why: the
validator stores a trade and answers only after the approval round;
`start()` posted "Escrow trade started" only after a 202, so an answer
lost on the way left the chat without the message, the seller's account
id out of the chat, and the buyer's card blind. Wallet only.

- `src/app/components/pinned-listing.component.ts`: `tell(room, named,
  transactionId, text)` posts the chat's message about a trade when
  neither `named` nor `told` (a plain Set, cleared by `reset()`) has its
  transaction id: the room key, /send-message into the room the check
  started with, the id into `told` on a 2xx answer while the card is
  still on that room; no key, a refusal or a throw changes nothing.
  `check()` calls it after its signals are set: for an open trade whose
  `accountId` is the watched account, with `pinned.startedMessage`; for a
  released trade with `mine` true, with `pinned.releasedMessage`.
  `ReleasedTrade` gained `transactionId`, `from`, `to` and `mine` (the
  account the link was read on is its `accountId`), so a released
  message that failed is tried again on every later check. `start()`: a
  failed answer with a status from 400 to 499 throws `refusal(res)`
  (`pinned.alreadyHeld` for "for this accountId is already pending",
  "held" or "locked", else `pinned.refused`); after any other answer one
  `poll()`; a failed answer with no trade found open throws
  `pinned.noAnswer` and leaves the form as it is; otherwise `starting`
  and `confirmStart` become false. `start()` no longer posts the message.
- Words: `pinned.releasedMessage(anos, from, to, transactionId)`,
  `noAnswer` and `alreadyHeld`, English and Thai (the Thai written here,
  to be checked by a Thai reader).
- Unchanged: `chat-room.page.ts`, the services, `constants.ts`, the trade
  page, the account page, `server/`. The buyer's side of the card has no
  new code: once the message is in the chat, the rule of the note above
  finds the trade from the buyer's side.
- Added on the user's word after the first build, in the same commit: a
  check that finds a trade, open or released, sets `starting` and
  `confirmStart` false. After "The validators did not answer" the Yes
  question stayed open behind the trade the card then found, and came
  back by itself when that trade was cancelled.
- Left as it is: two devices of the seller in the same chat at the same
  moment can post the message twice; the buyer's card stays blind until
  the seller has had the chat open once after the trade started.
- Spec: 8.2 Chat (what follows the answer; the limits; the new paragraph
  on the chat's message), 8.7 and this note.
- `npx ng build` clean (2.10 MB initial, no warnings). Not run in a
  browser here: the user deploys and runs it on the test net. The chat of
  bug 1, opened by the seller: "Escrow trade released: …" appears once,
  and the buyer's card there then reads Released and no longer offers
  "Share an account". A new trade the normal way: "Escrow trade started:
  …" appears once, as before. A new trade with the network cut right
  after Yes: no "refused" words, and with the network back the card shows
  the trade and the started message appears. Start from an account that
  has an open trade with someone else: "This account already has an
  escrow trade or a transfer waiting on the validators. …".

### The locked-out page's small text stays off the buttons (2026-11-10)

Bug 2 of `test_net_phase_2/bugs-and-new-features.md`, one commit, no plan
of its own: on the "I'm locked out" page (12.3, `/recover/open`) the small
text under the Contact email box ran into the Back and Next buttons. Why:
Angular Material keeps room for one line under a field (20 px) and draws
a second line over whatever follows. The box is 280 px wide on every
screen and its hint gets 236 px of that, where the English sentence takes
two lines, so the second one lay across the buttons. Wallet only.

- `src/app/pages/recover-open.page.ts`: the Contact email field has
  `subscriptSizing="dynamic"`, so the hint takes the room it needs and
  pushes the buttons down. `.fields` has `margin-bottom: 8px`: the dynamic
  setting also drops the room Material kept under the box, and the hint
  would touch the Next button. `mat-form-field` has `width: 280px` beside
  its `min-width: 280px`: a hint that takes room also widens a box with
  no width of its own (to 381 px on a wide screen), so the box keeps the
  width it had on every screen.
- Unchanged: the words (`recoverOpen.emailHint`, English and Thai), the
  flow, every other page.
- Left as it is: on a screen narrower than about 406 px the box is wider
  than the room its step has, and the stepper cuts the box's right edge
  off (16 px at 390 px wide, 31 px at 375). It was so before this change.
- Spec: this note only.
- `npx ng build` clean (2.10 MB initial, no warnings). Seen here in a
  development build served from a scratch folder, with step 2 opened
  through the browser's debug tools, so no keyholder and no masterpod was
  asked: at 360, 375, 390, 430 and 1024 px wide the English hint takes two
  lines and the Thai hint one, the buttons start 8 px under it, and
  nothing overlaps. Not seen on a phone or on the test net: the user
  checks it there.

### The locked-out page's email box fits its step (2026-11-10)

Bug 5 of `test_net_phase_2/bugs-and-new-features.md`, one commit, no plan
of its own, on top of ec0d770 (the note above, which left this as it
was): on a narrow phone the Contact email box of `/recover/open` was
wider than the room its step has, and the stepper cut its right edge off.
Why: the box had `min-width: 280px`, and a step has the screen's width
less 150 px, which is under 280 px on every screen narrower than 430 px.
Wallet only.

- `src/app/pages/recover-open.page.ts`: `mat-form-field` has
  `width: 280px; max-width: 100%;` where it had `min-width: 280px;
  width: 280px;`. The box is 280 px wide where its step has the room and
  as wide as the step where it has not: 210 px on a 360 px screen, 225 on
  375, 240 on 390, 262 on 412, 280 from 430 up. The hint wraps to the box
  and still pushes the buttons down.
- Unchanged: the words, the flow, every other page.
- Left as it is: the boxes of step 1 come from
  `identity-form.component.ts` (240 px at the least); they are whole from
  375 px up and lose 6 px on the right on a 360 px screen.
- Spec: this note only.
- `npx ng build` clean (2.10 MB initial, no warnings). Seen here the way
  of the note above, in a development build served from a scratch folder:
  at 360, 375, 390, 412, 430 and 1024 px wide, English and Thai, the box
  is whole, its label is not cut, the hint takes one to three lines, the
  buttons start 8 px under it and nothing overlaps. Not seen on a phone
  or on the test net: the user checks it there.

### The backup code leaves the screens (2026-11-10)

The user's decision of 2026-11-10, one step, no plan of its own: nobody
writes a backup code down, and being asked to makes the wallet look hard
before a person has started, so the wallet shows no backup code any more,
anywhere. The backup code itself stays, unseen: it is the secret the
keyholders hold in shares, the long recovery (12.3) rebuilds it to open
blob2 and to prove itself to the masterpod, and a recovery replaces it.
Nothing changes on the masterpod, the keyholders, the validators or the
bankers' GUI. A recovery by typing a written-down code was never built
(the only description was the old draft `~/Desktop/masterpod_auth_flow.txt`
4.6) and is dropped with this. Wallet only.

- `src/app/pages/setup.page.ts`: the pane with the code and the "I have
  written it down, complete" button is gone, with the phase `code`, the
  `backupCodeText` signal and the `.code` style. `start()` ends by calling
  `complete()` itself where it set the phase `code`, so Start runs the
  list, the deposit and `/complete-setup` in one go; `complete()` is as it
  was, and a failure shows Retry as before. The backup code, its keys and
  blob2 are made without the `run` wrapper, so the list has five lines
  where it had eight.
- `src/app/pages/recover-case.page.ts`: the third step of the finish reads
  "New key for the bankers" and has one button, "Make the new key".
  `completeRotation` runs `makeNewCode` first when no new code is held
  (`makeNewCode` is private now and throws on a missing encryption key
  where it set the error itself), then rotates and deposits as before;
  the button reads "Retry the deposit" when only the deposit failed, as
  before. The `newCodeText` signal and the `.code` style are gone.
- `src/app/services/crypto.service.ts`: `backupCodeText`, `toBase32` and
  `BASE32_ALPHABET` are gone; nothing turns a code into text any more.
- `src/app/i18n/en.ts`, `th.ts`: gone are `setup.codeTitle`,
  `setup.codeHint`, `recoverCase.newCodeTitle`, `recoverCase.newCodeHint`,
  `common.writtenDown` and three lines of `setup.steps`; `setup.subtitle`
  and `setup.retryFresh` lost their mention. In `recoverCase` the words
  "backup code" became "the key the bankers keep", "the rebuilt key" or
  "the key": `finishText`, `combineText`, `backInText`, `stepNewCode`,
  `newCodeText`, `oldCodeWorthless`, `makeNewCode`, `statusDelivering`,
  `noCodeRebuilt`, `codeNoOpen`, `codeNotAccepted`, `makeCodeFirst`,
  `noCurrentCode`, `retryDeposits`, `codesRecovered`. The key names keep
  "Code". The Thai lines were changed the same way and are not checked by
  a Thai reader.
- Kept as they are: the names in the code (`newBackupCode`,
  `backupCodeKeys`, `backupCodeProof`, `deriveKekBackup`, the share type
  `backupcode`, `recoverWithBackupCode`, `rotateBackupCode`), since the
  masterpod's routes and columns and the keyholders' share type carry
  them; `makeCodeFirst` and its guard, which no button reaches now.
- Spec: 7 (the backup code row), 8.2 (Setup), 12.3 (My recovery and step 3
  of the finish), this note. The build notes above and 12.7 stand as the
  record of what was built then.
- `npx ng build` clean (2.09 MB initial, no warnings), in a scratch copy
  of ae39348 with this change alone, because another chat's unfinished
  confirmation box was in the working folder. Not run in a browser: Setup
  and the finish need a passkey, the keyholders and a live recovery case;
  the user's run-through is a new anoPod through Setup, and a recovery to
  its third step.

### A confirmation box before a send and before a new account (2026-11-10)

Built from `forclaude/wallet-confirm-box-plan-1.md` (FINAL), one step, one
commit. Found while testing Test Net phase 2: on an account's page a
stake of 100 anos for daoVote went out again with every further click on
Send, each click a new stake. The Send form asked nothing, kept the
amount and the recipient after a send, and its button was live again as
soon as the pending transaction was approved; and "Create anos account"
on the Wallet page started its six steps on one click. The user's
decisions: a confirmation box before every send from the Send form, the
form starting over after it, and the same box before a new anos account.
Wallet only: no validator, doorman, masterpod or proxy change, no theme
change, no new package (the box is `@angular/material/dialog`, part of
the Material already installed).

- `src/app/components/confirm-dialog.component.ts` (new): `ConfirmLine`,
  `ConfirmData`, `ConfirmDialogComponent` (`app-confirm-dialog`) and
  `askConfirm(dialog, data)`, as 8.9 says. The second button is off until
  the signal `armed` turns true; a timer sets it `CONFIRM_ARM_MS` after
  the box was made and is cleared when the box is destroyed. `askConfirm`
  opens the component with `{ data, disableClose: true, autoFocus:
  'dialog', width: '480px', maxWidth: 'calc(100vw - 32px)' }` and
  resolves true only when the box closed with true.
- `src/app/constants.ts`: `CONFIRM_ARM_MS = 500`.
- `src/app/pages/account.page.ts`: `MatDialog` is injected. The Send
  button calls `askSend()` in place of `send()`; its `[disabled]` rule is
  as it was. `askSend()` does nothing with no `item()`, with an amount
  that `anosToMillionths` refuses, or with a box already open. Else it
  takes a `SendOrder` from the form (`transferType()`, the amount in
  millionths, and `stakePurpose()` for a transferToFund or `accountIdTo()`
  trimmed and lower-cased for every other type) and shows it with
  `askConfirm`: the title `account.confirmSendTitle(anos)`, the lines
  `common.kind`, `common.from` and either `account.stakeFor` or
  `common.to` (the full id, `code` true), the note
  `account.confirmStakeNote` for a stake, the button `common.send`. On
  Cancel nothing else happens; on Send, `resetForm()` and then
  `send(order)`. `resetForm()`: `spendingKind` to plain, `stakePurpose`
  to daoVote, `accountIdTo` to empty, `pasteNote` to null, `amount` to
  empty. `send(order)` is the old `send()`, private now: it builds from
  the order and never reads the form, a transferToFund when the order has
  a purpose, else `buildAnosTransferTransaction` with the order's
  recipient, amount and type; `minutesAhead()` and `createdAt` are worked
  out there, after the box, as before. `refusal(res, order)` takes the
  purpose of "Only an appointed … can stake for …" from the order.
  `act()`, the outcome line and the `refresh(true)` afterwards did not
  change. `stakePurpose` starts at daoVote (it was attestor, which the
  effect moved for most pods) and `amount` empty (it was 1). The
  template: right under the form, before the lines about an open trade
  and the outcome line, an indeterminate `mat-progress-bar` and the muted
  line `account.sending` while `busy()`.
- `src/app/pages/wallet.page.ts`: `MatDialog` is injected. The button
  under "Open a new account" calls `askCreate()` in place of `create()`,
  as Create anos account and as Retry. `askCreate()` does nothing while a
  box is open; then come the two key checks `create()` had, with their
  sentences and no box; then `askConfirm` with the title
  `wallet.confirmCreateTitle(type)`, no lines, the note
  `wallet.confirmCreateNote` and the button `wallet.createAccount`; on
  that button, `create(type)`. `create(type)` is private, takes the type
  the box showed and starts at `busy.set(true)`. Resubmit, the cards, the
  type select and the polling did not change.
- Words, English and Thai (the Thai as the plan gives it, to be checked
  by a Thai reader): `account.confirmSendTitle(anos)`,
  `account.confirmStakeNote`, `account.sending`,
  `wallet.confirmCreateTitle(type)` and `wallet.confirmCreateNote`. The
  box reuses `common.cancel`, `common.send`, `common.kind`, `common.from`,
  `common.to`, `account.stakeFor`, `account.stakePurposes` and
  `wallet.createAccount`. Every other key is as it was.
- Unchanged, by the user's decision: the places that ask their question
  in the page (Start and "Close the listing" on the pinned listing card,
  the escrow trade page, the cancel of an assisted transfer, the DAO and
  the guardian votes) and three buttons that ask nothing (posting a DAO
  proposal, posting a fund proposal, where no money moves, and "Move your
  money" of a recovery, which moves everything to the person's own new
  accounts). Also unchanged: `src/app/services/`
  (`account-creation.service.ts` too), the history page, the recovery
  pages, the moderator and attestor pages, `src/material-theme.scss`,
  `server/`.
- Readings where the plan left a detail open. "A box already open" is
  read from `MatDialog.openDialogs`, the box being the wallet's only
  dialog; the pages keep no flag of their own. `SendOrder` is a union of
  two shapes with the fields `transactionType`, `amount`, `accountIdTo`
  and `stakePurpose`: a recipient with a null purpose, or a purpose with
  a null recipient. `send(order)` has no guard of its own for `item()`
  and the amount: `askSend()` holds them, the order carries the amount,
  and `pairOne()` still refuses an account that is not the pod's.
  `refusal()` gives the appointment sentence only for an order with a
  purpose; the validators send that refusal for a stake only. The two
  buttons close the box through Material's `mat-dialog-close`, with false
  and true. In the box the value is in the on-surface colour (Material
  draws a dialog's text in the on-surface-variant colour, the label's);
  the notes keep that Material colour, and a note stands 12 px under the
  lines or the note before it; the grid's gaps are the account summary's,
  4 and 16 px; an id is a `<code>`, 12 px by the global style; a box
  without lines draws no grid. `CONFIRM_ARM_MS` stands after
  `USERNAME_DEBOUNCE_MS`. The three new `account` keys stand after
  `amountPlaceholder`, in the order the page uses them, and the two new
  `wallet` keys after `createAccount`. The class comment of the Wallet
  page gained a sentence too; the plan names the account page's comments
  only.
- Changed on the user's word after the commit (86a088e), in a commit of
  its own, away from the plan's wording. The plan gave every value
  `word-break: break-all`, for the 64-character id, and that cut the
  From line anywhere too: on a phone under about 400 px wide the From
  line of a stake ("Spending account 1 · a1b2c3d4…e5f6") is a few
  characters too long for its column, and it broke inside the short id
  ("…e5f" and "6" at 390 px). Now `.value` has `overflow-wrap: anywhere`
  in its place: a value wraps at a space and is cut inside a word only
  when the word alone is too long, and an id is still cut anywhere, by
  the global rule for `code`. That alone still let a row end after the
  ellipsis ("a1b2c3d4…" and "e5f6"), so `askSend()` puts a word joiner
  (U+2060, `WORD_JOINER` in `account.page.ts`) after the ellipsis of the
  short id in the From line, and the line wraps at the space before the
  short id. Seen in Chrome run without a window, on a test page outside
  the repo with the box's rules and Roboto, at 360, 375, 390, 393, 412
  and 430 px, for a stake and a plain send, with and without a number in
  the account's name: the From line is one row, or "Spending account 1
  ·" and "a1b2c3d4…e5f6"; the 64-character id takes two or three rows;
  nothing runs out of the box. Not seen in Safari or on a phone.
  `npx ng build` clean (2.12 MB initial, no warnings). The plan file
  still reads `word-break: break-all`.
- Spec: 8.2 (Wallet, the "Open a new account" sentence; Account, the Send
  paragraph, in two places), the new 8.9 and this note. README: the
  layout gained the line of `components/confirm-dialog.component.ts`.
- `npx ng build` clean (2.12 MB initial, no warnings), in the web_app
  folder, where another chat's change of the same day (the note above)
  was in the working folder too, and in a scratch copy of ae39348 with
  this change alone (2.12 MB initial, no warnings). Not run in a browser
  here: the user deploys and runs it on the test net. A stake of 100 for
  daoVote from a spending account: the box reads "Send 100 anos?", Kind
  transferToFund, From the account, Stake for daoVote and the line about
  the fund; Cancel sends nothing and the form is as it was typed. The
  same again and Send in the box: the form empties at once, "Sending…"
  shows, then "accepted: …" and the stake under Pending, and the page's
  Send button stays off until a new amount is typed. A double click on
  the page's Send button: one box, and nothing is sent until the box's
  own Send is pressed. A plain send to another account: the box shows the
  full recipient id, and on a phone the id wraps inside the box. A send
  the validators refuse (an amount over the balance): the refusal shows
  under the form and the form is empty. On the Wallet page, Create anos
  account: the box "Open a new spending account?"; Cancel makes nothing;
  "Create anos account" in the box runs the six steps as before.

### The masterpod's account limit in plain words (2026-11-10)

Built from `forclaude/account-limit-plan-1.md` (FINAL), step 2 of its
three, one commit. Since its step 1 (masterpodsoftware 9310f46, masterpod
spec section 17) the masterpod lets a pod make at most 20 new anos
accounts in the last 30 days and answers `403 account limit reached` on
`/create-anos-account` at the limit. The user's decision: the wallet
shows no counter and no "3 of 20"; a person only hears of the limit when
it refuses them, in one sentence that names no number, so it stays true
when the masterpod's two constants change. Wallet only: no route, no
proxy change, no new package, no page changed.

- `src/app/services/account-creation.service.ts`, step 4 of
  `createAccount`: a refusal of `/create-anos-account` that reads
  `account limit reached` is thrown as `wallet.accountLimit`; every other
  refusal as before (`/create-anos-account: <reason>`). The step is
  marked failed either way. The Wallet page shows the sentence under its
  steps and the recovery's "Move your money" (12.3) in its error line,
  both from the error's message, as they show every other failure of the
  service.
- Words, English and Thai (the Thai as the plan gives it, to be checked
  by a Thai reader): `wallet.accountLimit`, "This anoPod has reached the
  limit for new anos accounts. Try again later." Every other key is as it
  was.
- Accepted by the plan, because no real person reaches the limit. The
  wallet learns of the limit at step 4, after the break-glass seed went
  to the keyholders at step 2; that seed stays with the keyholders,
  unused. A recovery that needs more new accounts than the limit leaves
  stops at the limit with the same sentence; Retry works once the 30 days
  free up.
- Unchanged: `src/app/pages/` (the Wallet page and the recovery pages
  too), `submitCreation`, every other service, `server/`. 12.3 reads as
  it did.
- Readings where the plan left a detail open. The refusal is matched by
  its status and its words together, `registered.status === 403 &&
  /account limit reached/.test(reasonOf(registered))`, the way the wallet
  matches every other single refusal (`not a moderator`, `move already
  filed`). The sentence comes from `LanguageService.words()`, as the
  service's two other sentences do, so it is in the language the wallet
  shows. `accountLimit` stands last under `wallet`, after
  `notOnLedgerYet`, beside the service's other sentence. The comment of
  step 4 in the service gained a sentence; the class comment did not
  change. On the Wallet page the button keeps reading Create anos account
  at the limit, not Retry: Retry is for a failure before step 4, and the
  page did not change.
- Spec: 4.4 (a dated sentence), 8.2 (Wallet, step 4 of the progress
  list), 8.3 (the line of `account-creation.service`) and this note.
- `npx ng build` clean (2.12 MB initial, no warnings), in the web_app
  folder with this change alone in it. Both sentences are in the built
  bundle and equal the plan's table letter for letter; the build writes
  Thai as escapes, so the Thai was decoded first. Not run in a browser
  here, and no masterpod was at the limit: seeing the sentence takes 21
  accounts from one pod, and that run-through is the user's (the plan's
  section 4).

### Validator and masterPod follow the appointment too (2026-11-10)

Built from `forclaude/validator-masterpod-stake-plan-1.md` (FINAL), step 3
of its four, one commit, after the masterpod's step 1 (masterpodsoftware
4472d39: validator and masterPod are two more roles on its appointments
list, masterpod spec 16.7) and the validators' step 2 (anossoftware
d0cd95d: a validator or masterPod stake needs the pod's appointment,
validator spec 26). Why: the Stake for list offered validator and
masterPod to everyone. The user, 2026-11-10: "Send stake should only be to
dao vote or guardian. Right now it also include validator and masterpod.
We'll actually need to build a list for those, like we did with moderator
and attestor. Unless the user is on that list, then those option should
not show." It grows the note of 2026-11-08 above, "The Stake for list
follows the appointment". Wallet only: no route, no proxy change, no new
package.

- `session.service.ts`: `StatusAnswer.role` is `'moderator' | 'attestor'
  | 'validator' | 'masterPod' | null`, still optional; its comment and
  the comment of the computed `role` name the four. The computed itself
  did not change.
- `account.page.ts`: `stakePurposes` is daoVote, guardian and the role
  the pod holds, if any: `STAKE_PURPOSES.filter((purpose) => purpose ===
  'daoVote' || purpose === 'guardian' || purpose === role)`. With no
  role, null or not loaded, that is the two. Until this note the list
  was all six while the role was not loaded, and validator and masterPod
  showed to every pod. The list keeps the order of `STAKE_PURPOSES`: a
  moderator pod sees daoVote, moderator, guardian, and a validator pod
  daoVote, guardian, validator. The effect that sends a pick back to
  daoVote when it leaves the list is as it was.
- `th.ts`: the `ROLES` map behind `notAppointed` gains `validator:
  'ผู้ตรวจสอบ'` and `masterPod: 'masterPod'`, the words the Stake for list
  already uses, and its comment says four roles. So the refusal of a
  validator stake reads
  "มีเพียงผู้ตรวจสอบที่ได้รับแต่งตั้งเท่านั้นที่วางหลักประกันเพื่อผู้ตรวจสอบได้",
  to be checked by a Thai reader like the rest. `en.ts` did not change:
  "Only an appointed validator can stake for validator." comes from the
  sentence that is there.
- Unchanged: `guardian-new.page.ts`, whose Returns stake list keeps all
  six purposes, since a guardian must be able to return any stake;
  `refusal` on the account page, which already takes the purpose from
  the order; every other page and service; `server/`.
- What each pairing does (the plan's section 5). This wallet against a
  masterpod from before its step 1 never offers validator or masterPod.
  A wallet from before this note against the new masterpod shows an
  appointed validator pod the four purposes it showed before. The
  validators take their step at their next pull; until then a validator
  or masterPod stake that somebody posts by hand is still accepted, and
  the wallet no longer offers it. After `npm run appoint` on the
  masterpod the pod sees its new purpose once the wallet has read its
  status again.
- Readings where the plan left a detail open. The computed keeps its
  `const role = this.session.role()` line and loses only the early
  return for an undefined role. The comment of `stakePurposes` is dated
  2026-11-10 in place of 2026-11-08. In 4.3 the dated sentence also says
  that the appointment opens nothing else. In 8.2 the old rule is kept
  in one sentence with its two dates, and the sentence on the refusal
  now names the four purposes. One comment the plan does not name still
  says two purposes and was left: the comment of `refusal` in
  `account.page.ts` ("the two appointment refusals of a moderator or
  attestor stake").
- Spec: 4.3 (the four names, a dated sentence, the last sentence), 8.2
  (Account: the Stake for sentences) and this note. The note of
  2026-11-08 is as it was written.
- `npx ng build` clean (2.12 MB initial, no warnings), in the web_app
  folder with this change alone in it. The built bundle holds the
  `ROLES` map with its four words, each equal to the Stake for list's
  word (the build writes Thai as escapes, so they were decoded first),
  and the new filter in place of the old one. The filter's expression,
  run in a script outside the repo on the six purposes as the bundle
  spells them, gives daoVote and guardian for no role and for null, and
  those two with the role for each of the four roles. Not run in a
  browser here: the run-through is the user's (the plan's section 5). A
  pod with no role sees daoVote and guardian only; after `npm run
  appoint … validator` it also sees validator; an appointed moderator or
  attestor sees what it saw before, without validator and masterPod.

### The finish: keyholders first, the money before the new key, every move filed (2026-11-10)

Built from `forclaude/recovery-finish-order-plan-1.md` (FINAL), step 1 of
its three, one commit; its step 2 (the masterpod's spec and two comments)
and step 3 (the records) are words only and follow on the user's word.
Three changes to the finish of a recovery (12.3), from a planning chat of
2026-11-10. The user: "This is a real issue" and "We can just change the
order, keyholders first, then masterpod" (A); "The swap of 3 and 4 sounds
right" (B); "It would be great to go ahead and fix the filing with the
masterpod at the same time" (C). Wallet only: nothing changes in what the
masterpod, the validators, the doormen, the keyholders, the bankers'
program or the signing server do; no route, no proxy change, no new
package, and no new word in either language. Two more decisions of the
user's came into the plan the same day, after the planning chat had
checked this build against it, and are in the same commit: 16 (an old
account the validators do not know counts as empty, under C below) and 17
(three lines that described the old filing are put right, under the
services and the spec below).

- A, the new key's shares go to the keyholders first and the masterpod
  is told second. Until now `completeRotation` posted
  `/rotate-backup-code` and deposited afterwards, so between the two the
  new key lived only in the tab. Three ways led into that gap: the tab
  closed between the two calls; the masterpod's answer lost, after which
  Retry signed with the old key and got `401 bad signature`; too few
  keyholders up and the tab not kept open. The cost was an anoPod that
  could not be recovered again: at the next lost passkey the bankers'
  shares rebuild the old key, which opens nothing and which the masterpod
  refuses. Now, in `src/app/pages/recover-case.page.ts`: the step's
  signals are `deposited` (the shares are with the keyholders, only the
  masterpod call is left), `depositFailed` (a deposit was tried and
  failed) and `rotated` (the masterpod took the new key, the step is
  done); until now `rotated` meant the masterpod was told with the
  deposit left, and `deposited` the step done. In the template
  `[completed]` and the result line read `rotated()`, and the button
  reads `common.retry` when `deposited()`, `recoverCase.retryDeposit`
  when `depositFailed()`, else `recoverCase.makeNewCode`. `makeNewCode`
  lost the line that set `rotated` to false. `completeRotation` runs in
  this order: the new key made when none is held, with the guards as
  before; the old key in the tab (`recoveredCode`), else
  `recoverCase.noCurrentCode`, now before anything is deposited; when
  `deposited()` is false, the deposit (a failure sets `depositFailed` and
  shows as before, a success clears it and sets `deposited`);
  `/rotate-backup-code` with the same message and the proof by the old
  key; then `rotated` set and the old key, the new key, its blob2 and
  its keys dropped. The deposit is made once: when the masterpod call
  fails after it, Retry repeats that call alone. When the masterpod call
  is not ok, the new private `rotationLanded(blob2)` is asked, and
  `/rotate-backup-code: <reason>` is thrown only when it answers false:
  the recovery envelope for `/get-recovery-pod`, the call made quietly;
  true when the answer is ok and its `blob2` is the hex of the new
  blob2, false in every other case, a missing session included; an ok
  answer is applied as the poll applies one. So a lost answer no longer
  blocks the step.
- B, "Move your money" is the third step and "New key for the bankers"
  the fourth. In the template the two `<mat-step>` blocks traded places;
  nothing else moved, and the methods stand in the file where they stood.
  Why: Get back in opens the masterpod's blob2 with the key rebuilt from
  the delivered shares, the old key; once the masterpod holds the new key
  that fails, so a reload after the new key and before the money was
  moved left the anos in the old accounts until a new recovery case (a
  moderator dismisses the stuck one, two moderators approve again, the
  bankers deliver again). The money step needs nothing from the new key.
  `moveMoney` still wipes the seeds at its end and empties what
  `RecoveryService` holds from Combine, the backup code candidates with
  them; the new-key step reads the old key from the page's own field
  `recoveredCode`, which Get back in set and the money step does not
  touch. (The step 5 note of 2026-11-08 above says the candidates are
  dropped when "the rotation is done": that was the old order. Nothing
  reads them after Get back in.)
- C, "Move your money" asks the validators what they already hold and
  files every move with the masterpod at once, so the step can be run
  again without losing or doubling anything. It closes the gap the step 5
  note of 2026-11-08 above records, with the read that note names.
  `moveMoney` now runs: the accounts and the seeds matched, as before;
  the accounts of the moves `/list-my-break-glass-moves` lists count as
  filed, as before; then the reads, every one before anything is
  written: for each other matched account `/get-assisted-transfer` and
  `/get-account`, both signed by its break-glass pair. A held transfer
  whose `type` is `breakGlassTransfer` is a move to file, with the held
  transfer's `transactionId` and `accountIdTo`; else a balance of 0 is
  empty; else the account is one to move, with the balance, the latest
  transaction id and the minutes ahead, as before. An old account the
  validators do not know never reached the ledger, so it holds nothing
  (the plan's decision 16): when its first read is refused with `401` and
  a reason saying `unknown account`, it counts as empty and the next
  account is read, without its second read. The test is the one
  `balances.service.ts` uses for an account that has not landed,
  `status === 401 && /unknown account/.test(reasonOf(res))`. Before
  decision 16 that refused read stopped the step before any account was
  moved. Every other refused read stops the step, as before. Each move to
  file is filed. Then, for each account to move: `createAccount` of the
  same type, the transfer built and posted as before; when the post is not
  ok, `/get-assisted-transfer` is read again with the break-glass pair,
  and a `breakGlassTransfer` there is the move, with the validator's
  `transactionId` and `accountIdTo`, while anything else throws
  `recoverCase.moveRefused` with the validator's reason; then the move is
  filed, before the next account. Last the seeds wiped and the result
  line, as before. The new private `fileMove(caseId, move)` posts
  `/file-break-glass-moves` with the one move: an ok answer, or `409`
  saying the move is already filed, counts as filed; anything else throws
  `/file-break-glass-moves: <reason>`. Gone are the list of moves kept
  for the end, the one filing call after the loop and the line that
  counted a validator's "already there" as filed; `ALREADY_THERE` stays
  in `account-creation.service.ts` for the creations, and its import left
  the page. So an old account with a transaction of its own still waiting
  on the validators (a lock, an escrow trade, an assisted transfer) now
  stops the step with the validator's words, where it was counted as
  filed although nothing was; the step can be run again in the same case
  once that transaction is done. The 20 moves a single filing call may
  carry stop being a limit.
- `src/app/services/anos-api.service.ts`: `getAssistedTransferAs(envelope,
  quiet)`, which `getAssistedTransfer` calls, as `getAccount` calls
  `getAccountAs`; `HeldAssistedTransfer` gains `type`, as the validator
  answers it. `src/app/services/crypto.service.ts`: the comment of
  `signAccountEnvelopeAsBreakGlass` names both reads; no code changed
  there. Two more comments, no code (the plan's decision 17): in
  `src/app/services/account-creation.service.ts` the comment over
  `ALREADY_THERE` no longer says the finish counts it as a move already
  filed (the pattern is as it was, and only the creations read it now);
  in `src/app/services/masterpod-api.service.ts` the comment over
  `fileBreakGlassMoves` says the finish sends one move per call.
- Unchanged: `SharesService`, the code of the masterpod API service and
  of the account creation, the Wallet and Account pages, Setup, `en.ts`
  and `th.ts`, `server/`. Every word on the screen is one the wallet
  already had; "Retry" on the button is `common.retry`.
- Accepted by the plan (its decision 15). The tab closed after the
  deposit and before the masterpod call: the old key stays the key and a
  second recovery works, but the unused new shares are then the newest
  rows, so the bankers have to tick the older row as well. A failed
  deposit leaves the shares that did get stored under a key id nothing
  names, as Setup does. An anoPod that fell into the gap of A before this
  change is not mended by it. While "Move your money" keeps failing, the
  new key is not made and the case cannot be completed; the person is
  back in all the same, and the finish can be picked up again in the same
  case. A failure after a new account is made and before its move reaches
  a validator leaves that account unused, and Retry makes another, as
  before; each counts toward the 20 new accounts in 30 days (4.4). A
  person who closes the tab in the moment between a move reaching the
  validators and its filing, and never comes back, leaves that move
  unfiled; coming back to the finish files it. The attestors may see the
  case with fewer moves for a few minutes, since the moves arrive one by
  one, and the case's log gets one "opened" line per move.
- Readings where the plan left a detail open. Both reads of step (3) are
  made for every account, `/get-assisted-transfer` first, also when it
  already answered a break-glass move; a refusal of either stops the
  step, as `/get-assisted-transfer: <reason>` or `/get-account:
  <reason>`, but for the unknown account of decision 16. That test stands
  on the first read alone: both reads pass the validator's same account
  check, which answers `401 unknown account` before it looks at a
  signature (anossoftware `src/auth/require-account.js`), so the second
  read cannot say it of an account the first read knew. The reads are
  not quiet, as the `/get-account` read was not, so the Log shows them.
  After a refused post, a second read that is itself
  refused or unanswered counts as "anything else": the step stops with
  `moveRefused` and the post's reason. A move found on the validators is
  filed with the old account's id as the masterpod lists it and the
  validator's two other ids. `rotationLanded` keeps the poll's guard (an
  answer that arrives after the recovery session went away is not kept,
  and the answer is false), clears the page's error line on an ok answer
  as the poll does, and sets no error on a refused one. Any failure of
  the deposit sets `depositFailed`, a `DepositError` or not.
  `HeldAssistedTransfer.type` is typed like `AssistedTransferItem.type`
  (the two words or any string) and stands after `transactionId`, where
  the validator answers it. `getAssistedTransferAs` stands after
  `getAssistedTransfer`, as `getAccountAs` after `getAccount`. The three
  signals stand where the two stood. The comments that number the steps
  follow the new order (`makeNewCode` and `completeRotation` step 4,
  `moveMoney` step 3), and the class comment names the order and the
  changes.
- Spec: 5.4 (`/get-assisted-transfer`: `type` in the answer, and the read
  with the break-glass pair), 8.3 (the line of `anos-api.service` names
  `getAssistedTransferAs`, decision 17), 12.3 (the order, steps 3 and 4,
  the last paragraph), 12.4 (the line of `anos-api.service`) and this
  note. The older notes above and 12.7 stand as the record of what was
  built then.
- `npx ng build` clean (2.12 MB initial, no warnings), in the web_app
  folder with this change alone in it, and clean again with decisions 16
  and 17 in. Not run in a browser here: the steps need a live recovery
  case with delivered shares, so the run-through is the user's, after
  the deploy (the plan's section 4; only the wallet has something to
  deploy). The finish reads Combine, Get back
  in, Move your money, New key for the bankers, Done. After "New key for
  the bankers" each keyholder shows one more `backupcode` row for the
  lookup id. To see C: reload the page while "Move your money" runs,
  after the first move went out; continue the recovery and run the finish
  again; no second new account is made for that old account, and the
  attestor edition lists its move.

### The balance card: Total with the stakes, then Available, Staked and In escrow (2026-11-10)

Built from `forclaude/wallet-balance-card-plan-1.md` (FINAL), its one
step, one commit, on top of bfef9de. Why, in the user's words of
2026-11-10: "It shows a big number and then a smaller number and calls
the smaller number available Anos, but they're actually the same. We
probably want to show total Anos big, first and clear. Then we probably
want to show available Anos. Then we should show staked Anos. Then we
should show escrowed Anos. Those three should add up to the total." and
"we should be able to click on each to see more details". Until now the
card showed Total, the accounts' balances, and under it "Available 900
anos", the same number whenever nothing was spoken for; a stake had left
its account and was on the card nowhere. Wallet only: the validators
already answer each account's stakes in `/get-account` (5.4), so there
is no server change, no route, no proxy change, no env variable and no
new package.

- `src/app/services/balances.service.ts`: `AccountBalance` gains
  `stakes` (the account's stake per purpose in millionths, the purposes
  above zero only, from `stakes` of the `/get-account` answer; empty
  when the answer has none), `staked` (their sum) and what the sheet
  lists, as the reads answer them: `escrows` (the trades counted in
  `escrow`, the ones the account sells in), `assistedTransfer`,
  `lockedTransfer` (the held transfer or null) and `pendingTransfers`.
  `Totals` gains `staked`, summed over the landed accounts; `total`
  keeps its meaning, what the accounts hold. The entry of an account
  that is not on the ledger or is lost carries the empty values.
  `needsPoll` is unchanged. No new read: `readOne` makes the same calls
  as before and keeps more of their answers; `stakesOf` turns the
  answer's stakes into the entry's.
- `src/app/components/balance-card.component.ts`: the big number is
  `total` plus `staked`. Under it the rows, the label on the left and
  the amount on the right: Available, Staked, In escrow, and Being sent
  (`assisted` plus `locked` plus `pending`) only when it is above zero.
  A row above zero is a `<button>` with a small `chevron_right` and
  opens the sheet for its kind with `MatBottomSheet`; a row at zero is a
  plain `<div>`. Then the two small lines (accounts not on the ledger
  yet, accounts not read). "Total", the refresh button, "No anos account
  yet." and "Reading…" are as they were.
- `src/app/components/balance-sheet.component.ts`, new:
  `BalanceSheetComponent`, opened with the data `{ kind }`, one of
  `available`, `staked`, `escrow` and `sending`. It reads
  `BalancesService`, the session's accounts and their names itself. The
  title is the row's label and amount ("Staked · 250 anos"); the rows
  are those of 8.2 (the balance sheet), in the accounts' order, the
  purposes in the order of `STAKE_PURPOSES`, the trade's stage through
  `escrowStageWords` with the side `seller`. A row that leads somewhere
  is an `<a routerLink>` whose tap also dismisses the sheet; a Staked
  row is a `<div>`. The style follows `picker-sheet.component.ts`. The
  file also exports `BALANCE_KINDS` and `balanceLine(kind, totals,
  words)`, a kind's label and amount, which the card's rows and the
  sheet's title both use, so the two cannot drift apart.
- `src/app/i18n/en.ts`, `th.ts`, under `balanceCard`: `available` and
  `inEscrow` were sentences with the amount inside and are plain labels
  now ("Available", "In escrow"); `staked` ("Staked") and `sending`
  ("Being sent") are new; `inAssisted`, `waitingOutLock` and `inPending`
  are gone. The Thai is the plan's: "ใช้ได้", "วางหลักประกันไว้",
  "อยู่ในเอสโครว์", "กำลังส่ง"; a Thai reader has not checked it. The
  sheet's rows use words the wallet already had: `common.anos`,
  `account.to`, `account.stakePurposes`, `escrowStages`,
  `wallet.inAssisted`, `wallet.waitingOutLock` and `wallet.pending`.
- Unchanged: the cards of the single accounts on the Wallet page (the
  plan's decision 12), `wallet.page.ts`, `home.page.ts`,
  `account.page.ts`, `anos-api.service.ts`, `server/`.
- Accepted by the plan (its decision 13). An account with an open trade
  or a waiting transfer can send nothing else until that is done, yet
  the rest of its balance counts as available, as before. An account
  lost with an old passkey counts nowhere, as before. The stakes of an
  account that could not be read are not counted; the "could not be
  read" line says an account is missing. Out of the plan: stakes on the
  account page; taking a stake back; the anos of trades the person buys
  in, which are not theirs yet; the value in a currency.
- Readings where the plan left a detail open. The stakes are read for
  the six purposes of `STAKE_PURPOSES`: one the answer leaves out counts
  as zero, and a purpose the wallet does not know is not counted. Every
  row of a sheet starts with its account's name in bold; what the plan
  lists after it stands under it (the purpose; the trade and, in small
  type, its stage and date; the transfer's sentence), and the amount
  stands at the right on the Available and Staked rows, where no
  sentence says it. The buyer's id in the In escrow row is the short
  form in the id font (the account page's own list shows the full id).
  Within one account the Being sent rows stand in the Wallet page's
  order: the assisted transfer, the lock, the pending rows. A pending
  row with no amount (the validator answers "0" for it) is no row of the
  Being sent sheet, since it sends no anos; the service keeps it in
  `pendingTransfers` as answered. The sheet's rows have no arrow, as the
  picker's have none. A plain row of the card keeps the arrow's room, so
  the amounts stand in one column. A sheet whose amount falls to zero
  while it is open stays open, with "Being sent · 0 anos" and no rows.
  The sheet opens with `autoFocus: 'dialog'`, as the marketplace's
  sheets do. 8.3 lists the new component among the services, because the
  plan names 8.3 for it.
- Spec: 5.4 (`/get-account`: who reads `stakes`), 8.2 (Home; Wallet, the
  card; the new paragraph on the balance sheet), 8.3 (the balances
  service's fields, the new component) and this note. The older notes
  above stand as the record of what was built then.
- `npx ng build` clean (2.12 MB initial, no warnings). Seen here in a
  development build served from a scratch folder, with a made-up session
  set through the browser's debug tools to reach Home and the Wallet
  page, and made-up accounts and balances (five accounts; two stakes, an
  escrow trade, a pending transfer, a lock and an assisted transfer),
  so no keyholder, masterpod or validator was asked. On Home at 360, 390
  and 430 px wide, in English and in Thai: the card is whole, each row
  is one line and 40 px high, the labels start under "Total", the
  amounts end in one column with the arrows right of them, and nothing
  overlaps or runs off the screen; each of the four sheets lies at the
  bottom of the screen at the screen's full width, its title on one
  line, its rows whole, and its rows add up to its title. The small line
  of the In escrow row takes two lines in English at all three widths
  and in Thai at 360 px. The same at 360 px on the Wallet page, where
  the card is 294 px wide. With nothing staked and no trade, Total and
  Available are equal, Staked and In escrow read "0 anos" with no arrow
  and open nothing, and Being sent is not shown. A tap on a row of a
  sheet closed the sheet and opened its page, and an open sheet followed
  a change of the balances. With amounts of twelve digits at 360 px the
  big number and the longest Thai label ("วางหลักประกันไว้") wrap to a
  second line and nothing is cut. The browser pane was not on screen
  during the look, so the page drew no frames of its own and the sheet's
  slide was not watched: in the scratch page the animation was switched
  off and its start and end were sent by hand. Not seen on a phone, not
  on the test net and not against a validator: the run-through is the
  user's, after the deploy (the plan's section 2; only the wallet has
  something to deploy).

### One validator per session, the next one when it does not answer (2026-11-10)

Built from `forclaude/wallet-round-robin-plan-1.md` (FINAL), its one
step, one commit, on top of e7f06ad. Why, in the user's words of
2026-11-10: "The wallet has a registry of the current validators, I
believe, but it only ever calls validator 1, we should instead have it
round robin it." Asked whether that means one validator per browser
session or another one for every call, the user took one per session
("That sounds good"): the wallet reads an account and then builds a
transfer on what it read, the latest transaction id, and a balance
refresh makes three or four reads per account at the same moment, so
reads spread over several validators could disagree for a moment. Until
now every validator call of the browser went to
`/api/anos/<defaultValidator>`, the proxy's `DEFAULT_VALIDATOR`, 1. The
change is in the browser's code. In the proxy only comments changed, no
line of code. There is no new route, no new env variable, no new
package and no new word in either language, and nothing changes on the
validators, the doormen, the masterpod, the keyholders or the signing
server.

- `src/app/constants.ts`: `VALIDATOR_READ_TIMEOUT_MS`, 10 000, how long
  a validator has to answer a read (the plan's decision 7). Without a
  limit a validator whose machine cannot be reached would hold a page
  for the proxy's two minutes before the wallet moves on.
- `src/app/services/anos-api.service.ts`: the private field
  `sessionValidator`, a number from 1 to the `validators` of
  `/api/config`, empty until the first call. `validator()`, public,
  answers it and picks it when none is set, `1 +
  Math.floor(Math.random() * validators)`; nothing secret hangs on the
  pick. The private `post` is gone. `read(path, body, quiet)` took its
  place for the nine reads (8.3 lists them; `getAccountAs` and
  `getAssistedTransferAs` are the two that `getAccount` and
  `getAssistedTransfer` call): the call goes to
  `/api/anos/<the session's validator>` through `LogService.post` with
  the time limit; an answer is returned; with no answer the session
  moves on and the call is made again, until the session's validator is
  one this call has asked already; then the last failure is returned.
  So a call asks each validator at most once and makes at most
  `validators` tries. `write(path, body, quiet)` took its place for the
  eight submissions (8.3 lists them): one try, no time limit; with no
  answer the session moves on; the result is returned as it is.
  `moveOn(from, validators)`, private, puts the session on the next
  validator in the list, the first after the last. `noAnswer(res)`, a
  function under the class, is the plan's decision 4: status 0, 502,
  503 or 504, and every other status is an answer. The comment of the
  class says all this.
- `src/app/pages/attesting-trade-case.page.ts`,
  `attesting-dispute-case.page.ts` and
  `attesting-recovery-case.page.ts`: in `send`, after the posts,
  `await this.anos.validator()` in place of `defaultValidator` from the
  configuration. The number goes where `defaultValidator` went: to
  `/mark-attestor-case-sent` or `/mark-break-glass-case-sent`, and into
  the sent line. The words on the screen and the masterpod call are
  unchanged.
- Comments only: `src/app/services/config.service.ts` (`defaultValidator`
  is still in the answer and no longer read), `server/config.js`,
  `network/wallet.env` and the variables sentence of `README.md`
  (`DEFAULT_VALIDATOR` no longer picks the validator; the browser picks
  one per session; the variable stays for tabs loaded before the
  change). `DEFAULT_VALIDATOR`, its boot check and `defaultValidator` in
  `/api/config` stay as they are (the plan's decision 10), so a tab
  loaded before the deploy keeps working; taking them out is a later
  clean-up. The list in `network/wallet.env` is the user's to keep and
  was not changed (decision 11).
- Unchanged: the code of every other page and service that calls the
  validator API service (its methods take and resolve to what they did),
  `LogService`, `en.ts` and `th.ts`, the code of `server/`.
- Accepted by the plan (its decision 12). A validator that answers but
  is behind the others is not noticed: a session that started on it
  stays there until a reload. A phone without a connection makes one
  quick try per validator for each read before it shows the failure.
  Out of the plan: a health check of the validators; the proxy picking
  the validator; weights; the keyholders, which are already asked all
  at once; the signing server's second server; the masterpod's own call
  to a validator.
- Readings where the plan left a detail open. Calls that get no answer
  from the same validator at the same moment move the session on by one
  place, not by one each: `moveOn` changes the session's validator only
  while it is still the one that did not answer. A balance refresh makes
  its reads at once, so without this twenty reads on a stopped validator
  would move the session twenty places and spread the repeated reads
  over every validator, the stopped one among them. A repeated read goes
  to the validator the session is on at that moment: the next one in the
  list, or one further on when another call moved the session in the
  meantime; a read that skipped a validator this way makes fewer than
  `validators` tries before it gives up. When no validator answers a
  read, the session has gone once round the list and stands where it
  started. Past the time limit a read answers the way a keyholder
  deposit call does (`LogService.post` with `timeoutMs`): status 0 with
  `api.noAnswer(10)` as its reason, a word the wallet had. A read slower
  than 10 seconds for any reason, a slow phone connection among them,
  counts as not answered. A submission that fails with status 0, the
  phone having no connection, moves the session on too, since that is no
  answer at all. Every try of a read that is not quiet is a line of the
  Log, with its validator's number in the path. When one of an attestor
  page's posts got no answer, the session moved during the posts, and
  the page names the validator the session is on after them, as the
  plan's decision 9 says; the answer recorded for the earlier post came
  from the validator before it. `validator()` is async, because the
  count comes from `/api/config`. In the file the field stands under the
  injected services, and `validator`, `read`, `write` and `moveOn` at
  the end of the class, where `post` stood.
- Put right on the user's word of 2026-11-10 ("Yes, fix them"), after
  the first report of this build listed them as left because the plan
  does not name them. Ten comments that said "the default validator"
  for the validator the wallet asks say "the session's validator": the
  one over `send` in each of the three attestor case pages, four more
  in `attesting-recovery-case.page.ts`, the class comment of
  `src/app/pages/attesting.page.ts` and two in
  `src/app/services/attesting.service.ts`; one word each, no code. In
  `attesting-dispute-case.page.ts` the `config` field and the
  `ConfigService` import left the page: `send` was their only reader,
  while the other two pages still read the keyholder count through
  theirs. In this spec 8.2 (Guardians), 13.3 (the Trades tab's list and
  the recovery case's moves) and 13.6 name the session's validator.
- Left as they are. The sentences `tradeCase.stillToSend` and
  `disputeCase.stillToSend` still end "to the default validator" in
  `en.ts`, and say the same in `th.ts`: the plan keeps the words on the
  screen. Read "the session's validator" there.
- Spec: 2 (the row of `DEFAULT_VALIDATOR`, a paragraph under the lock
  numbers, `defaultValidator` in the line of `/api/config`), 8.2
  (Guardians: where the data comes from), 8.3 (the line of
  `anos-api.service`: the base path, the session's validator, the read
  and the submission, the time limit, what counts as no answer), 13.3
  (the Trades tab's list, the recovery case's moves, and the three Send
  to the validators points: the session's validator in place of the
  default one, and which validator the sent line names), 13.6 (where
  the lists come from) and this note. The older notes above stand as
  the record of what was built then.
- `npx ng build` clean (2.12 MB initial, no warnings), and clean again
  with the lines above put right; `node --check server/config.js`
  passes. The built bundle holds no
  `defaultValidator` any more, and holds `read` with the time limit and
  `write` without one. Not run in a browser here and no server was
  started: the run-through is the user's, after the deploy (the plan's
  section 2; only the wallet has something to deploy, wallet1 and then
  wallet2). The Log page shows the calls as `/api/anos/<n>/...`; two
  tabs, or one tab reloaded a few times, show different numbers. With
  one listed validator stopped, a tab that picked it shows its balances
  after the reads that were under way failed once each in the Log (502
  at once when only the worker behind its doorman is down, status 0
  after 10 seconds when the machine cannot be reached), and from then on
  calls the next number.

### The script and style files travel compressed (2026-11-11)

No plan: one change on the user's word of 2026-11-11 ("Turn on
compression for scripts and styles"), after a look at why the site is
slow at times. Measured from outside that day: the wallet servers sent
the build's script as it is, 2,116,082 bytes (`main-FHPDFECC.js`), 4 to
5 seconds to download, because nginx compresses only HTML unless it is
told the other types. The site `deploy/nginx/wallet.conf` now says so,
inside each of the three named server blocks: `gzip on`, `gzip_vary on`,
`gzip_comp_level 6` and
`gzip_types text/css text/javascript application/javascript`.

- On the wire: a browser that sends `Accept-Encoding: gzip` gets the
  script and the style file with `content-encoding: gzip`; at level 6
  the script is about 483 KB (610 KB at nginx's own level, 1). A browser
  that does not ask gets the files as before. `gzip_vary` adds
  `Vary: Accept-Encoding`, so a cache in between keeps the two apart.
- The answers under `/api` are JSON and are not compressed. The user
  asked for scripts and styles, which are public and the same for
  everyone; answers that carry secrets are a question of their own.
- The lines stand in the server blocks, not at the top of the file. The
  file is read at the level of the server's `/etc/nginx/nginx.conf`,
  which has `gzip on` already (the HTML arrived compressed before this
  change), and a second one at that level is refused as a duplicate.
- `application/javascript` stands beside `text/javascript`, which is
  what the proxy's static files say today, for a version that says the
  older name.
- Nothing in `server/` or `src/` changed and the Angular build is the
  same. On a wallet server the change takes effect with the install
  script, which copies the site, runs `nginx -t` and reloads nginx
  (README, "The wallet servers"). Not run here: this machine has no
  nginx. The install script's `nginx -t` is the check; when it refuses
  the file the script stops before the reload and nginx keeps the old
  site. To see it afterwards, with the script's name from the page's
  source:
  `curl -s -I -H 'Accept-Encoding: gzip' https://wallet.anocloud.com/main-<name>.js | grep -i content-encoding`
  prints `content-encoding: gzip`.
- Spec: this note; README, "The wallet servers"; the file's own header.

### The locked transfer cancel (2026-11-11)

Built from `forclaude/locked-transfer-cancel-plan-1.md` (FINAL), its step
4 of five, its section 3, one commit, on top of ab766a5. Why, in the
user's words of 2026-11-11: "I believe at some point I wanted to add the
feature where the user could cancel a guarded or vault transfer. But I
don't see any button like that on the web app." And: "We need cancel
before production." A guarded or vault transfer waits out its lock on
the validators, a week or a month in production. One sent by mistake
went through when the lock ended, and the account could send nothing
else until then. The cancel had never been built: the validators had no
route for it, and the Home plan of 2026-11-06 left it out (section 10).
Steps 1 to 3 of the plan built the other two parts. The validators'
(anossoftware 0f80003 and becc435, its spec sections 27 and 28): the
time check on every transfer, the wait before a cancel, the follow-up
kind `lockedTransferCancel` at `POST /locked-transfer-cancel`, and the
stage `cancelling` in `/get-locked-transfer`. The doorman's
(doormansoftware 30434d5, its spec section 9): the validator door lets
the route through. This step is the wallet: one button, one box, one
follow-up, and one sentence on three pages for a cancel pressed too
early. No route of the proxy, no setting, no npm package.

- `src/app/services/crypto.service.ts`: the interface
  `LockedTransferCancelPayload` (`type: 'lockedTransferCancel'`,
  `transactionId`, `accountId`) after `AssistedTransferCancelPayload`,
  and in `FollowUpPayload`. `buildFollowUp` is untouched: it adds
  `signedAt` and signs with pair one, as for every follow-up.
- `src/app/services/anos-api.service.ts`: `LockedStage` has
  `'cancelling'`, and its comment says what the stage is;
  `lockedTransferCancel(followUp)` after `assistedTransferCancel`, which
  is `this.write('/locked-transfer-cancel', followUp)`, the ninth
  submission; the import.
- `src/app/locked-stage.ts`: `case 'cancelling'` reads
  `words.cancelling`. The comment says the transfer can be cancelled
  from its row and still has no page of its own.
- `src/app/components/confirm-dialog.component.ts`: `ConfirmData` has
  `cancelLabel?: string`, and the first button shows
  `data.cancelLabel ?? t().common.cancel`. The comments say so.
  `askConfirm` and the two places that used the box are untouched and
  keep Cancel.
- `src/app/pages/account.page.ts`: the signal `cancelOutcome`, beside
  `sendOutcome`. In the template's Locked transfer section, inside the
  branch that shows the row and after the `mat-list`: a `div` of class
  `row` with one stroked button, `assisted.cancelTransfer`, which calls
  `askCancelLocked()`, is off while `busy()` and is drawn while the
  stage is `locked` or `due`. After the section's `@if` chain, still
  inside the guarded or vault block: the outcome line of
  `cancelOutcome()` with the classes `ok` and `error`, as `sendOutcome`
  is shown. The row's own lines are untouched: a stage that is not
  `locked` reads its stage word and the date, so a `cancelling` row
  reads "Being cancelled · <date>". `askCancelLocked()` does nothing
  with no locked transfer or with a box already open. Else it opens the
  box with `askConfirm`: the title `account.confirmCancelTitle`; the
  lines `common.amount`, the amount through `common.anos`, and
  `common.to`, the receiver's id with `code` true; the note
  `account.confirmCancelNote(anos)`; `confirmLabel`
  `assisted.yesCancel`; `cancelLabel` `common.back`. On Back nothing
  happens. On yes, through `act(this.cancelOutcome, ...)`: pair one;
  `buildFollowUp` with `{ type: 'lockedTransferCancel', transactionId,
  accountId }`; `this.signing.sign(...)`, the way `send()` signs;
  `anos.lockedTransferCancel`; a refusal thrown in the words of
  `cancelRefusal`, else `assisted.sentCancel`; then `refresh(true)`.
  `cancelRefusal(res)` is the body of the assisted transfer page's
  `plainReason` for this route, the five refusals as 8.2 lists them.
  `send()` starts with `this.cancelOutcome.set(null)`, so the line of an
  old cancel does not stand under a new transfer; nothing else in
  `send()` changed. The class comment says the transfer can be cancelled
  from its row, where it said "nothing can be done with it".
- `src/app/pages/assisted-transfer.page.ts` and
  `src/app/pages/escrow-trade.page.ts`: one new line in each
  `plainReason`, before its last. A reason that holds "cannot be
  cancelled yet" reads `account.cancelNotYet` on the first page and
  `escrow.cancelNotYet` on the second, with the proxy's
  `lockOffsetMinutes` in words (`minutes`). While that number has not
  loaded the line is skipped, and the refusal reads as any other does.
  Each page injects `ConfigService` for the number; neither had it.
  Nothing else on the two pages changed: the buttons are as they were
  (the plan's decisions 24 and 32). The validators' waits behind the two
  sentences are the plan's step 1 (anossoftware spec 27.2).
- Words, English and Thai, as the plan's table 3.2 gives them. Changed:
  `account.lockWaiting` ("... when it is written or cancelled.") and
  `account.lockLine` (one sentence more at the end, "You can cancel it
  until it is written."). New: `account.confirmCancelTitle`,
  `account.confirmCancelNote(anos)`, `account.cancelNotYet(minutes)`,
  `escrow.cancelNotYet(minutes)` and `lockedStages.cancelling`. Reused
  as they are: `assisted.cancelTransfer`, `assisted.yesCancel`,
  `assisted.sentCancel`, `assisted.notAllAccepted`,
  `assisted.alreadyCancelling`, `assisted.noLongerHeldReason`,
  `assisted.cannotCancel`, `common.back`, `common.amount`, `common.to`
  and `common.anos`. The Thai is the planner's, built from the Thai of
  the assisted cancel, and a Thai reader has still to check it (the
  plan's decision 21).
- `README.md`: the layout line of `confirm-dialog.component.ts` names
  the cancel of a locked transfer too.
- Unchanged: `server/`, where the proxy forwards the new path as it
  forwards every path under `/api/anos/<n>`; `network/wallet.env`; the
  signing service; the balances service, the Wallet page and Home, where
  a transfer being cancelled counts as waiting out a lock until its row
  is gone; the history page, which gets no line for a cancelled transfer
  (the plan's decision 16).
- Readings where the plan left a detail open. The `@if` on the stage
  stands around the button's `div`, so no empty row is drawn in the
  stages without the button. What is cancelled is the transfer the box
  showed: `askCancelLocked()` takes it from `locked()` before the box
  opens and builds the follow-up from that, since the 5-second poll goes
  on while the box is open; when the transfer was written in the
  meantime the validators answer that it is no longer held.
  `cancelling` stands after `due` in `LockedStage`, in the `switch` of
  `locked-stage.ts` and in both dictionaries, as it stands last in
  `AssistedStage` and in `assistedStages`; the validator decides it
  second (5.4). In `cancelRefusal` the checks stand in the order the
  plan lists them, the wait second; in the two `plainReason` functions
  the wait is the line before the last, as the plan says. To stay one
  line there, the line reads the number from the configuration service
  itself, `this.config.config()?.lockOffsetMinutes`, once to see that it
  is a number and once to put it into words, and `cancelRefusal` has the
  same line. The number is there by the time a refusal comes back: every
  submission waits for `/api/config` before it posts (`write`, 8.3), so
  the line is skipped only against a proxy that does not send the lock
  numbers. In the file `cancelOutcome` stands after `sendOutcome`, and
  `askCancelLocked` and `cancelRefusal` after `refusal`, before `act`.
  The three new `account` keys stand after `waitingOutLockUntil`, in the
  order the page uses them, `escrow.cancelNotYet` after `cannotSign`,
  and `lockedStages.cancelling` after `due`. `LockedTransferCancelPayload`
  has no comment of its own, as its neighbours have none. Nothing
  differed from the plan in what the wallet does, but for the progress
  bar of the next point.
- Put right on the user's word of 2026-11-11 ("All three"), after the
  first report of this build listed three places as left because the
  plan does not name them. One: the class comment of
  `src/app/services/anos-api.service.ts` said "The eight submissions go
  through `write`" and says nine; one word, no code. Two: section 10
  gained the bullet "From the locked transfer cancel plan", what the
  plan leaves out on the wallet's side; the plan's 3.3 names only the
  line that left the Home plan's list. Three, the one change to what
  the page does that the plan does not have: the progress bar of a
  cancel. As first built, the bar and "Sending…" under the Send form
  showed while a cancel was on its way, since `act()` turns `busy` on
  for a send and for a cancel alike and that block read `busy()`; under
  the row nothing moved, and on a phone the Send form may be off the
  screen by then. Asked whether the fix adds a bar or takes the other
  one away, the user took one bar per action. In
  `src/app/pages/account.page.ts`: the signal `cancelBusy`, which
  `askCancelLocked()` turns on before `act(...)` and off after it; the
  Send form's block reads `busy() && !cancelBusy()`, so it shows for a
  send only; and after the Locked transfer section's `@if` chain, before
  the outcome line, a `mat-progress-bar` while `cancelBusy()`, with no
  words, as the assisted transfer page has it, so no new entry in either
  language. The buttons stay off during a send and during a cancel, as
  before: they still read `busy()`. `act()` is untouched; it catches
  whatever its action throws, so `cancelBusy` always goes off again. The
  class comment and the comment of `askCancelLocked()` say so, and 8.2
  (Account) has the sentence.
- Spec: 5.4 (the block of `/get-locked-transfer`: the stage list, the
  cancel in place of "Nothing can be done with a locked transfer"), 8.2
  (Account: the Locked transfer paragraph rewritten and two paragraphs
  added after it, the cancel and the wait; the Send paragraph's two
  lines; the Escrow trade and the Assisted transfer pages: the wait
  among each cancel's refusals in words), 8.3 (the line of
  `anos-api.service`: nine submissions, with `/locked-transfer-cancel`;
  the line of `crypto.service`: the follow-up payloads), 8.9
  (`cancelLabel`; three places use the box), section 10 (the cancel
  left the Home plan's leftovers; the bullet of this plan's own
  leftovers) and this note. The older notes above
  stand as the record of what was built then.
- Checked. `npx ng build` in the web_app folder: clean, 2.13 MB initial
  (the script 2.12 MB), no warnings, and clean again with the three
  places put right; `git status` showed this step's
  eleven files and no others. The words: a script outside the repo read
  the seven rows of the plan's table 3.2 and the fourteen entries in
  `en.ts` and `th.ts`, and each entry equals the plan's cell character
  for character. The five reasons a validator gives on this route and
  the reason of the escrow wait were read in the validator's source at
  becc435, and each holds the piece its line of `cancelRefusal` or
  `plainReason` looks for. Not run in a browser here and no server was
  started: the run-through is the user's, on the launched network (the
  plan's section 5), and needs every validator and every doorman on the
  new code. A guarded transfer sent from the wallet: the row reads
  "Waiting for the validators" and has no button; once every validator
  has accepted it the row reads "Waiting out the lock · until ..." with
  "Cancel transfer" under it. A press at once: the box "Cancel this
  transfer?" with Amount, To, the note and the buttons Back and "Yes,
  cancel the transfer"; Back does nothing; yes ends in red under the
  row, "A transfer can be cancelled 5 minutes after it is sent. Try
  again in a few minutes." The same after the wait: a progress bar under
  the row and none under the Send form, then "Sent. The transfer
  is being cancelled; the anos stay in this account." in green, the row
  reads "Being cancelled", then the row is gone, "No transfer is
  waiting." shows and Send is free again. Against validators or doormen
  without the route the button shows and a press ends in the refusal
  under the row; nothing else on the page changes. The wallet goes out
  by section 10 of `forclaude/wallet-deploy-plan-1.md`, wallet1 and then
  wallet2, with no setting in `network/wallet.env` and no `npm ci`.

### The 5-second balance read takes only the watched accounts (2026-11-11)

Built from `forclaude/wallet-speed-plan-1.md` (FINAL), its step 1 of
two, its section 1, one commit, on top of 0cfb88c. Why, in the user's
words of 2026-11-11: "I'm also trying to figure out why sometimes the
site starts moving soooo slow." And, of this cure: "What about keeping
connections open and the re read only if an account has something?"
Home and the Wallet page read the balances again every 5 seconds while
an account is not on the ledger yet or any anos are held or pending, and
that read took every account of the session: three signed reads per
account, four on an assisted, a guarded or a vault one. So one open
trade on one account made the page read every account every 5 seconds.
With ten accounts that is 30 to 40 calls a round, each signed in the
browser on the page's own thread: about 0.35 to 0.45 seconds of signing
a round on the user's M4 Mac (a phone was not measured). Now a round
reads only the watched accounts: the ones that are not on the ledger
yet, and the ones with anos held or pending. The change is in the
browser's code only. There is no route, no proxy change, no env
variable, no npm package and no new word in either language, and
nothing changes on the validators, the doormen, the masterpod, the
keyholders or the signing server. A send never used these entries: the
account page and the listing card read `/get-account` fresh right before
they build a transfer. So this changes what is shown, never what is
sent. Step 2 of the plan, the proxy's connections to the validators, is
not built with it.

- `src/app/services/balances.service.ts`: `poll()`, public and new, one
  round of the 5-second read. It returns at once while a read runs
  (`busy`), as `refresh` does. When the pod is not the one last read,
  the round is `refresh(true)`. The watched accounts are the session's
  accounts that are not lost and have no entry yet, an entry that is not
  landed, or an entry whose `held` is above zero: the test `needsPoll`
  makes, for one account (`isWatched`, a function under the class). With
  no watched account nothing is read and nothing is set. Otherwise the
  watched accounts are read at the same time with `readOne(item, true)`,
  under `busy`, as `refresh` reads every account. After the reads a full
  read follows, `refresh`, in two cases. One: the round changed
  `landed`, `balance` or `held` in a watched account's entry
  (`entryChanged`, a function under the class), and the session has an
  account that is not lost and was not read in the round. Two: a full
  read was asked for during the round. Otherwise the round ends as
  `refresh` ends: `loadMoves(true)` when an account is lost, then
  `readAt`.
- The same file, `refresh(quiet)`: one change, its first lines. When it
  finds a poll round running (the private field `polling`), it leaves
  word (the private field `fullAsked`) and returns, and the round runs
  that read when it ends. The read is quiet only when every `refresh`
  that left word during the round was quiet. When it finds another
  `refresh` running it returns, as before. `needsPoll`, `readOne`, the
  totals, `usableAccounts`, `markLost` and `loadMoves` are unchanged.
  The class comment has a second paragraph that says all this, and the
  comment of `refresh` names the word it leaves.
- `src/app/pages/home.page.ts` and `src/app/pages/wallet.page.ts`: in
  the constructor's timer, `void this.balances.refresh(true)` became
  `void this.balances.poll()`. The condition in front of it is as it
  was, and the comment over the timer says which accounts are read
  again. Nothing else in the two pages changed, but for their class
  comments (the point "Put right" below).
- Unchanged: the pages' `load`, the card's refresh button, the Wallet
  page's Refresh and `src/app/services/account-creation.service.ts`,
  which keep calling `refresh`, the full read; the account page, which
  reads its one account by itself; the marketplace chat's listing card,
  which keeps its own 5-second check (the plan's decision 4); `server/`.
- Accepted by the plan. Its decision 7: while something is held on one
  account, the other accounts are not read again by themselves. Anos
  that arrive on them show when Home or the Wallet page is next opened,
  or with the refresh button on the card. That is how it already was
  when nothing is held. Its decision 10: an account whose creation was
  never finished stays "not on the ledger yet", so `needsPoll` stays
  true for good and that account is still read every 5 seconds, alone
  now. Out of the plan: the listing card's check; a slower read of the
  other accounts during a hold; leaving an unfinished account out of the
  round.
- Readings where the plan left a detail open. "Changed" compares a
  watched account's entry before the round with its entry after it, in
  `landed`, `balance` and `held`. An account with no entry before the
  round counts as not landed with nothing held, so an account that is
  still not on the ledger did not change. A watched account whose read
  fails in a round (no validator answered) goes from landed to not
  landed. That is a change by the plan's rule, so a full read follows,
  and one more when the account reads well again; until this build every
  round was a full read. The full read after a changed round is quiet,
  as the round is. When word was left, the word decides, also when the
  round changed something as well. The word is looked at last, after the
  moves: a `refresh` that arrives while the round reads the lost
  accounts' moves is not dropped either; the round has ended as a round
  ends by then, and the full read follows. A `refresh` that leaves word
  returns at once and does not wait for the read, as a `refresh` that
  finds another one running returns at once; no caller needs the read to
  be done when `refresh` returns. The round takes the session's account
  list once, at its start, as `refresh` does: the watched accounts, "not
  read in the round" and "an account is lost" all go by that list. An
  account that joins the session during a round has no entry, so the
  next round reads it; the pages' `load` and the account creation
  service also call `refresh` right after they set the list, which
  leaves word. Between a round and the full read that
  follows it, `busy` goes off and on again in one go, with nothing able
  to run in between, so the card's refresh button does not flicker.
  During that full read no round is running, so a `refresh` that arrives
  then returns, as during any full read. In the file `polling` and
  `fullAsked` stand after `readPod`, `poll()` after `refresh`, and
  `isWatched` and `entryChanged` under the class, before `stakesOf`.
- Put right on the user's word of 2026-11-11 ("Yes, update them"),
  after the first report of this build listed five comments as left
  because the plan names the service's class comment and the comment
  over each timer and no other. In `balances.service.ts` the one-line
  comments of three fields spoke of a refresh only: `busy` is true while
  a read runs, a refresh or a poll round; `readAt` is when the last
  read finished, a refresh or a poll round; `moves` are read by
  `refresh`, and by a poll round at its end, while an account is lost.
  The class comments of `home.page.ts` and `wallet.page.ts` said that
  the balances are read again every 5 seconds, and now say which
  accounts are, in the words of the comment over each timer. Comments
  only, no line of code.
- Spec: 8.2 (Home: the sentence on the 5-second read; Wallet: the
  sentence on when the balances are read, and the sentences after it),
  8.3 (the line of `balances.service`) and this note. README: nothing,
  it does not speak of this read. The older notes above stand as the
  record of what was built then.
- Checked. `npx ng build` in the web_app folder: clean, 2.13 MB initial
  (the script 2.12 MB), no warnings, and clean again with the five
  comments put right, the script the same file as before; `git status`
  showed this step's four files and no others. The cases of a round were
  run once outside
  the repo and nothing of it is kept: the service's file as it is,
  bundled with stand-ins for Angular and for the services it calls,
  against a made-up ledger, with no server. A round read only the
  account with a pending transfer, quietly, and set `readAt`. When that
  transfer was written, the round was followed by one quiet read of
  every account, the total was right and `needsPoll` went off. With one
  account only, a change was followed by no second read. A `refresh`
  during a round read nothing itself, and one full read followed the
  round, loud when one of the askers was loud and quiet when all were. A
  `refresh` during the moves at the round's end was followed by a full
  read too. A lost account was not opened or read in a round, and its
  moves were read at the round's end. An account not on the ledger was
  read alone, round after round, and every account once when it landed.
  A watched account whose read failed was followed by a full read, and
  by one more when it read well again. Another pod than the one last
  read made the round a full read. A round during a full read, and a
  `refresh` during a full read, read nothing. Not run in a
  browser here and no server was started: the run-through is the user's,
  after the deploy (the plan's section 3; only the wallet has something
  to deploy, wallet1 and then wallet2). With two or more accounts and an
  open escrow trade on one of them, the browser's network list on Home
  shows three or four calls to `/api/anos/<n>/` every 5 seconds, not
  three or four per account. Then a send from one own account to
  another: once it lands, the total on Home is right within two rounds.

### The proxy keeps its connections to the validators open (2026-11-11)

Built from `forclaude/wallet-speed-plan-1.md` (FINAL), its step 2 of
two, its section 2, one commit, on top of 5c23551. Why, in the user's
words of 2026-11-11: "I'm also trying to figure out why sometimes the
site starts moving soooo slow." And, of this cure: "What about keeping
connections open and the re read only if an account has something?"
Until now the proxy opened a new connection to a validator's doorman
for every call: http-proxy does that when it is given no agent, and it
sends `Connection: close`. Measured from the user's Mac that day,
straight to validator 1's doorman: opening the connection took about
100 ms, setting up the encryption 110 to 185 ms, and the call itself
110 to 170 ms. So opening and encryption were two of the three trips a
call made. Now a call to a validator goes out on a connection that is
open and waiting when there is one. The change is in the proxy only.
There is no route, no env variable, no npm package, no change in the
browser's code but for one comment (the point "Put right" below) and
no new word in either language, and nothing changes on the validators,
the doormen, the masterpod, the keyholders or the signing server.

- `server/config.js`: two numbers beside `proxyTimeoutMs`, each with
  its comment. `validatorIdleMs`, 10 000: how long a connection kept
  open to a validator's doorman may sit unused before the proxy closes
  it, and how long a new one may take to open. It has to stay under the
  doormen's own 15 seconds (`keepalive_timeout` in
  `doormansoftware/deploy/nginx/doorman.conf`, on both ports), so the
  proxy is always the first to close and no call meets a closing
  connection (the plan's decision 11). `validatorIdleConnections`, 32:
  how many unused connections, open and waiting for the next call, the
  proxy keeps per validator at most (decision 12). Neither is an env
  variable; they stand in the file as `proxyTimeoutMs` does.
- `server/app.js`: `http` and `https` are imported from Node.
  `createApp` makes two agents once, before the forwards, one of `http`
  and one of `https`, both with `keepAlive: true`,
  `timeout: config.validatorIdleMs` and
  `maxFreeSockets: config.validatorIdleConnections`. `forward` takes
  one more argument at the end, `agent`, `null` by default. When it is
  given, the proxy's options gain `agent` and
  `headers: { connection: 'keep-alive' }`. The validators' loop gives
  `forward` the agent that fits the entry's address: the `https` one
  when it begins with `https:`, else the `http` one. On the wallet
  servers every entry of `VALIDATOR_URLS` begins with `https:`; the
  development list is plain http. The comment at the top of the file
  and the comment of `forward` say what is kept open, why the header is
  set, and the two numbers.
- Why the header. nginx on a wallet server sends the proxy
  `Connection: close` with every call, by its default; the site sets
  only the Host header. http-proxy copies the incoming headers onto the
  outgoing call. So an agent alone would change nothing: the doorman
  would still be told to close after every call. With http-proxy's
  `headers` option the outgoing call says `keep-alive`. It is the one
  header that does not go through as received.
- The 32. A connection is unused while no call is on it: it is open
  and waiting for the next call. At most 32 such connections are kept
  per validator, in each wallet process; one more that becomes free is
  closed at once. The number is no limit on the calls under way. A call
  that finds no waiting connection opens a new one, as every call did
  until now, so with many people on at once nobody waits because of it:
  the calls beyond the waiting connections only miss the saving. With
  two wallet servers and three editions each, that is at most 192
  waiting connections on one doorman, and in practice far fewer.
- Unchanged: the masterpod's forward, the keyholders' loop and the two
  signing forwards, which give no agent, so those backends get a new
  connection for every call (decision 3). The text of the two signing
  forwards is as it was and they moved down, from lines 97 and 98 to
  lines 134 and 135; `forclaude/signing-server-plan-1.md`, which names
  them by the old numbers, finds them by their text, the two lines that
  begin `app.use(forward(config, config.signingServerUrl`.
  `proxyTimeoutMs`, the proxy's two minutes, still rules a call that is
  under way. `server/index.js`, the routes, everything under `deploy/`,
  and everything under `src/` but for one comment (the point "Put
  right" below).
- Accepted by the plan. Its decision 13, accepted and wanted: a
  validator whose machine cannot be reached now answers `502 validator
  n unavailable` after 10 seconds, to a read and to a submission, where
  the call hung for the proxy's two minutes. The browser already gives
  a read 10 seconds. Its decision 14: when a validator or its doorman
  restarts, each connection kept to it fails one call with that 502. A
  read is asked again on the next validator; a submission shows the
  failure and is never sent again by the wallet on its own (8.3). Out
  of the plan: the masterpod, the keyholders and the signing server on
  kept connections; the time each call took in the wallet's nginx log;
  a limit per visitor on the wallet servers.
- Readings where the plan left a detail open. `forward` gains its two
  options by one new last line in the options it hands to
  `createProxyMiddleware`, so no line it had changed. To reach the new
  last argument the validators' loop passes `''` and `null` for
  `replacement` and `method`, which are their defaults. The two agents
  are made from one set of options, after the proxy's own two routes
  and right before the masterpod's forward, with a short comment over
  them. An agent keeps its waiting connections per address, host and
  port, so every entry of `VALIDATOR_URLS` has its own 32. Seen in the
  check below: on a call to a validator the proxy's answer to nginx now
  carries the doorman's `Connection: keep-alive`, where it carried
  `close`, because http-proxy hands the backend's header on, and the
  proxy no longer closes nginx's connection itself after such a call.
  After a call to another backend it answers `close` and closes it, as
  before. nginx keeps no connections to the proxy (the site has no
  `upstream` block with `keepalive`) and closes each one when the
  answer is complete. A fine point of decision 13, not run here; it
  follows from the two limits. A machine that goes away without
  closing its connections, by a power or network cut, leaves the
  connections kept to it looking open for up to 10 seconds. A call
  sent down one of them in that time is a call under way and has the
  proxy's two minutes, as every call to such a machine had before this
  build. The connection goes with that call, and from then on a new
  one fails after 10 seconds.
- Put right on the user's word of 2026-11-11 ("Yes, update them"),
  after the first report of this build listed three places as left
  because the plan does not name them. In `src/app/constants.ts` the
  comment of `VALIDATOR_READ_TIMEOUT_MS` said that without the limit a
  validator whose machine cannot be reached would hold a page for the
  proxy's two minutes. It now says that a read could be held for the
  proxy's two minutes, and that since this build the proxy itself
  answers 502 after 10 seconds for such a validator. A comment only, no
  line of code. The other two places are beside the repos, in
  `test_net_phase_3_production/deploy-notes.md`: its section 6 said
  that step 2 was not built yet, and "The short of it" named 0cfb88c as
  the wallet's newest commit.
- Spec: 2 (Behaviour: the one exception to "Headers go through as
  received", and the new point on the connections) and this note.
  README, "The proxy (server/)": one sentence. The older notes above
  stand as the record of what was built then.
- Checked. `node --check server/app.js` and
  `node --check server/config.js` pass; `git status` showed this step's
  four files and no others, and `src/app/constants.ts` as the fifth
  once its comment was put right. `npx ng build` in the web_app folder
  after that: clean, no warnings, and the script is the same file as
  before, `main-M3NEN2FJ.js`. The proxy was also run once outside the
  repo, in memory, and nothing of it is kept: `server/app.js` as it is,
  with made-up addresses, and every connection, in and out, a pair of
  in-memory streams. No server was started and nothing went on the
  network. Each call came in the way nginx sends it, HTTP/1.1 with
  `Connection: close`. Five calls in a row to a validator made one
  connection, on an `https` address through the `https` agent and on an
  `http` address through the `http` agent, both with the two numbers.
  The far end was told `keep-alive` every time and got its own Host
  header, the browser's Origin and the cut path. A submission with a
  body went down the kept connection whole. Five calls in a row to the
  masterpod, to a keyholder and to the signing server made five
  connections each, told `close`, as before. Forty calls at once to one
  validator opened forty connections; 32 were kept and 8 closed at
  once; the next forty used the 32 and opened 8. A connection had the
  proxy's 120 seconds while a call was on it and the 10 seconds each
  time it became free. A waiting connection that reported its time up
  was closed, and the next call opened a new one. A waiting connection
  that the far end closed, or that was reset, cost no call. A
  connection dropped in the middle of a call, and one whose time ran
  out with a call on it, were `502 validator n unavailable` with the
  line in the log, and the next call was answered. After a validator
  call the proxy answered nginx `Connection: keep-alive` and left that
  connection open; after a masterpod call it answered `close` and
  closed it. The stand-in connections have no clock and no encryption.
  So three things were not run here: the 10 seconds themselves, a
  machine that cannot be reached, and TLS. The plan's own tries of
  2026-11-11, on the user's Mac against a stand-in backend, cover the
  first two: none of 120 calls failed with the proxy closing first, and
  a machine that cannot be reached answered 502 once the agent's number
  had passed. Not run on a server and nothing deployed: the
  run-through is the user's, after the deploy (the plan's section 3).
  Only the wallet has something to deploy, wallet1 and then wallet2;
  the step takes effect when the three units restart, which the
  install script does, and a wallet tab needs no reload. This line,
  from any machine, prints three times. Before this step the second
  and the third are about equal (0.5 to 0.65 seconds from the user's
  Mac on 2026-11-11). After it the third is clearly shorter:
  `curl -s -o /dev/null -o /dev/null -o /dev/null -w '%{time_total}\n' https://wallet.anocloud.com/api/health https://wallet.anocloud.com/api/anos/1/health https://wallet.anocloud.com/api/anos/1/health`

### The case chats, step 2 (2026-11-12)

Built from `forclaude/wallet-case-chats-plan-1.md` (FINAL, 2026-11-12),
its step 2 of seven, its section 2, one commit, on top of 30b50bc. Why,
in the user's words of 2026-11-11: "All of the cases that attestors do
need to have a 'start chat button'. This is because at the very least,
the attestor needs to be able to talk to the user about when to schedule
the meeting. This button should start a private chat with that person and
said chat should have a special name in the chat page so that the user
knows what it's for. There should also be a button on both the case from
the attestor's side and the user's side on the case page that can bring
them to this chat." The masterpod's part is the plan's step 1
(masterpodsoftware 68c35da, its spec's section 18): a private room can be
about an attestor case, `/list-chat-rooms` says so on every room and on
every invite, only an appointed attestor makes such a room, and it takes
only a person on that case or an appointed attestor. This step is the
wallet's part: the Start chat button on the three attestor case pages,
the chat block on the person's case page, the title of such a chat and
the wording of its request. No route, no env variable and no npm package;
the proxy (`server/`) is not touched.

- `src/app/services/masterpod-api.service.ts`: the type `CaseKind`;
  `caseId` and `caseKind` on `RoomItem` and on `InviteItem`; the fifth
  optional parameter `caseId` of `createChatRoom`. The two fields are
  typed `string | null` and `CaseKind | null`. A masterpod of before
  sends neither, and every reader compares the id with `===` or tests the
  kind for truth, so a missing field behaves as null.
- `src/app/services/chat.service.ts`: `title` puts the case's kind in
  words after the people of a private room about a case; `caseRoomWith`,
  `caseRoomsOf`, `caseInvitesOf`, `startCaseChat` and `inviteAgain`, as
  8.3 gives them.
- New, the two components of 8.7's last paragraph:
  `src/app/components/case-chat-start.component.ts`
  (`CaseChatStartComponent`) and
  `src/app/components/case-chat-list.component.ts`
  (`CaseChatListComponent`).
- The pages. `attesting-trade-case.page.ts` and
  `attesting-recovery-case.page.ts`: `<app-case-chat-start
  [caseId]="caseId()" [person]="d.profile" [open]="!final()" />` under
  the person's facts. `attesting-dispute-case.page.ts`: the same inside
  each party's block, with `party.profile`. `my-case.page.ts`: the
  heading `caseChat.title` and `<app-case-chat-list [caseId]="caseId()"
  />`, after the kind's own part and before the timeline.
  `chat-requests.page.ts`, `inviteText`: an invite with a `caseKind`
  reads `chatRequests.aboutCase[caseKind]`, and `chatRequests.toCaseChat`
  when `session.role()` is `attestor`; the rest as before. The chat list
  and the conversation page did not change: they take the title from
  `chat.title`.
- The words, in both files, as the plan's table gives them:
  `rooms.caseChat` and `chatRequests.aboutCase`, each a record by case
  kind; `chatRequests.toCaseChat`; and a new section `caseChat` (`start`,
  `notAccepted`, `declined`, `inviteAgain`, `title`, `wants`, `none`),
  after `caseStatus`. Reused as they are: `common.openChat`,
  `common.accept`, `common.decline`, `common.noChatKeysUnlock`,
  `common.podHasNoChatKeys`, `attesting.notAttestor`. The Thai is the
  plan's, by the glossary, for Thai readers to correct (8.8).
- Readings where the plan left a detail open. `caseRoomWith`: the
  masterpod does not count the chats of a case (the plan's decision 18),
  so there can be more than one room with the person; a room with the
  person a member then comes before one with the person invited, and
  "newest" goes by `createdAt`. Where the button sits: on all three
  pages the person's facts and the button are wrapped in one plain `div`
  inside the person's block, so the button is right under the facts,
  beside the selfie; no style of a page changed. Invite again is off
  while a call runs and without chat keys, as Start chat is, and the "No
  chat keys" line shows for either: the invite needs the room's key, and
  that needs the chat keys. A refusal other than `403 not an attestor`
  shows as `reasonOf` gives it, "HTTP 409: case closed", with no route
  before it, since the call that failed is one of two; a thrown error
  ("That anoPod has no chat keys (setup not complete)") shows in the same
  red line. Start chat does not open the conversation: once the room list
  is refreshed the button reads Open chat, with the "has not accepted"
  line. Accept in the person's block opens the conversation, as Accept on
  the Requests page does. A room whose invite failed after the room was
  made holds only the attestor, so it reads as the room of a person who
  declined, and Invite again brings the person in. In `inviteText` the
  case is tested before the listing; a room has one or the other, never
  both, by the masterpod's check. The component's `person` is typed
  `Pick<Profile, 'anopodId' | 'username'> | null`, and its three inputs
  are required. The paragraph for the two components is the last one of
  8.7, where the small components are listed.
- Known and left as it is. The room list comes from the shell's 5-second
  poll (8.2). On a case page opened before the first read after an
  unlock the list is not there yet, so Start chat shows even when a chat
  exists, and a second chat then stands (decision 18). The plan's
  decision 5 says the person sees the attestor's username, name and
  selfie: the block, the request and the chat show the username and the
  selfie (the avatar), and the first and last name are drawn nowhere in
  the chat pages; the plan's section 2 names no place for them. New
  chat's Message someone opens the private room that holds exactly the
  two people when there is one (8.2); a case chat is such a room, as a
  chat about a listing is.
- Put right on the user's word of 2026-11-12 ("Yes, update them"), after
  the first report of this build listed thirteen places as left because
  the plan does not name them. Nine comments in the code and no line of
  code: the comment of `createChatRoom` in `masterpod-api.service.ts`
  names `caseId` too; the class comment of `ChatService` and the comment
  of `title` in `chat.service.ts` name the chats about a case and the
  title of one; the comment of `inviteText` in `chat-requests.page.ts`
  gives the wording of a request about a case; the class comments of
  `attesting-trade-case.page.ts`, `attesting-recovery-case.page.ts`,
  `attesting-dispute-case.page.ts` and `my-case.page.ts` name the chat
  among what the page shows; the class comment of
  `src/app/components/avatar.component.ts` lists every place the avatar
  is drawn, where it had named the chat's four places only. Four places
  here: 8.6, the avatar in the person's chats about a case; the heading
  of 8.7, which said "The marketplace components"; the summaries of the
  four pages in 13.2; the first point of 13.6. Two of the places that 8.6
  and the avatar's comment now name are older than this step: the Vouch
  requests page and the DAO proposal page, both of 2026-11-08, which 8.2
  describes and 8.6 had never listed.
- Spec: 8.2 (Chat: the title of a room about a case; the Requests
  wording), 8.3 (`chat.service`, `masterpod-api.service`), 8.7 (the new
  last paragraph), 13.3 (the three attestor case pages; My case), this
  note. README: the lines of the two components, and a line for
  `chat.service.ts`, which had none.
- Checked. `npx ng build` in the web_app folder: clean, no warnings
  (2.14 MB initial). `git status` showed this step's thirteen files and
  no others, and `src/app/components/avatar.component.ts` as the
  fourteenth once its comment was put right. `npx ng build` after that:
  clean, no warnings, and the script is the same file as before,
  `main-BBMAXXTI.js`. Nothing was run in a browser and no server was
  started.
  Step 1 was not deployed when this was built, so nothing here was tried
  against a masterpod that knows a case chat. The run-through is the
  user's, on the running network (the plan's section 8): Start chat from
  the attestor edition on a trade case, a dispute case and a recovery
  case, the request on the person's side, Accept on the case page, the
  title in the chat list, Open chat on both case pages. The masterpod
  goes out first: against a masterpod of before, Start chat makes a plain
  private chat with no case on it, which no case page finds again.

### The recovery case on the Cases page, step 3 (2026-11-12)

Built from `forclaude/wallet-case-chats-plan-1.md` (FINAL, 2026-11-12),
its step 3 of seven, its section 3, one commit, on top of 98ffd03 (step
2). Why, in the user's words of 2026-11-11: "Right now, when the
attetestor opens a recovery case, a case doesn't show up for the user in
the cases section. So there's no way for the user to even go to the
meeting that the attestor scheduled." The recovery case the attestors
work on is a break-glass case (masterpod 14), keyed by the recovery
case's id. The masterpod has answered it to the person all along, with
`/list-my-break-glass-moves`: the status, the sign-offs, the moves and
the person's events, the `scheduled` one with the time and the meeting
link among them. Until this step the wallet read that answer only for
the line under a lost account's card (8.2, Wallet) and for the recovery
finish (12.3), and drew the video call nowhere. The masterpod's part is
the plan's step 1 (masterpodsoftware 68c35da, its spec's 14.4.2, 14.7
and section 18): `/schedule-break-glass-case` now writes the recovered
pod one notification, kind `recoveryCaseScheduled`, its reference the
case id. This step is the wallet's part: the recovery case as a third
kind of row on Cases, a case page of its own for the person, the
notification's link and label, and new words for the line the attestor
reads after scheduling. One new route. No env variable and no npm
package; the proxy (`server/`) is not touched.

- `src/app/pages/cases.page.ts`: `load()` reads
  `/list-my-break-glass-moves` beside `/list-my-cases`, and each case of
  it is a row of a third kind, `recovery`, sorted with the others by
  `createdAt`: the icon `lock_reset`, the title `cases.recovery` as a
  link to `/cases/recovery/<caseId>`, the line `cases.line(status,
  cases.accounts(moves), when)`, the case id under it. A refused read
  shows in the error line as `/list-my-break-glass-moves: <reason>` and
  the trade and dispute rows still show. The class comment names the
  third kind.
- New, `src/app/pages/my-recovery-case.page.ts` (`MyRecoveryCasePage`),
  as 13.3 gives it, and its route in `src/app/app.routes.ts`,
  `cases/recovery/:caseId`, in front of `cases/:caseId`, behind
  `sessionGuard`, title "My recovery case".
- `src/app/pages/notifications.page.ts`, `linkOf`: the kind
  `recoveryCaseScheduled` leads to `/cases/recovery/<referenceId>`. Its
  label comes from the dictionary like every other.
- `src/app/pages/attesting-recovery-case.page.ts` did not change: the
  line after Save is `recoveryCase.scheduled`, whose words changed.
- The words, in both files, as the plan's table gives them:
  `cases.subtitle` (changed), `cases.recovery` and `cases.accounts`; a
  new section `myRecoveryCase` (`title`, `notFound`, `statusOpen`,
  `statusInReview`, `statusDecided`, `signed`, `callAt`, `joinCall`,
  `noCall`, `accounts`, `moveLine`, `eventDecided`), after `myCase`;
  `notifications.labels.recoveryCaseScheduled`, the sixteenth label; and
  `recoveryCase.scheduled` (changed). Reused as they are: the words the
  plan lists, and `copy.copied` and `common.couldNotCopyId`, which the
  page's Copy uses as My case's does and the plan's list does not name.
  The Thai is the plan's, by the glossary, for Thai readers to correct
  (8.8).
- Where the code was not what the plan says it stands on. The plan names
  `balances.service` (`loadMoves`) as the only reader of
  `/list-my-break-glass-moves`. The recovery finish reads it too
  (`recover-case.page.ts`, Move your money, for the moves already
  filed). Nothing in this step depends on it. The plan's 3.6 names 8.1
  for the route, and 8.1 does not list the Cases routes: they are in the
  table of 13.2. So the route's line is in 13.2, with the sentence under
  the table now counting three Cases pages, and 8.1 got a short
  paragraph that says where the route sits in `app.routes.ts`.
- Readings where the plan left a detail open. On Cases the two reads run
  at the same time. A refused `/list-my-cases` still ends the read with
  its own line, as before, and then no row changes; the plan speaks only
  of a refused `/list-my-break-glass-moves`. The recovery row is a type
  of its own (`RecoveryRow`) and the template draws one list item or the
  other, so the type and the code of a trade or dispute row stayed as
  they were. The count in the row's line is the number of the case's
  moves: one move per old account. On the new page: the status of a
  dismissed case takes its reason as My case does (the dictionary's
  words; the word as the masterpod sent it when the dictionary has none;
  "another reason" without one). The line of the sign-offs is plain
  text under the status, and it and the video call go by one test: the
  case is open or in review. Join the video call is a link drawn as a
  flat button, with `target="_blank"` and `rel="noopener"` like the
  timeline's meeting link, and shows when the newest `scheduled` event
  carries a `meetLink` (the masterpod always writes one); an event
  without a time reads "a time to be confirmed". Your accounts makes no
  read of its own: the new account's name comes from the session's
  accounts as they stand (Home and the Wallet page read the list), else
  the short id shows. `moveLine` is one sentence per language, and only
  the new account is the link, so the page builds the sentence with the
  new account's full id in the account's place and cuts it there; the
  link then stands wherever a language puts the account. A kind the
  dictionary does not know shows the type word. A refused read leaves
  what the page shows. The page keeps its own copy code, as the other
  case pages do (8.5). In `app.routes.ts` the new route has a one-line
  comment of its own. The README's line for the page sits under the
  `pages/` lines of the layout.
- Known and left as it is. The page shows a case only once the person's
  finish has filed a move: until then there is no break-glass case. Only
  the video call notifies; a decision and a dismissal show on the page
  (the plan's decision 20). A second schedule writes a second
  notification and a second timeline line, and the Video call part shows
  the newest. The Cases page reads when it opens and by Refresh, as
  before; the new page also reads every 15 seconds. A lost account's
  card has no link to this page (the plan's decision 29). The chat block
  has what step 2's note says of it: the room list comes from the
  shell's 5-second poll.
- Put right on the user's word of 2026-11-12 ("Yes, update them"), after
  the first report of this build listed fifteen places as left because
  the plan does not name them. Nine comments in the code and no line of
  code: the comment of `load()` in `cases.page.ts` names both reads; the
  class comment of `notifications.page.ts` and the comment of `linkOf`
  name the kind `recoveryCaseScheduled` and where it leads; in
  `masterpod-api.service.ts` the comment of `scheduleBreakGlassCase`
  names the notification, where it had said that none is sent, and the
  comment of `listMyBreakGlassMoves` names every reader of the answer;
  the comment above `routes` in `app.routes.ts` counts three Cases
  pages; the comment of `CASES_POLL_MS` in `constants.ts` names every
  page that refreshes on it; the class comments of
  `src/app/components/case-chat-list.component.ts` and
  `src/app/components/avatar.component.ts` name My recovery case beside
  My case. Five places here: 8.6 and 8.7, My recovery case beside My
  case; 13.1, the recovery case among what Cases shows; the line of the
  notifications page in 13.4; the last point of 13.6, which had listed a
  notification to the person as not built. One line of the README, that
  of `case-chat-list.component.ts`. Two things these comments now name
  are older than this step: the recovery finish as a reader of
  `/list-my-break-glass-moves` (`recover-case.page.ts`), and the
  attestors' Recovery case page of 2026-11-08 as the third attestor case
  page that refreshes on `CASES_POLL_MS`, where the comment had counted
  two.
- Spec: 8.1 (where the route sits), 8.2 (Notifications: the kind), 13.2
  (the route's line; three Cases pages), 13.3 (Cases: the third kind of
  row; My recovery case; the attestor's line after scheduling), this
  note. README: the line of the new page.
- Checked. `npx ng build` in the web_app folder: clean, no warnings
  (2.15 MB initial). Every string of the plan's table was compared with
  the two dictionary files. `git status` showed this step's eight files
  and no others, and twelve once the comments were put right: the four
  that joined are `src/app/services/masterpod-api.service.ts`,
  `src/app/constants.ts`,
  `src/app/components/case-chat-list.component.ts` and
  `src/app/components/avatar.component.ts`. `npx ng build` after that:
  clean, no warnings, and the script is the same file as before,
  `main-RWGW6332.js`. Nothing was run in a browser and no server was
  started.
  Step 1 was not deployed when this was built, so the notification was
  not tried against a masterpod that writes it. The run-through is the
  user's, on the running network (the plan's section 8): after a
  recovery's Move your money, the row on Cases; an attestor schedules
  the call from the Recovery case page and reads the new line; the
  person's notification opens the recovery case page; the time and Join
  the video call; an attestor's Start chat shows under Chat with the
  attestor; the accounts; the timeline.

### The contact phone and the two counts, step 4 (2026-11-12)

Built from `forclaude/wallet-case-chats-plan-1.md` (FINAL, 2026-11-12),
its step 4 of seven, its section 4, one commit, on top of 1a844e5 (step
3). Two things. The contact phone, in the user's words of 2026-11-11:
"The user should however be able to give a phone number as well as the
email. Probably an either / or. And the moderator should be able to see
both the email and phone number provided. This is because people in
thailand don't use email too much." And the wait page of a recovery (the
plan's decision 10): it shows both kinds of shares coming in, the key
the bankers keep and the account keys, and the finish opens only when
both are complete. Until this step the page counted the backup code's
shares alone. The bankers send the rows they tick in their GUI, so the
two kinds of shares can arrive at different times, and a finish started
before an account's key was in moved the other accounts and left that
account's money behind without a word. The masterpod's part is the
plan's step 1 (masterpodsoftware 68c35da, its spec's 12.4.2, 12.4.3,
12.4.4 and section 18): `/open-recovery-case` takes `contactEmail` and
`contactPhone`, each optional, and wants at least one of the two; the
three reads `/get-recovery-pod`, `/list-recovery-cases` and
`/get-recovery-case` answer `contactPhone` beside `contactEmail`, each a
string or null; and `/get-recovery-pod` answers `anosAccounts`, how many
anos accounts the recovered pod has, in every status. This step is the
wallet's part: the phone box of the locked-out stepper, the phone on the
moderator's case page, and the status line and the finish of My
recovery. No route, no env variable and no npm package; the proxy
(`server/`) is not touched.

- `src/app/pages/recover-open.page.ts`: step 2 has the line
  `recoverOpen.contactText` above the boxes and a second box under the
  email's, `recoverOpen.contactPhone`, `type="tel"`,
  `autocomplete="tel"`, with the hint `recoverOpen.phoneHint`; a signal
  `phone`; `isContactPhone(value)` beside `isContactEmail`, the
  masterpod's check (6 to 32 characters, each a digit, a space, `+`, `-`
  or a round bracket, with at least 6 digits); `whoDone` is true when at
  least one box is filled in and every box that is filled in is valid;
  `open()` puts `contactEmail` into the payload only when an email is
  given and `contactPhone` only when a phone is given, both trimmed, and
  keeps both in `RecoveryService`. The class comment says so.
- `src/app/services/recovery.service.ts`: `RecoveryPodAnswer` has
  `contactEmail: string | null`, `contactPhone?: string | null` and
  `anosAccounts?: number`; a signal `contactPhone` beside
  `contactEmail`, set by `applyPod` and emptied by `close()`, which is
  the one place that empties `contactEmail`.
  `src/app/services/masterpod-api.service.ts`: `RecoveryCaseItem` and
  the `case` of `RecoveryCaseAnswer` have `contactEmail: string | null`
  and `contactPhone?: string | null`. No method changed.
- `src/app/pages/recover-case.page.ts`: `statusText` gives `statusOpen`
  the contact, which is the email and the phone that are there, joined
  by a comma and a space, or `recoverCase.yourEmail` when neither is.
  Two computeds beside `backupShares`: `accountKeysComplete`, how many
  key ids of share type `breakglasskey` have at least the threshold of
  shares, and `accountKeysExpected`, the pod's `anosAccounts`, undefined
  when the masterpod sent none. While the case is delivering, with
  `accountKeysExpected` a number above 0, the line is
  `recoverCase.statusDeliveringBoth` with the backup code's count, the
  threshold, the complete account keys (never shown above the expected
  number) and the expected number; otherwise
  `recoverCase.statusDelivering`, as before. `showFinish` is true once
  the finish has started in the tab, as before, or when the case takes
  it and both are in: the backup code has the threshold of shares, and
  `accountKeysComplete` is at least `accountKeysExpected`; with that
  undefined the backup code alone decides, as before. One sentence of
  the class comment, "When three shares of one backup code keyId are in,
  the finish appears", is put right: the threshold of both. Combine and
  the five steps of the finish did not change.
- `src/app/pages/moderation-case.page.ts`: among the person's facts the
  Email row shows when the case has an email, and a new row under it,
  `common.phone`, shows the phone number with a copy button
  (`moderationCase.copyPhone`, `copy('phone', …)`) when the case has
  one.
- The words, in both files, as the plan's table gives them:
  `recoverOpen.contactText`, `recoverOpen.contactPhone` and
  `recoverOpen.phoneHint`; `recoverCase.yourEmail`, changed to "the
  contact you gave" where it said "your email";
  `recoverCase.statusDeliveringBoth`, which takes four numbers;
  `common.phone`; `moderationCase.copyPhone`. `recoverCase.statusOpen`
  keeps its words; what it is given changed. Reused as they are:
  `recoverOpen.contactEmail`, `recoverOpen.emailHint`, `common.email`,
  `moderationCase.copyEmail`, `copy.copied`. The Thai is the plan's, by
  the glossary, for Thai readers to correct (8.8).
- Readings where the plan left a detail open. On the locked-out
  stepper: the phone box sits in a `.fields` block of its own under the
  email's block, so it stands under the email box on every screen,
  where one block would put the two side by side on a wide one. No
  style changed, and the phone's field has `subscriptSizing="dynamic"`
  like the email's, so its hint pushes the buttons down (the two notes
  of 2026-11-10 on this page, above). A box is filled in when something
  is left after the spaces around it are dropped. `isContactPhone` is
  the masterpod's check as it stands there: it measures `value.length`
  and takes the digits 0 to 9 only, so a number typed in Thai digits is
  not valid in the box, as the masterpod would refuse it. It runs on
  the trimmed value, which is what is sent; the masterpod does not
  trim. A contact that is not given is left out of the payload: it is
  not sent as null, and not as an empty string, which the masterpod
  refuses as not valid. `RecoveryService` keeps null for the one not
  given, as the masterpod answers it, and `applyPod` reads a missing
  `contactPhone` as null. On My recovery: the two computeds stand after
  `threshold`, which the first one reads. The backup code's count is
  shown as it comes, also above the threshold ("5 of 4"), as before;
  only the account keys are capped, as the plan says. With
  `anosAccounts` 0 the line is the one of before, by the plan's "a
  number above 0", and the finish goes by the backup code alone, since
  no account key is waited for. On the moderator's case page the two
  rows are drawn through `@if (…; as email)` and `@if (…; as phone)`,
  so a null, a missing field and an empty string all draw no row. In
  the dictionaries `contactText` stands in front of `contactEmail`,
  `contactPhone` and `phoneHint` after `emailHint`,
  `statusDeliveringBoth` after `statusDelivering`, `copyPhone` after
  `copyEmail` and `common.phone` after `common.email`. The comments and
  this spec carry 2026-11-12, the day of the build; the masterpod's
  carry 2026-11-11, the day of the design.
- Known and left as it is. A break-glass key whose account was never
  finished counts as an account key, so in that rare case the finish
  can open one key early (the plan's 4.3): the deposit comes before the
  account's row on the masterpod (8.2, Wallet), and a deposit that
  stopped under its floor can still have left the threshold of shares
  with the keyholders. The other way round, the finish stays closed for
  as long as one account's key has fewer than the threshold of shares:
  the bankers have to send every row, and the page offers no way past a
  key that never comes (the plan's decision 10). The counts move with
  the 15-second poll and with Refresh, as before; nothing tells the
  page that a share arrived. Against a masterpod of before (the plan's
  section 8): a recovery opened with a phone number alone is refused,
  shown as `/open-recovery-case: HTTP 400: bad request shape`; one
  opened with both keeps the email and loses the phone without a word;
  and the wait page works as before, since no `anosAccounts` comes. The
  card on `/recover` still says "You'll need your birth record and an
  email where a moderator can reach you" (`recover.lockedOutText`): the
  plan does not change that word. The parameter of
  `recoverCase.statusOpen` is still named `email` in both dictionary
  files, and the key `recoverCase.yourEmail` keeps its name.
- Spec: 12.3 (Locked out: step 2, and the payload in step 3; My
  recovery: the contact in the Open line, the Delivering line with its
  two counts, when the finish shows; Case: the Phone row), 12.4
  (`recovery.service`), this note. The README names none of these pages
  by itself and did not change.
- Checked. `npx ng build` in the web_app folder: clean, no warnings
  (2.16 MB initial total, `main-UA677LVQ.js`). Every string of the
  plan's table was compared with the two dictionary files. `git status`
  showed this step's eight files and no others. Nothing was run in a
  browser and no server was started.
  Step 1 was not deployed when this was built, so nothing here was
  tried against a masterpod that takes a phone or answers
  `anosAccounts`. The run-through is the user's, on the running network
  (the plan's section 8): a recovery opened with a phone number alone,
  seen by a moderator; the wait page while the bankers send the two
  kinds of shares one after the other, where both counts move and the
  finish opens only when both are complete. The masterpod goes out
  first.

### The stake box, the guardian thousands and the red cancel buttons, step 5 (2026-11-12)

Built from `forclaude/wallet-case-chats-plan-1.md` (FINAL, 2026-11-12),
its step 5 of seven, its section 5, one commit, on top of d8a2de8 (step
4). Three small things from the user's list of 2026-11-11, found while
testing. The stake box (the plan's decisions 11, 12, 22 and 23): the box
of a DAO stake and of a guardian stake says what the stake gives and how
long it is locked, and the person types their username before its button
works. The words about the lock are the user's: "just do what I said and
tell the user that it will be locked for a month / year since your last
vote." The guardian thousands (decision 13), in the user's words: "Just
for guardians, it should only be in the thousands, and only for
guardians." And the red cancel buttons (decisions 14 and 24): the three
cancel buttons and the "Yes, cancel" of each. Wallet only: this step
needs nothing from the masterpod's step 1. No route, no env variable
and no npm package; the validators, the doormen, the keyholders and the
proxy (`server/`) are not touched.

- `src/app/components/confirm-dialog.component.ts`: `ConfirmData` has
  two more fields, each optional. `typed?: { label: string; expected:
  string }`: under the notes the template draws one `mat-form-field`
  (outline) with the label `typed.label` and an `input matInput` with
  `autocomplete="off"` and `autocapitalize="none"`, bound to the signal
  `typedText`. The computed `typedOk` is true in a box without `typed`,
  and in a box with it once `typedText()` equals `typed.expected`, both
  through `trim().toLowerCase()`. The second button is off while
  `!armed() || !typedOk()`. `danger?: boolean`: the second button has
  `[class.danger]="data.danger"`. The component imports `FormsModule`,
  `MatFormFieldModule` and `MatInputModule` beside the two it had.
  `askConfirm` is untouched. The comments of `ConfirmData` and the class
  comment say so. The Wallet page's box gives neither field and is as it
  was.
- `src/app/pages/account.page.ts`, the stake box. In `askSend()`,
  `stakeBox` holds the title and the first note of an order whose
  purpose is `daoVote` (`account.confirmStakeDaoTitle(anos)`,
  `account.stakeDaoNote`) or `guardian`
  (`account.confirmStakeGuardianTitle(anos)`,
  `account.stakeGuardianNote`), and is null for every other order. With
  it the box has that title; the three lines, as before; the notes
  `stakeBox.note`, `account.confirmStakeNote` and
  `account.stakeTypeNote`, in this order; `typed`, the label
  `common.yourUsername` and the expected text `session.username()`; and
  `confirmLabel` `account.stake`. Without it the title, the notes and
  the button are those of 2026-11-10 and `typed` is undefined: the box
  of the other four purposes and of every transfer is the box of
  before. What comes after the box did not change: `resetForm()`, then
  `send(order)`. The comment of `askSend` says so.
- `src/app/constants.ts` and `src/app/pages/account.page.ts`, the
  guardian thousands. `GUARDIAN_STAKE_STEP_ANOS = 1000`, with the
  comment that it is the validators' `GUARDIAN_VOTE_ANOS`. `canSend`
  takes the amount in millionths once and answers false when the
  transfer type is `transferToFund`, the purpose is `guardian` and the
  amount is not a whole multiple of `BigInt(GUARDIAN_STAKE_STEP_ANOS) *
  MILLIONTHS_PER_ANOS`, which is 1,000,000,000 millionths; the rest of
  it does what it did. In the template, right under the form:
  the muted line `account.guardianThousands` while `transferType()` is
  `transferToFund` and `stakePurpose()` is `guardian`. No other purpose
  is touched.
- The red buttons. `src/styles.css`: the rule `.danger`, the plan's five
  lines as they stand there, at the end of the file, under a comment
  that names the plan. `src/app/pages/account.page.ts`: `class="danger"`
  on the stroked "Cancel transfer" under the Locked transfer row, and
  `askCancelLocked()` gives `danger: true`, so "Yes, cancel the
  transfer" in the box is red. `src/app/pages/assisted-transfer.page.ts`:
  `class="danger"` on the stroked "Cancel transfer" and on the filled
  "Yes, cancel the transfer". `src/app/pages/escrow-trade.page.ts`:
  `class="danger"` on the filled "Cancel trade"; the confirm button of
  the question has `[class.danger]="action === 'cancel'"`, so "Yes,
  cancel the trade" is red and the Yes of Release and of Dispute keep
  their colour. No page's own styles changed.
- The words, in both files, as the plan's table 5.5 gives them, all
  eight new: `account.confirmStakeDaoTitle(anos)`,
  `account.confirmStakeGuardianTitle(anos)`, `account.stakeDaoNote`,
  `account.stakeGuardianNote`, `account.stakeTypeNote`, `account.stake`,
  `account.guardianThousands` and `common.yourUsername`. Reused as they
  are: `account.confirmSendTitle`, `account.confirmStakeNote`,
  `account.stakeFor`, `account.stakePurposes`, `common.kind`,
  `common.from`, `common.to`, `common.send` and `common.cancel`; and the
  words on the cancel buttons, `assisted.cancelTransfer`,
  `assisted.yesCancel`, `escrow.cancelTrade` and `escrow.yes`. The Thai
  is the plan's, by the glossary, for Thai readers to correct (8.8).
- Readings where the plan left a detail open. The text box is as wide
  as the box and stands 12 px under the last note, the distance the
  notes keep (`.typed { width: 100%; margin-top: 12px; }`), and its
  field has `subscriptSizing="dynamic"`, so no empty row for a hint
  stands between it and the buttons. It stands in no `form` and has no
  key handler, and that is all "the Enter key answers nothing" needs.
  `askConfirm` still opens the box with the focus on the box itself, so
  the text box does not take the focus by itself: a tap or a click puts
  the cursor in it. What is typed lives in a signal of the box and goes
  nowhere. The expected text is `session.username()`, the username the
  masterpod answered at the unlock or at Create: an open session always
  has one, and the page is behind the session guard. The stake box goes
  by the order's purpose, which is what the box shows. The amount in
  the two titles is `millionthsToAnos(amount)`, as in "Send 100 anos?":
  "Stake 1000 anos as a guardian?", with no comma. The page's own button
  still reads "Send transferToFund": the plan gives Stake to the box's
  title and button (decision 23), not to the form. In the code
  `GUARDIAN_STAKE_STEP_ANOS` is a plain number, as the plan writes it,
  and stands last in `constants.ts`, after `MILLIONTHS_PER_ANOS`;
  `canSend` turns it into millionths. In `canSend` the new line stands
  in front of the old last line. It reads `transferType()` as well as
  `stakePurpose()`, since Stake for keeps its pick while Kind is plain
  or escrow. "At least one step" needs no line of its own:
  `anosToMillionths` answers null for zero, and the smallest whole
  multiple above zero is one step. The muted line has the same
  condition as that check and stands in front of the progress bar's
  block; the two never show together, since the form is empty while a
  send is on its way. In the dictionaries `guardianThousands` stands
  after `amountPlaceholder`, the two titles after `confirmSendTitle`,
  the two notes in front of `confirmStakeNote`, `stakeTypeNote` and
  `stake` after it, and `common.yourUsername` after `common.username`:
  the order the page uses them. The comments and this spec carry
  2026-11-12, the day of the build.
- Known and left as it is. The month and the year in the two notes are
  words only (the plan's decision 11): nothing in the wallet and no
  rule of the validators holds a stake for a time; a stake comes back
  by a fund proposal, and section 10 still lists the stake withdrawal
  lock as not built. The whole thousands are the wallet's rule and
  stand in this form alone. The validators take any guardian stake of
  at least `STAKE_MIN_GUARDIAN_ANOS` (anossoftware
  `src/fund/fund.service.js`, `verifyTransferToFund`) and count one
  vote per full `GUARDIAN_VOTE_ANOS`, rounded down, so a stake of 1,500
  anos sent another way (a wallet tab loaded before the deploy is one)
  stands, with one vote. The step is a number in the wallet and is
  not read from the validators: if `GUARDIAN_VOTE_ANOS` changes,
  `GUARDIAN_STAKE_STEP_ANOS` has to follow by hand. The Guardians page
  still says "To become a guardian, stake 1000 anos or more for
  guardian from a spending account, on its page in the Wallet."
  (`guardians.noGuardianAccount`): that is true, but it does not say
  whole thousands, and the plan does not change that word. The username
  in the box is a brake on a careless click, not a secret: the toolbar
  shows it. A red outlined button keeps the theme's primary colour for
  the faint tint under the pointer and at a press: Material draws those
  from its state-layer and ripple variables, which the plan's rule does
  not set. The class `danger` already stood on four buttons, each a
  filled "Confirm dismissal": on the moderator's case page and on the
  three attestor case pages (12.3, 13.3), each with a rule of its own
  in the page's styles, which sets `background` and `color` to the same
  two error colours. The plan does not name them and nothing in those
  four pages changed. The global rule reaches them all the same: they
  carry the five variables now. As read in the built files, nothing on
  them looks different. The page's rule and Material's two rules for a
  filled button, the one for a button that can be pressed and the one
  for a button that is off, weigh the same, a class and one more simple
  selector each. The page's styles come into the document after
  Material's button styles, since a Material button is on screen before
  any of these pages opens, and the shell keeps one, Lock, for as long
  as the session is open. So the page's rule still decides both
  colours, and they are the colours the variables would give. One
  difference stays between those four and the buttons of this step: a
  "Confirm dismissal" that is off while its page is busy stays red, as
  before, and a button of this step that is off has the theme's
  disabled look.
- Put right on the user's word of 2026-11-12 ("Yes, update them"), after
  the first report of this build listed three comments as left because
  the plan does not name them. Three comments and no line of code. In
  `src/app/pages/account.page.ts`: the class comment, whose Send part
  now names the whole thousands of a guardian stake and the box of a
  stake for daoVote or guardian, where it had known only the box of
  2026-11-10; and the comment of `resetForm()`, which names Stake
  beside Send as the button that runs it. In `src/app/constants.ts`:
  the comment of `CONFIRM_ARM_MS`, which names the four words the box's
  own button can carry, Send, Stake, Create anos account and "Yes,
  cancel the transfer", where it had named two; the last of the four
  had been missing since 2026-11-11. No file joined the commit: both
  files were this step's already. Not counted and not changed, since
  nothing in them is wrong: the class comments of the assisted transfer
  page and of the escrow trade page and the comment of
  `askCancelLocked()` name the cancel buttons and say nothing of how a
  button looks.
- Spec: 8.2 (Account: the Send paragraph in two places, the guardian
  thousands after the Stake for list and the stake box after the box of
  a send; the cancel of the locked transfer in two places, the red
  button and the red "Yes, cancel the transfer"; Escrow trade and
  Assisted transfer: the red buttons), 8.9 (the list of fields; a new
  paragraph on `typed`, `danger` and the class; who gives which, in the
  last paragraph) and this note. README: the line of
  `components/confirm-dialog.component.ts` names the username to type
  and the red button.
- Checked. `npx ng build` in the web_app folder: clean, no warnings
  (2.16 MB initial total, `main-UXDUZIQQ.js`, `styles-EMD3RG3N.css`).
  The words: the eight rows of the plan's table 5.5 were read from the
  plan file and compared with the sixteen entries in `en.ts` and
  `th.ts`, and each entry equals its cell character for character.
  `git status` showed this step's ten files and no others. `npx ng
  build` after the three comments were put right: clean, no warnings,
  and the script and the style file are the same files as before; the
  ten files are the same ten. Read in the
  built files: the style file holds the rule `.danger` with its five
  lines; Material's button styles read those five variables only in
  the rules for a button that is not disabled, and its rules for a
  disabled button read variables of their own, so a disabled red button
  keeps the theme's disabled look; the app sets no namespace for CSS
  variables, so the names in the global rule are the names Material
  reads. Nothing was run in a browser and no server was started. The
  run-through is the user's, on the running network (the plan's section
  8): a DAO stake and a guardian stake, with the box, the username and
  1,500 anos refused for guardian; and the three cancel buttons. The
  wallet goes out by section 10 of `forclaude/wallet-deploy-plan-1.md`,
  wallet1 and then wallet2, with no setting in `network/wallet.env` and
  no `npm ci`.

### The badges and the attestor in the marketplace chat, step 6 (2026-11-12)

Built from `forclaude/wallet-case-chats-plan-1.md` (FINAL, 2026-11-12),
its step 6 of seven, its section 6, one commit, on top of 0cabe91 (step
5). Two things. The badges (the plan's decisions 15 and 25): the
Attesting and the Moderation entries of the menu show a number when
there is something new on the page, as Chat does, and it clears when the
page is opened. And the attestor in the marketplace chat (decisions 9,
26 and 27): either trader of a marketplace chat can bring an attestor on
the trade's dispute into that chat, where the attestor reads everything.
The entry "Invite an attestor" shows only while the chat's trade is in
dispute and an attestor has opened a case on it, in the user's words of
2026-11-12: "this button should only appear is there is a dispute and an
attestor has opened a case." And no other chat with the attestor is
needed first; the user asked, "Does it have to be that you can only
invite an attestor if that attestor has a different chat with you?", and
it does not. The masterpod's part is the plan's step 1
(masterpodsoftware 68c35da, its spec's section 18): a member of a
listing chat who did not start it may invite an appointed attestor and
nobody else, and a dispute case names its attestors to its two traders
(`attestors` on `/list-my-cases` and `/get-my-case`). No route, no env
variable and no npm package; the proxy (`server/`) is not touched.

- New, `src/app/services/work-badge.service.ts` (`WorkBadgeService`,
  provided in root), as 8.3 gives it: the signals `attestingIds`,
  `moderationIds` and `seen`, the computeds `attestingCount` and
  `moderationCount`, the timer of `CASES_POLL_MS` with one read as soon
  as a session with setup complete is there, `seeAttesting(ids)` and
  `seeModeration(ids)`. `seen` is `{ attesting, moderation }` in
  localStorage under `anopod-wallet.work-seen.<anopodId>`, read and
  written inside try/catch as session.service keeps the seen chat
  positions, each list cut to its newest 500 ids. The file also exports
  the rule as two functions: `attestingWorkIds(trades, disputes,
  recoveries)` and `openCaseIds(cases)`.
- `src/app/services/navigation.service.ts`: the Moderation entry has
  `badge: workBadge.moderationCount()`, the Attesting entry `badge:
  workBadge.attestingCount()`; the comment of `NavItem` names the two.
  The side panel (`app.html`) and the Home tiles already draw an
  entry's `badge` when it is not 0, so neither changed.
- `src/app/pages/attesting.page.ts`, `load()`: after a load that read
  everything, `workBadge.seeAttesting(attestingWorkIds(attesting.trades(),
  attesting.disputes(), recoveries.body.cases))`.
  `src/app/pages/moderation.page.ts`, `load()`: after a good read,
  `workBadge.seeModeration(openCaseIds(res.body.cases))`.
- `src/app/services/chat.service.ts`: `isTrader(room)`,
  `otherTrader(room)` and `caseAttestors(caseId)`, as 8.3 gives them.
- `src/app/components/pinned-listing.component.ts`: `other` is
  `chat.otherTrader(room)`; `theirAccountIds` takes the ids the other
  trader posted, and the ids anyone else posted only when no other
  trader is found. `findDisputeCase(room, trade)`, called at the end of
  a check that found the chat's trade open, and `tellDisputeCase(caseId)`
  behind the new output `disputeCase` (8.7). A check that read
  everything and found no open trade tells null, and so does `reset()`
  when the card is given another room.
- `src/app/pages/chat-room.page.ts`: the card is drawn when
  `chat.isTrader(room)`, with `(disputeCase)="setDisputeCase($event)"`;
  the signal `disputeCaseId`, emptied in `open(room)` when the room
  changes; the menu entry "Invite an attestor", shown when
  `chat.isTrader(room)` and `disputeCaseId()` is not null;
  `toggleAttestors()`, `inviteAttestor(attestor)`, the computed
  `attestors` and the panel, as 8.2 (Chat, the attestor in a marketplace
  chat) gives them. The thread, the composer and "Invite someone" are
  untouched.
- `src/app/services/masterpod-api.service.ts`: `MyDisputeCase` has
  `attestors?: RoomMember[]`. A masterpod of before sends none, and the
  page reads a missing list as an empty one.
- `src/app/pages/chat-requests.page.ts`, `inviteText`: an invite with a
  listing whose owner is not this pod reads `chatRequests.toListingChat`
  with the listing's words; the owner's wording stays.
- `src/app/pages/attesting-dispute-case.page.ts`: the muted line
  `disputeCase.marketChatHint` right under the parties, in front of the
  line with the status. `src/app/pages/my-case.page.ts`: on a dispute,
  the muted line `myCase.marketChatHint` right under the chat block.
- The words, in both files, as the plan's table 6.4 gives them, all six
  new: `chatRoom.inviteAttestor`, `chatRoom.attestorReads`,
  `chatRoom.attestorsIn`, `chatRequests.toListingChat(words)`,
  `disputeCase.marketChatHint` and `myCase.marketChatHint`. Reused as it
  is: `chatRoom.invite`. The Thai is the plan's, by the glossary, for
  Thai readers to correct (8.8).
- Readings where the plan left a detail open, the badges. The Attesting
  ids have two parts, so that a read that fails leaves its own part as
  it was: the transactions come from `attesting.trades()` and
  `attesting.disputes()`, which attesting.service leaves as they were
  when its read fails, and the recovery cases are kept in the badge
  service (`recoveryIds`). `seeAttesting(ids)` takes one list, as the
  plan writes it, and keeps as recovery cases the ids that are no
  transaction of the two lists. The rule stands once, in
  `attestingWorkIds` and `openCaseIds`, and the two pages and the timer
  all use it, which is how "by the same rule" is kept. The ids handed
  over join the seen list as its newest, an id seen before included, so
  a thing that is still on the page is never among the ones the cut to
  500 drops; when the list would not change nothing is set and nothing
  is written, so the Attesting page's 15-second poll does not write to
  localStorage every time. No read starts while another runs
  (`reading`), as the shell's poll does it, and a read that ends after
  the pod changed writes nothing. One effect follows
  `session.anopodId()`: for every new pod and when the session closes it
  empties the two id lists and reads `seen` for the pod, or empties it.
  Another effect makes the first read, for every pod that opens, once
  the pod is set and `setupComplete()` is true. "The address" is
  `router.url`. Every
  read is quiet in the log. The timer's read picks the attestor's staked
  account as the Attesting page does, through `loadAccounts`, so it is
  picked at the unlock and no longer at the first visit of the page. On
  the Attesting page the things are seen whatever the status filter
  shows. On the Moderation page they are the cases of the filter's read
  that are open or in review: with a filter that leaves both statuses
  out the page hands over no id, the number is 0 while the page is open,
  and the timer reads the cases again once the page is left. What is
  read back from localStorage is checked: only the strings of a list
  count, and anything that is no list reads as empty.
- Readings where the plan left a detail open, the chat. The room's
  creator is never the listing's owner: the masterpod refuses a room
  about one's own listing (`400 your own listing`), so "the other of the
  two" is always another pod. `caseAttestors` goes by the rooms this pod
  is in, not by its invites: an attestor whose chat request the person
  has not accepted yet is not in it, and the masterpod's `attestors`
  names that attestor all the same. The card tells the page a case only
  when it is another than the one it last told, so the page's own
  emptying is not undone by the next check five seconds later; it tells
  nothing once the card is gone (`DestroyRef.destroyed`), since a check
  can end after the chat was left. The card looks for the case after
  the chat's message about the trade is posted, so that message is not
  held up. While the trade is in dispute and no open case is found, the
  card asks `/list-my-cases` at every check, every 5 seconds, as the
  escrow trade page does on its refresh; that is how the entry appears
  by itself once an attestor opens the case. The menu entry stands
  after "Invite someone", has the icon `fact_check`, the icon of the
  Attesting entry, and is off while the page is busy. A second click
  closes the panel, as the other two entries do with theirs. The panel
  uses the classes of the members panel, a column of rows, and the
  avatar has its default size, 40 px; no style was added. The list is a
  computed over the room and the session's rooms, so an attestor leaves
  it as soon as the room list shows them invited. A refused
  `/list-my-cases` at the opening shows in the page's error line as
  `reasonOf` gives it and the panel stays closed; an answer that comes
  after the card told another case is dropped. Invite refreshes the
  room list after a refusal too, so `409 invite already open` and `409
  already a member` take the attestor off the list. The panel stays
  open after an invite, for the second attestor of the case, and closes
  when the card tells that there is no case any more. In the
  dictionaries `inviteAttestor` stands after `inviteSomeone`, the two
  panel lines after `invite`, `toListingChat` after `aboutListing`,
  `disputeCase.marketChatHint` after `disputedTheEscrow` and
  `myCase.marketChatHint` after `supplyAgain`: the order the pages use
  them. The comments and this spec carry 2026-11-12, the day of the
  build.
- Known and left as it is. A case found stays until the trade is no
  longer in dispute, as the plan says. So when the page finds that case
  decided or dismissed and takes the entry away, and an attestor then
  opens a new case on the same trade, which can happen after a
  dismissal, the entry comes back only when the chat is opened again:
  the card still holds the closed case and does not look again. The
  chat's trade is still matched on every account id named in the chat,
  whoever posted it, a guest included: the plan changes the form's To
  list and nothing in the check. The request of an attestor who is
  brought into a marketplace chat carries a listing, so
  marketplace.service's `waitingCount` counts it, and until the
  attestor answers, Browse shows them the row "Your listings" with one
  person waiting; the same held before for anyone the room's creator
  invited with "Invite someone". With an attestor in it the chat is a
  group for all three: the row in the chat list has the group icon, and
  the thread shows the senders' names. The two hint lines show on a
  closed case too, where the entry is gone. The numbers are per device,
  as the Chat number is: a new phone counts every open thing until the
  page is opened once. They do not move while an attestor or a
  moderator is on a case page, since no read is made under `/attesting`
  or `/moderation`. In the attestor and the moderator edition the read
  runs for every pod with setup complete, also one that holds no such
  appointment; the refusals are quiet. Against a masterpod of before
  step 1 the entry still shows, since `/list-my-cases` is older, but
  the panel lists nobody and reads "The attestors on this case are
  already in this chat.": that masterpod names no attestor on a dispute
  and marks no room with a case, so `caseAttestors` finds none either,
  and an invite by the trader who did not start the chat would be
  refused, `403 only the creator invites`. The plan's section 8 says
  the list then holds an attestor who has a chat with the person; it
  holds nobody. The masterpod goes out first, so nobody should see it.
- Put right on the user's word of 2026-11-12 ("Yes, update them"), after
  the first report of this build listed fifteen places as left because
  the plan does not name them. Nine comments in the code and no line of
  code. In `src/app/pages/chat-room.page.ts`: the class comment, which
  names "Invite an attestor" in the menu and says that the pinned card
  is for the room's two traders, where it had named three menu entries
  and a card for every private room about a listing. In
  `src/app/components/pinned-listing.component.ts`: the class comment,
  which says who gets the card, speaks of the other trader and has a
  last paragraph on the dispute case and the output; the comment of
  `theirAccountIds`, which now carries the rule in full, so the line
  comment this build had put inside the computed is gone; the comment
  of `openForm`, "the other trader"; and the comment of `check()`,
  which names the look for the dispute case. In
  `src/app/pages/chat-requests.page.ts`: the comment of `inviteText`,
  with the two wordings of a request about a listing. In
  `src/app/services/chat.service.ts`: the class comment, which names
  the two traders of a marketplace chat and the attestors of a case. In
  `src/app/constants.ts`: the comment of `CASES_POLL_MS`, which names
  the badge service among those that read on it. In
  `src/app/components/avatar.component.ts`: the class comment, which
  lists the "Invite an attestor" panel among the places the avatar is
  drawn. Six places here: 8.2, Home, the tiles of Moderation and
  Attesting with their numbers; 8.3, the line of `navigation.service`;
  8.6, the avatar in the "Invite an attestor" panel; 12.1 and 13.1,
  where "What the edition changes" ended on "Nothing else" and now
  names the read every 15 seconds; and the first point of 13.6, which
  names the marketplace chat among the ways an attestor and a party
  talk. Two files joined the commit, `src/app/constants.ts` and
  `src/app/components/avatar.component.ts`: seventeen files, sixteen
  changed and one new. Not counted and not changed, since nothing in
  them is wrong: the class comments of `NavigationService`, of the
  shell (`src/app/app.ts`), of the Attesting page, the Moderation page,
  the dispute case page and My case, the comments of the two `load()`
  functions, and the README line of `chat.service.ts`. Older than this
  step, so not counted either: `README.md` says "nothing touches
  browser storage", while the seen chat positions (2026-11-05) and the
  marketplace filters (2026-11-06) are in localStorage already, and the
  seen ids of this step join them.
- Spec: 8.1 (a new paragraph after the one on the Chat and the
  Notifications numbers), 8.2 (Chat: Invite an attestor in the menu of
  One conversation; who gets the pinned card, in its first sentence; a
  new paragraph "The attestor in a marketplace chat" in front of
  Requests; the Requests wording), 8.3 (a new line for
  `work-badge.service`; the line of `chat.service`), 8.7 (the pinned
  card: the selector with its output, the other trader, the dispute
  case), 12.3 (Moderation), 13.3 (Attesting, a new paragraph after the
  Recoveries tab; Dispute case, the parties; My case, the chat block)
  and this note. README: a line for `services/work-badge.service.ts`.
- Checked. `npx ng build` in the web_app folder: clean, no warnings
  (2.17 MB initial total, `main-6HDLIIBE.js`; the style file is the one
  of step 5, `styles-EMD3RG3N.css`). The words: the six rows of the
  plan's table 6.4 were read from the plan file and compared with the
  twelve entries in `en.ts` and `th.ts`, and each entry equals its cell
  character for character. `git status` showed this step's fifteen
  files and no others, fourteen changed and one new. `npx ng build`
  after the fifteen places were put right: clean, no warnings, and the
  script and the style file are the same files as before; `git status`
  showed the seventeen files and no others. Nothing was run in a
  browser and no server was started. Step 1 was not deployed when this was built, so nothing
  here was tried against a masterpod that names the attestors of a
  dispute or lets the second trader invite. The run-through is the
  user's, on the running network (the plan's section 8): a new case
  while another page is open, and the number on Attesting and on
  Moderation; and a dispute on a marketplace trade, with no "Invite an
  attestor" in the chat's menu before the dispute and before an
  attestor opens the case, then the entry, used by the trader who did
  not start the chat, and the attestor reading the chat. The masterpod
  goes out first; then the wallet, by section 10 of
  `forclaude/wallet-deploy-plan-1.md`, wallet1 and then wallet2, with
  no setting in `network/wallet.env` and no `npm ci`.

### Both contacts, and the account count as of the case's opening (2026-11-12)

Two changes the user decided on 2026-11-12, after
`forclaude/wallet-case-chats-plan-1.md` was final and its seven steps
were committed. Built the same day in one chat from that chat's brief,
on top of e2fed6b (step 6), the working tree clean: one commit here and
one in the masterpod (its spec's 12.1, 12.3, 12.4.2, 12.4.3 and 18).
Both change what step 4 built. Its note above, "The contact phone and
the two counts, step 4", stays as it was written: it says what was
built then. No route, no env variable and no npm package; the proxy
(`server/`) is not touched.

Both contacts. Step 4 let a person who opens a recovery give an email
address or a phone number, at least one of the two (the plan's decision
8). The user, 2026-11-12: "And a phone and not just an email would be
great. Thai people, for example, would great prefer text. However, both
should be required, in case text isn't available." So a person gives
both: a moderator texts first, and the email is there when a text is
not possible. This takes the place of decision 8. The rule lives in two
places: the masterpod's `/open-recovery-case`, which refuses a payload
without one of the two with
`400 contactEmail and contactPhone required`, and this form.

- `src/app/pages/recover-open.page.ts`: `whoDone` is true when both
  boxes are filled in and both are valid. It is `isContactEmail` of the
  trimmed email and `isContactPhone` of the trimmed phone, and an empty
  box is not valid by either. `open()` puts `contactEmail` and
  `contactPhone` into the payload, both, always. The class comment and
  the comment of `whoDone` say so.
- The words, in both dictionary files. `recoverOpen.contactText`, the
  line above the two boxes: "Give an email address and a phone number.
  Both are needed. A moderator will text you first, and will email you
  if a text is not possible." in place of "Give an email address, a
  phone number, or both. A moderator uses them to reach you."; in Thai
  "ให้อีเมลและหมายเลขโทรศัพท์ ต้องใช้ทั้งสองอย่าง
  ผู้ดูแลจะส่งข้อความถึงคุณก่อน และจะส่งอีเมลถึงคุณหากส่งข้อความไม่ได้".
  `recover.lockedOutText`, the card on `/recover`, its second sentence:
  "You'll need your birth record, and an email and a phone number where
  a moderator can reach you." in place of "You'll need your birth
  record and an email where a moderator can reach you."; in Thai
  "คุณจะต้องใช้บันทึกการเกิดของคุณ
  รวมทั้งอีเมลและหมายเลขโทรศัพท์ที่ผู้ดูแลติดต่อคุณได้". The Thai is the
  build chat's, by the glossary, for Thai readers to correct (8.8); a
  text is "ข้อความ", the glossary's word for a message. No key is new
  and none went.
- Readings where the brief left a detail open. The two hints,
  `recoverOpen.emailHint` and `recoverOpen.phoneHint`, keep their words:
  neither says that one contact is enough. In `open()` the two lines
  that keep the contacts in `RecoveryService` still read `contactEmail
  || null` and `contactPhone || null`; neither is empty there now, so
  the `|| null` does nothing, and the lines were left as they are.
  `open()` has no check of its own for a missing contact, as before:
  the linear stepper does not reach step 3 while step 2 is not done,
  and a contact that went out empty all the same is refused by the
  masterpod as not valid.
- Not changed, because they show what the case has: My recovery (the
  contact in the Open line) and the moderator's case page (the Email
  and the Phone row). A case of before may hold one contact, so both
  still take a case with one. No sentence on either page says "or".
  `RecoveryService` and the types of the three reads did not change
  either: the masterpod still answers each contact as a string or null,
  and its table still takes a case with one (its `db/schema.sql` is not
  touched).

The account count. `anosAccounts` on `/get-recovery-pod` was every anos
account the anoPod has (the plan's decision 21 with its 1.7 and 4.3: a
mistake in the plan, not in the builds). The finish's step Move your
money makes a new account for each old account that holds anos, so the
number went up in the middle of the finish, while the bankers' shares
in the case are for the old accounts only. On My recovery the
Delivering line turned to, for instance, "2 of 4 account keys are
complete". And after a reload between the first new account and Done
the finish did not come back: `showFinish` wants `accountKeysComplete`
to reach `accountKeysExpected`, and `finishActive` is lost with the
page. The fix is the masterpod's alone, which the planning chat called
fix 1: it counts only the accounts made up to the case's opening, an
`anos_accounts` row whose `created_at` is not after the case's. The
user, 2026-11-12: "I feel like fix 1 is safe to do, we don't need to
worry about side effects because it's just changing a read." Nothing
else on the wire changed, and no code changed here.

- The two sentences that said the number is every anos account the
  anoPod has: the comment of `accountKeysExpected`
  (`src/app/pages/recover-case.page.ts`) and the comment of
  `anosAccounts` on `RecoveryPodAnswer`
  (`src/app/services/recovery.service.ts`). The page's class comment
  says only "as many as the masterpod's anosAccounts says" and stays.

For both:

- Spec: 12.3 (Recover: the card's words; Locked out: step 2, and the
  payload in step 3; My recovery: the contact in the Open line and what
  the number in the Delivering line is; Case: the remark on the Phone
  row) and this note. 12.4 did not change. The README names none of
  this and did not change.
- Deploying. The masterpod goes out first, as before. One thing is new:
  a wallet of before step 4 sends the email alone, and the masterpod
  with this change refuses that. The page then shows
  `/open-recovery-case: HTTP 400: contactEmail and contactPhone required`.
  So between the masterpod's deploy and this wallet's nobody opens a
  recovery case. The plan's section 8 said a
  wallet of before breaks nothing against the new masterpod; for this
  route that no longer holds. The other way round is fine: against a
  masterpod of before step 1 this wallet's payload is taken, the email
  kept and the phone dropped without a word, and against the masterpod
  of step 1 (68c35da) it is taken whole.
- Checked. `npx ng build` in the web_app folder: clean, no warnings
  (2.17 MB initial total, `main-5FOPGDH2.js`; the style file is the one
  of step 5, `styles-EMD3RG3N.css`). `git status` showed this step's
  six files and no others. Nothing was run in a browser and no server
  was started, so the form was not seen, and nothing here was tried
  against a masterpod. The run-through is the user's, on the running
  network: a recovery opened with both contacts, seen by a moderator;
  Next staying grey with one box empty; and a recovery that moves
  money, where the Delivering line keeps its second number through the
  finish and the finish comes back after a reload.

### Pictures: always redrawn, no PDFs, the wallet's own list of types (2026-11-12)

No plan file: asked for and decided in chat on 2026-11-12, after a look
at how a file that only pretends to be a picture could reach a server or
a phone. Three changes here; the masterpod's two of the same day (no PDFs
as evidence, the selfie check) are in the masterpod spec, section 11.

- A new file, `src/app/images.ts`, with three things.
  `IMAGE_CONTENT_TYPES`: `image/jpeg`, `image/png`, `image/webp`, the
  wallet's own list. `imageObjectUrl(bytes, contentType)`: an object URL
  for the bytes, or null when the type is not on the list.
  `redrawImage(file, limit, jpeg)`: the file decoded with
  `createImageBitmap(file, { imageOrientation: 'from-image' })`, drawn
  onto a canvas filled white, the longer side scaled down to `limit` when
  it is longer and never scaled up, encoded with
  `toBlob('image/jpeg', jpeg)`; null when the browser cannot decode the
  file, when the canvas gives no context, or when `toBlob` answers null.
  The bitmap is closed and the canvas set to 0 by 0 in a `finally`, which
  hands its memory back at once.
- Why the wallet keeps its own list. A decrypted file was turned into an
  object URL with the type the masterpod named, and shown with a link
  that opens it in a new tab. A Blob opens as what its type says, and the
  page it opens as has the wallet's own address: bytes named `text/html`
  ran there as a page of the wallet (seen here, under Checked). The
  masterpod and its database let in only the listed types, so this
  needed a masterpod that was broken into; the wallet no longer leans on
  that. The five places: `openFiles` in `pages/my-case.page.ts`,
  `openRow` in `pages/attesting-dispute-case.page.ts`, and `openRows` in
  `pages/moderation-case.page.ts`, `pages/attesting-recovery-case.page.ts`
  and `pages/attesting-trade-case.page.ts`. A file of another type: on
  the two case pages it gets no URL, so the lock shows, with the type in
  the line under it; in the three bucket views it is left out, and not
  counted as "under other keys".
- Left as they are: the nine places that show a selfie as
  `data:<contentType>;base64,...` in an `<img>` (the avatar component,
  `attesting.page.ts` and seven templates). An `<img>` runs nothing,
  whatever the type says, and a `data:` URL is not opened in a tab.
- The camera component (8.4): `fileChosen` calls `redrawImage` with the
  quality's width and factor for every chosen file. Its own `shrink` is
  gone. Before, a file no larger than the limit, and a file the browser
  could not decode, went out unchanged with the file's own type; now the
  first is redrawn at its own size and the second is refused: a new
  signal `fileError` holds `camera.unreadable`, shown as a line under the
  file input, and nothing is emitted, so a photo taken before stays.
  `emit` clears the line. `takePhoto` is unchanged. Every photo the
  component emits is now `image/jpeg`.
- My case (13.3): the picker's `accept` and `CONTENT_TYPES` lost
  `application/pdf`. `upload` redraws each file with
  `redrawImage(file, 4096, 0.92)` (`EVIDENCE_SIDE`, `EVIDENCE_JPEG`),
  sends it as `image/jpeg`, and checks the 10 MB limit on the redrawn
  picture. 4096 is the largest canvas every phone's browser draws, so a
  picture keeps its size up to there; a very tall scroll screenshot gets
  smaller. A file the browser cannot read stops the upload with
  `myCase.unreadable` before anything is posted. The PDF link, the
  `isPdf` field and the `.pdf` style left this page and the attestor's
  dispute page.
- Words, `en.ts` and `th.ts`: `camera.unreadable` and
  `myCase.unreadable` are new; `myCase.evidenceText` and `myCase.badType`
  lost the PDF. The Thai is unchecked.
- What the redraw is for: what goes out is pixels only, so whatever else
  a file carried stays behind, the place a photo was taken for one, and
  an honest person does not pass on a bad file somebody sent them. It
  does not stop someone who skips the wallet and posts to the masterpod
  directly; for the selfie the masterpod checks that itself, and the
  encrypted pictures it cannot check.
- Comments brought in line on the user's word ("Yes, update them"): the
  camera's class comment and `fileChosen`'s, and in `my-case.page.ts` the
  comment of `CONTENT_TYPES`, the class comment and `upload`'s.
- Spec: 8.4, 13.3 (the attestor's dispute page and My case) and this
  note. The dated notes of earlier builds that name the PDF link and the
  small file that went out unchanged stay as the record of those builds.
  No constant in `constants.ts`, no proxy change, no package. The README
  names none of this and did not change.
- Deploying: no order with the masterpod. A wallet of before that sends
  a PDF to a masterpod with the change gets `400 invalid contentType`;
  this wallet sends JPEGs, which a masterpod of before takes.
- Checked. `npx ng build` into a scratch folder: clean, no warnings
  (2.17 MB initial total, `main-OS5S5P4L.js`, `styles-EMD3RG3N.css`).
  Then in a development build served from a scratch folder, in the
  Browser pane, with a made-up session and the page's three masterpod
  calls answered in the browser: no server, no passkey. On the create
  page, through the real file input: a see-through PNG of 300 by 200
  went out as a JPEG of the same size on white; a JPEG of 3000 by 2000
  as 1280 by 853; a small JPEG with a note in its header and bytes after
  its end went out without either; a web page named `photo.jpg` was not
  emitted, the line showed, and a photo held before stayed. On My case:
  a PNG screenshot of 1290 by 2796, a JPEG of 6000 by 4500 and the small
  JPEG were posted as `image/jpeg`, 1290 by 2796, 4096 by 3072 and 200 by
  100, and the attestors' copy opened to the same bytes; a web page named
  `.jpg` beside a good file posted nothing; a PDF was refused with the
  words of `badType`. Rows the stand-in masterpod named `text/html` and
  `application/pdf` showed the lock and no link. The same bytes in a Blob
  of type `text/html`, as the page built it before, ran their script
  under the wallet's address; under a picture type they opened as a
  picture and ran nothing. Not seen on a phone and not run against a
  masterpod; the attestor's dispute page and the three bucket views were
  built and not opened. The pane blocks the camera, so the live camera
  was not tried; `takePhoto` did not change.

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
Moderator wallet; and, since 2026-11-12 (section 11), the wallet reads
the recovery cases that are open or in review every 15 seconds, for the
number on the Moderation entry (8.1; work-badge.service, 8.3). Nothing
else. A moderator's pod is an ordinary pod
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
record, and an email and a phone number where a moderator can reach you.
A moderator will meet you on a video call and check your security
buckets before anything is released." (the phone number in it since
2026-11-12, section 11; until then "your birth record and an email").
Button: Start, to `/recover/open`. "Continue
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
   `lookupId` with `identityIdsOf`, drops the public ledger id, then,
   under the progress bar ("Finding your account…"), finds the account
   (since 2026-11-08): `SharesService.findOwner` asks every keyholder
   `/get-owner` at once (section 6), and the first `200` names the anoPod
   id; `/challenge` (openCase, that id) answers the pod's username (this
   challenge is never used: it is too short-lived to carry to step 3, and
   the masterpod sweeps it with the expired ones). Found, the answers are
   dropped and the stepper moves on. Not found, the page stays on step 1
   with the answers in the form, so one field can be fixed and Next
   pressed again: "No account was set up with this birth record. Check
   each field against your birth certificate and try again." No keyholder
   answered: "The keyholders could not be reached. Try again in a moment."
   A masterpod refusal shows as `/challenge: <reason>`. Once found, with
   the form empty, a line says the account was found and the answers
   dropped, and that filling the form in again starts over.
2. Your account: "We found your account: alice", then "Give an email
   address and a phone number. Both are needed. A moderator will text you
   first, and will email you if a text is not possible." and two boxes,
   the second under the first: Contact email, and Phone number with the
   hint "With the country code, for example +66 81 234 5678." (the line
   and the phone box since 2026-11-12, section 11; until then the email
   alone, and it had to be given). Both are required, by the last note
   of 2026-11-12 in section 11: as step 4 built it that day, one of the
   two was enough and the line read "Give an email address, a phone
   number, or both. A moderator uses them to reach you." Next works once
   both boxes are filled in and both are valid as the masterpod takes
   them (masterpod 12.4.2): an email of 3 to 254
   characters with an `@` that is not first; a phone of 6 to 32
   characters, each a digit, a space, `+`, `-` or a round bracket, with
   at least 6 digits. The spaces around either are dropped first; a box
   with nothing else in it counts as empty. Nobody types a username;
   there is no username path.
3. Open my case: one button. `/challenge` (openCase, the anoPod id) gives
   a fresh challenge and the username; the passkey registration with the
   PRF extension, that id as user handle and the username as name and
   display name; the PRF output from the registration or, when it
   returned none, one local assertion with a random challenge; `KEK_prf`;
   the recovery hybrid pair and `hybridKeyBlob`; the ephemeral keys;
   `/open-recovery-case`, the payload without a username, with
   `contactEmail` and `contactPhone`, both, each as typed less the spaces
   around it (the last note of 2026-11-12 in section 11; as step 4 built
   it that day each went only when it was given, and before that
   `contactEmail` always and no phone). On 201 the recovery
   session is open, both contacts are kept in `RecoveryService` (12.4)
   and the page goes to `/recover/case`. The
   refusals shown: "a case is already open for this identity" (409), a
   masterpod refusal as `/challenge: <reason>` or `/open-recovery-case:
   <reason>`, the passkey messages as on Create.

**My recovery** (`/recover/case`). The case id (short, with Copy), the
status in words ("Open: a moderator will contact you at <contact> and
meet you on a video call", "In review", "Approved: the bankers are
sending your keys", the Delivering line below, "Completed",
"Dismissed: <reason in words>"), the timeline from the events the person
may see (scheduled with the meeting link as a link, approved, dismissed,
recovered, completed), a Refresh button (`/get-recovery-pod`; also polled
every 15 s while the page is open). "Keep this device: you unlock this case
with the passkey you just made."

The contact in the Open line (2026-11-12, section 11; until then the
email) is the email and the phone the case has, joined by a comma and a
space, "alice@example.com, +66 81 234 5678". A case opened since both
are required has both; a case of before may have one of the two, and
the line then shows that one. When the page knows neither, which is the
moment between
Continue a recovery and the first `/get-recovery-pod` answer, it says
"the contact you gave" (until 2026-11-12 "your email").

The Delivering line counts both kinds of shares (2026-11-12, section 11;
decision 10 of `forclaude/wallet-case-chats-plan-1.md`): "Delivering:
the key the bankers keep has 2 of 4 shares. 1 of 3 account keys are
complete." The first pair is the backup code: the largest group of
`backupcode` shares of one `keyId`, and `shareThreshold` from
`/api/config`. The second pair is the account keys. Each anos account
has a break-glass key of its own, deposited as `breakglasskey` under a
`keyId` of its own when the account is made (section 6; 8.2, Wallet),
so an account key is complete when one `breakglasskey` `keyId` has at
least `shareThreshold` shares, and the number to wait for is
`anosAccounts` of the `/get-recovery-pod` answer: the anos accounts the
anoPod made up to the opening of the case, sent in every status of the
case (masterpod 12.4.3 and 18). The new accounts that Move your money
makes are newer than the case and are not in the number, so it stays
the same through the finish (the last note of 2026-11-12 in section 11;
as the masterpod first built it that day the number was every anos
account the anoPod has, and it went up in the middle of the finish).
The count of complete keys is never shown above that
number. When `anosAccounts` is 0, or is missing because the masterpod is
one of before, the line is the one of before, the backup code's count
alone: "Delivering: 2 of 4 key shares received".

The finish appears as a second stepper on the same page when the case
takes it (approved or delivering) and both are in: the backup code has
`shareThreshold` shares of one `keyId`, and at least as many account
keys are complete as `anosAccounts` says. Until 2026-11-12 the backup
code's shares alone decided, and they still do when the masterpod sends
no `anosAccounts`. Why both: the bankers send the rows they tick in
their GUI, so the two kinds of shares can arrive at different times, and
Move your money moves the accounts whose key came back and says nothing
of an account whose key did not, whose money then stays behind. Once
Combine has run in the tab the finish stays. Known and left as it is: a
break-glass key whose account was never finished counts as an account
key, so in that rare case the finish can open one key early.

The person never sees a backup code,
here or on Setup (2026-11-10, section 11): on these screens it is "the
key the bankers keep", "the rebuilt key" or "the key". The steps stand in
this order since 2026-11-10 (`forclaude/recovery-finish-order-plan-1.md`,
section 11): Combine, Get back in, Move your money, New key for the
bankers, Done. Until then the new key was third and the money fourth, and
a reload after the new key had landed shut the person out of the money
step: Get back in opens the masterpod's blob2 with the old key, which
fails once the masterpod holds the new one, so the anos stayed in the old
accounts until a new recovery case. Move your money needs nothing from
the new key.

1. Combine: opens every share with the recovery hybrid private key, groups
   by `keyId`, combines each group of three; the backup code and the
   break-glass seeds are in RAM. Shows "key rebuilt" and "n break-glass
   seeds recovered".
2. Get back in: `KEK_backup` and the backup code keys from the code;
   `blob2` from the last `/get-recovery-pod` answer (masterpod 12.4.3 hands
   it over once the case is approved) opened with `KEK_backup` gives the
   encryption key; `newBlob1` = the encryption key under `KEK_prf`;
   `/challenge` (recover); the payload `{ challenge, caseId, newBlob1 }`
   signed with the backup code keys; `/recover-with-backup-code`. Then the
   ordinary unlock (`/challenge` unlock, the assertion, `/unlock`), which
   opens the normal session in this tab with the same passkey: `blob1`,
   the chat keys, the identity blob, the status.
3. Move your money (2026-11-08, `forclaude/break-glass-plan-1.md` step 5,
   section 11; in place of the "Break-glass keys" step that stood third
   from 2026-10-26, which matched each recovered seed to its account and
   stored it there with `/store-break-glass-blob`, and left with step 4 of
   that plan; it stood fourth, after the new key, until 2026-11-10): "Your
   old accounts' keys are gone with the lost passkey. For each account
   that holds anos the wallet opens a new account of the same type and
   files a move signed by its break-glass key. Two attestors check you and
   sign; a guarded or vault account's move also waits out its lock." The
   button Move my money runs, in this order since 2026-11-10 (the read of
   a held move and the filing of each move by itself are that day's,
   section 11): (1) `/list-anos-accounts` into the session; each
   recovered seed's two break-glass public keys find the account whose
   `creation.payload.publicKeys` names them, and a seed that matches none
   is unmatched; (2) an account whose move `/list-my-break-glass-moves`
   already lists is filed and skipped; (3) the reads, every one before
   any write: every other matched account is read with
   `/get-assisted-transfer` and `/get-account` (5.4), both signed by its
   break-glass pair (the validators accept it since the user keys are
   gone, anossoftware 22). A held transfer whose `type` is
   `breakGlassTransfer` is a move to file, with the held transfer's
   `transactionId` and `accountIdTo`: an earlier run posted it and its
   filing never reached the masterpod. Else a balance of 0 is empty and
   skipped. Else the account is one to move, with its balance and its
   latest transaction id. An account the validators do not know never
   reached the ledger, so it holds nothing: when its first read is
   refused with `401` and a reason saying `unknown account` (the test
   `balances.service` uses for an account that has not landed), it is
   empty too, its second read is not made, and the next account is read.
   Every other refused read stops the step; (4) each move to file is
   filed, and no new account is made for its old account; (5) for
   each account to move, a new account of the same type through
   `account-creation.service` (8.3), waited for on the ledger, then the
   `breakGlassTransfer` of the whole balance into it, chained on the
   latest transaction id read, dated now plus the type's minutes ahead
   (guarded and vault the lock plus the offset by the proxy's numbers,
   else 0), signed by the break-glass pair alone and posted to
   `/anos-transfer`, no signing server. When the validator refuses the
   post or gives no answer, `/get-assisted-transfer` is read again with
   the break-glass pair: a `breakGlassTransfer` there is the move, with
   the validator's `transactionId` and `accountIdTo`; anything else stops
   the step with "The validator refused the move out of <account>:
   <reason>", the reason being the post's. Then the move is filed, before
   the next account is touched; (6) the seeds wiped and dropped from
   `RecoveryService`. Filing a move is `/file-break-glass-moves` with the
   case id and that one move, a call per move, made as soon as the move
   is on the validators: an ok answer or a `409 move already filed`
   counts as filed, anything else stops the step as
   `/file-break-glass-moves: <reason>`. So a step that stops half way has
   filed every move it posted, and the 20 moves one call may carry are no
   limit. A validator's "already there" by itself does not count as
   filed: an old account with a transaction of its own still waiting on
   the validators (a guarded or vault transfer in its lock, an open
   escrow trade, an assisted transfer) stops the step with the
   validator's words, and the step can be run again in the same case once
   that transaction is done. Until 2026-11-10 the moves of a run went to
   the masterpod in one call after the last account, so anything that
   stopped the step before that call lost them; on Retry the validator's
   refusal of a second move for the account then counted as filed with
   nothing filed, after another new account had been made. The result:
   "2 moves filed, 1 account was empty, 0 seeds matched no account", or
   "No break-glass seeds were recovered, so there is nothing to move."
   The step is complete when the run ended without an error, even with
   nothing to move; Retry runs it again and skips what is filed. This is
   the one place in the wallet that uses a break-glass key: no card,
   account page or Account entry offers one. The old accounts' key blobs
   do not open under the new passkey's key blob key (section 7), so the
   wallet shows them as lost, with the move's progress (8.2).
4. New key for the bankers (until 2026-11-10 "New backup code", which
   showed the new code once as on Setup and waited for "I have written it
   down, complete"; it stood third, before the money, until 2026-11-10):
   one button, "Make the new key". It makes a new code without showing
   it, with `newBlob2` and the new backup code keys, when none is held
   yet. Then, the keyholders first since 2026-11-10 (section 11): the
   page checks that the old key is still in the tab, before anything is
   deposited, since the masterpod call needs it for the proof ("The
   rebuilt key is not in this tab: combine and get back in first."); the
   deposit as `backupcode` through `SharesService.deposit`, a new
   `keyId`, made once; then `/rotate-backup-code` with `newBlob2`, the
   new keys and the proof by the old keys. When that call is refused or
   gets no answer, the page reads the case again (`/get-recovery-pod`,
   quietly, an ok answer kept as the poll keeps one): if the blob2 the
   masterpod holds is the new one, the rotation landed and the step is
   done; otherwise the refusal shows as `/rotate-backup-code: <reason>`.
   The button reads "Make the new key" at first, "Retry the deposit"
   after a failed deposit (it deposits the same new key again under a
   fresh key id) and "Retry" when only the masterpod call is left (it
   repeats that call alone). "The old key is now worthless." Until
   2026-11-10 the masterpod was told first and the deposit came second,
   and between the two the new key lived only in the tab: a tab closed
   there, or a lost answer of the masterpod (Retry then signed with the
   old key and got `401 bad signature`), left an anoPod whose shares
   rebuild the old key, which opens nothing and which the masterpod
   refuses, and the wallet could not mend it later. Setup already
   deposits first (8.2).
5. Done: `/complete-recovery-case`; "You're back in." Continue to
   `/wallet`.

Each step keeps its result in RAM and can be retried; a refresh of the
page loses the combined code and the seeds, and the person starts the
finish again from Combine after unlocking the recovery pod (Move your
money then skips the moves already filed, and files a move the
validators hold that was not filed yet, without a second new account).

**Moderation** (`/moderation`). The cases from `/list-recovery-cases`, a
status filter (the four open statuses by default, plus completed and
dismissed), each row: username, names, status, approvals, opened. A row
opens `/moderation/:caseId`. Since 2026-11-12 (section 11) a good read
hands the ids of the cases it read that are open or in review to
work-badge.service (8.3, `seeModeration`): they are what the number on
the Moderation entry counts (8.1), and this device has seen them all
then, so the number clears when the page is opened.

**Case** (`/moderation/:caseId`), from `/get-recovery-case`, refreshed by a
button and every 15 s

- The person: public selfie, username, names, the Email row with Copy
  when the case has an email, the Phone row under it with Copy when the
  case has a phone (2026-11-12, section 11; a case opened since both are
  required has both, a case of before has at least one of the two, and
  until then the Email row always showed), the lookup id with Copy, the
  status.
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
                            builds the recovery envelope (caseId as the signer); everything in RAM; the contact
                            email and the contact phone are two signals, each a string or null (the phone since
                            2026-11-12), set by the locked-out stepper at the open and by every /get-recovery-pod
                            answer (applyPod), emptied by close(); RecoveryPodAnswer carries contactPhone and
                            anosAccounts, both optional, since a masterpod of before sends neither
    masterpod-api.service   one method per new route (masterpod 12.4); challenge() takes the three new purposes,
                            openCase with the anoPod id the keyholders named, and answers its username
                            (2026-11-08); listAnosAccounts items carry breakGlassBlob;
                            listMyBreakGlassMoves and fileBreakGlassMoves (masterpod 14.4.1, 2026-11-08)
    anos-api.service        getAccountAs(envelope, quiet) (2026-11-08): /get-account with an envelope the caller
                            signed, the break-glass pair's at the finish; getAccount calls it;
                            getAssistedTransferAs(envelope, quiet) (2026-11-10): /get-assisted-transfer the same
                            way, the finish's read of a break-glass move the validators already hold;
                            getAssistedTransfer calls it; HeldAssistedTransfer carries type, as the validator
                            answers it (5.4)
    account-creation.service
                            the new accounts of Move your money, opened as the Wallet page opens one (8.3;
                            2026-11-08)
    keyholder-api.service   getSecurityBucketOneKey(n, envelope), getSecurityBucketTwoKey(n, envelope): the
                            keyholder's moderator routes, the account envelope as the body; getOwner(n, lookupId,
                            timeoutMs) (2026-11-08): the keyholder's /get-owner, level none, quiet in the log
    shares.service          findOwner(lookupId) (2026-11-08): every keyholder asked /get-owner at once with the
                            deposit's 15 second limit; { found: true, anopodId } on the first 200, else { found:
                            false, answered }, answered the keyholders that said unknown lookup id (zero: none
                            could be reached)
    crypto.service          generateHybridKeys(), wrapHybridPrivateKey / unwrapHybridPrivateKey (124-byte blob),
                            decryptFromHybrid (the mirror of encryptToHybrid: X25519 and ML-KEM-1024 decapsulation,
                            the same HKDF and aad), combineShares (shamir-secret-sharing combine), signSignOff
                            (pair one over the canonical sign-off), backupCodeProof (the backup code keys over a
                            canonical payload); buildBreakGlassTransferTransaction and
                            signAccountEnvelopeAsBreakGlass (2026-11-08): the break-glass move and the account
                            envelope signed by the break-glass pair, signAccountEnvelopeWith behind both envelopes;
                            everything else reused as it is
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
- A cancel of a break-glass move by either key (`breakGlassCancel` by the
  break-glass pair, `assistedTransferCancel` by the owner's own keys, both
  accepted by the validators since 2026-11-08) and the owner's dispute
  path (a cached key blob, a "Dispute a recovery" button, a warning): a
  later plan. Moving anos with the recovered break-glass keys was built
  2026-11-08 (12.3, Move your money; section 11).
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

#### The lookup through the keyholders (2026-11-08)

Built 2026-11-08 from
`~/Desktop/Z-TestNet/forclaude/recovery-lookup-plan-1.md` (FINAL,
2026-11-08), step 4 of five, after the keyholder's `/get-owner` (its spec
section 15), the doorman's route line and the masterpod's `/challenge` by
anoPod id (its spec 12.10). The username step of the locked-out stepper
is gone: step 1 finds the account through the keyholders and the masterpod
names it, step 2 shows it. Where the plan was silent the simplest thing
was chosen and is recorded here.

- `computing` was widened to cover the whole of step 1's Next (the lookup
  id, the keyholders, the masterpod) rather than a second signal; the
  progress bar shows "Finding your account…" under it throughout, scrypt
  taking well under a second of it. A `lookupError` signal carries step
  1's three refusals in red under the form, apart from step 3's `error`.
- The lookup id is not kept on a miss: the page sets `lookupId`,
  `anopodId` and `foundUsername` together, only once the keyholders named
  the pod and the masterpod its username, and the step's `[completed]` is
  `anopodId() !== null`. A miss leaves the form as it was (plan decision
  9); `form.reset()` runs only on the found path and when the page is
  destroyed.
- `findOwner` tells "not found" from "did not answer" by the status and
  the reason: `404` with `error` `unknown lookup id` is a keyholder that
  said not found; the doorman's own `404 Not Found` (a doorman without
  the route), a timeout (`status` 0) and a `502` count as no answer. With
  every keyholder unreached the line reads "The keyholders could not be
  reached"; with at least one "not found" and none found, the not-found
  line, since a keyholder that holds no owners row for the id is the
  truth whatever the others did.
- `getOwner` is quiet in the activity log, as the plan says, so a lookup
  does not write five lines, four of them 404s. The deposit's calls stay
  logged as before.
- Step 3's `username` is the fresh challenge's answer, falling back to
  the one step 1 showed (`foundUsername`) should the answer lack it; the
  payload no longer carries `username`, and `recovery.username` is set
  from the same value. `recoverOpen.noAnopodId` stays for a `200` without
  an id; `noAnopod`, `usernameHint`, `noSuchUsername` and `found` went
  with the username field; `USERNAME_DEBOUNCE_MS` stays for the create
  page.
- The Thai words for the new and changed keys (`finding`, `foundAccount`,
  `notFound`, `keyholdersUnreachable`, `computed`, `stepWho` and
  `recover.lockedOutText`) are the build chat's, with "ผู้ถือกุญแจ" for the
  keyholders as the deposit's words have it, to be checked by a Thai
  reader.
- Checked with `npx ng build` (clean). No server was started; the user's
  run-through is section 8 of the Test Net 2 deploy list.

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
"Attestor wallet"; and, since 2026-11-12 (section 11), the wallet reads
the three lists of the Attesting page every 15 seconds, for the number
on the Attesting entry (8.1; work-badge.service, 8.3). Nothing else. An
attestor's pod is an ordinary pod
(username starting with `attestor`, vouched by a super seed, setup
complete, a spending account staked 1000 anos for attestor through the
account page's Send, as today). A pod is a moderator or an attestor by its
username, never both.

Every edition, the wallet included, gets Cases (13.3): the person's side
of a trade or dispute case and, since 2026-11-12 (section 11), of a
recovery case. It shows in the navigation once setup is complete.

### 13.2 Routes and guards

    /attesting                    the trades and the disputes waiting for attestors (attestor edition)
    /attesting/trade/:caseId      one trade case: the person, the chat with the person, the trade, the buckets, the sign-off
    /attesting/dispute/:caseId    one dispute case: the parties, the chat with each, the escrow, the evidence, the verdicts
    /attesting/recovery/:caseId   one recovery's break-glass moves: the person, the chat with the person, the recovery case, the moves, the buckets, the sign-off (2026-11-08)
    /cases                        my cases (every edition)
    /cases/recovery/:caseId       my recovery case: the status, the video call, the chat with the attestor, the accounts being moved, the timeline (2026-11-12)
    /cases/:caseId                one of my cases: share the lookup id, upload evidence, the chat with the attestor, the timeline

The four Attesting pages need a session and the attestor edition
(`attestingGuard`, the shape of `moderationGuard`); a pod that is not an
attestor sees the masterpod's `403 not an attestor` as "This anoPod is not
an attestor". The three Cases pages need a session (`sessionGuard`). In
`app.routes.ts` `cases/recovery/:caseId` sits in front of `cases/:caseId`
(8.1).

### 13.3 The screens

**Attesting** (`/attesting`). Three tabs (the third since 2026-11-08). The
page asks the attestor for the staked account once per session (13.4, `AttestingService`): the picker
the moderation case page has, filled from `/list-anos-accounts`, the first
spending account picked; the choice signs every validator read, keyholder
pull and sign-off until the tab closes.

The Trades tab: the `assistedAnosTransfer` rows of `/list-assisted-transfers`
from the session's validator (8.3, 2026-11-10; since 2026-11-08 the list carries the
break-glass moves too, told apart by `type`; those belong to the Recoveries
tab's case pages), each row the sender as a person (`/list-anos-account-profiles` once for
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
in RAM (13.4) and goes to the case page. A status filter above the tabs
(the two review statuses by default, plus decided and dismissed) and a
Refresh; a quiet 15 s poll (`CASES_POLL_MS`).

The Recoveries tab (2026-11-08, break-glass plan 1 step 6):
`/list-break-glass-cases`, one row per recovery whose finish filed
break-glass moves (masterpod 14): the person's username and names, the
number of moves, "n of 2 signed", and the status in words linking to the
recovery case page. No Open a case: the person's recovery finish files the
case (12.3). The status filter applies to this tab too.

Since 2026-11-12 (section 11) a load that read everything, the first
one, Refresh and the poll alike, hands the ids of the page's things to
work-badge.service (8.3, `seeAttesting`): the transaction id of every
`assistedAnosTransfer` of the trade list, the transaction id of every
disputed escrow, and the case id of every recovery case that is open or
in review, whatever the status filter shows. They are what the number on
the Attesting entry counts (8.1), and this device has seen them all
then, so the number clears when the page is opened.

**Trade case** (`/attesting/trade/:caseId`), from `/get-trade-case`,
refreshed by a button and every 15 s. Top to bottom:

- The person: public selfie, username, names, the status in words. Under
  these facts, since 2026-11-12 (section 11), the chat with the person
  (8.7, `<app-case-chat-start>`): Start chat while the case is open or in
  review, which makes a private room about the case (`/create-chat-room`
  with the `caseId`, masterpod 18) and invites the person; Open chat once
  there is one, with "somchai has not accepted the chat yet." until the
  person accepts; "somchai did not accept the chat." and Invite again
  when the person declined. One chat per attestor per person. The chat
  stays when the case closes: Open chat stays, Start chat and Invite
  again go.
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
  `attestationSigned` events) to the `/attestation` of the session's
  validator (8.3; the default validator until 2026-11-10) one after the
  other, then `/mark-attestor-case-sent` with the answers. Shown as
  "Sent" with each answer, or Retry. The validator the sent line names
  ("Sent: validator 3 accepted both attestations."), which is also the
  one the masterpod is told, is the one the session is on after the
  posts (`AnosApiService.validator()`, 2026-11-10). The page of the
  attestor whose signature decided the case runs it at once, without the
  click.
- Dismiss: the preset reason, a note, Dismiss behind an inline
  confirmation (`/dismiss-attestor-case`).

**Dispute case** (`/attesting/dispute/:caseId`), from
`/get-dispute-case`, the same frame:

- The parties: the seller and the buyer, each with selfie, username and
  names, and which of them disputed; the status. Each party has its own
  Start chat button under its facts, as on the trade case (2026-11-12):
  one chat with the seller, one with the buyer. Under the parties the
  muted line "Either trader can invite you into their marketplace chat,
  from that chat's menu." (2026-11-12, section 11, step 6; 8.2, Chat,
  the attestor in a marketplace chat).
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
  full size in a new tab on click; who uploaded it and when. Since
  2026-11-12 (section 11) evidence is pictures only, and a file whose
  type is not one of the wallet's own three (`image/jpeg`, `image/png`,
  `image/webp`) is not opened: it shows a lock, with its type in the line
  under it. Without the key, the files are counted, not shown. After the
  decision, "the attestors' copies were deleted".
- Schedule, as the trade case.
- Verdict: Success or Cancel, a note, Sign. The `escrowVerdict` follow-up
  built as the account page does (`arbitratorId` the staked account),
  then `/sign-off-dispute-case`. The page shows each attestor's verdict.
- When decided: Send to the validators posts the two agreeing verdicts
  (from the `verdictSigned` events whose verdict is the decided one) to
  `/escrow-signature`, then `/mark-attestor-case-sent`; Retry on a
  refusal; the deciding attestor's page runs it at once. The sent line
  names the session's validator, as on the trade case (2026-11-10).
- Dismiss, as the trade case.

**Recovery case** (`/attesting/recovery/:caseId`, 2026-11-08, break-glass
plan 1 step 6), from `/get-break-glass-case`, refreshed by a button and
every 15 s, the trade case's frame. Top to bottom:

- The person: public selfie, username, names, the status in words; the
  Start chat button under these facts, as on the trade case (2026-11-12).
- The recovery: the recovery case's status in words and the moderators'
  approvals, each "username · time".
- The moves: per move the old account with its type, the new account with
  Copy, the transaction id with Copy, and what the session's validator lists
  for it (`/list-assisted-transfers` matched by transaction id, read again
  on every refresh and poll): the amount, when it was made and the
  attestations in its slots, or "not listed on this validator (both
  attestations in, written, or cancelled)".
- The timeline: every event in words, as the trade case; the filing reads
  "<username> filed n moves", a sign-off "<attestor> signed n attestations
  with account …".
- Schedule: as the trade case (`/schedule-break-glass-case`). After Save
  the attestor reads "Scheduled for <time>; the person sees the time and
  the link on their case page." (2026-11-12, section 11; until then "the
  time and the link are recorded on the case."): the masterpod now writes
  the person a `recoveryCaseScheduled` notification (masterpod 14.7), and
  the person's recovery case page, My recovery case below, shows the
  call. The words changed and nothing else on this page.
- The lookup id: the recovery case's, with Copy; no sharing step.
- Bucket one and two: the trade case's pull, pointed at
  `/list-break-glass-case-security-records`, by the recovery case's lookup
  id.
- Attest: "Signed by n of 2" and who; Sign all attestations builds one
  `attestation` follow-up per move (`attestorId` the staked account,
  `accountId` the move's old account, `transactionId` the move's; the
  wallet pair from `/api/sign`) and runs `/sign-off-break-glass-case` with
  every move once.
- When the answer says decided: Send to the validators posts the stored
  attestations the session's validator (8.3; the default validator until
  2026-11-10) does not hold yet (two per move once
  two attestors signed, from the `attestationSigned` events; the listed
  move's `attestorIds` tell which it holds) to `/attestation` one after the
  other, then `/mark-break-glass-case-sent` with the answers; "Sent" once
  the validator holds every attestation for the moves it still lists, Retry
  otherwise; the page of the attestor whose sign-off decided the case runs
  it at once. The sent line names the session's validator, as on the
  trade case (2026-11-10).
- Dismiss: one of the five reasons, a note, Dismiss behind an inline
  confirmation (`/dismiss-break-glass-case`); the moves stay held on the
  validators until a cancel.

The case pair, the opened evidence and the bucket keys live in RAM and are
zeroed when the page is left; a refresh fetches and opens them again.

**Cases** (`/cases`), every edition. `/list-my-cases`: the trades and the
disputes where this pod is a party, newest first, each row the kind, the
amount and the other account when the account page's transaction list
knows the transaction or, on an assisted account, its held transfer does
(`/get-assisted-transfer`, 2026-11-06, so a trade row reads "Assisted
trade · 5 anos · with <receiver>" while the transfer waits), otherwise
the transaction id, the status in words and when it was opened. A row
opens `/cases/:caseId`. The notifications page's labels for the five
case kinds (13.4) link here.

Since 2026-11-12 (section 11) the page has a third kind of row, the
recovery case: the case under which the money of the person's lost
accounts is moved (masterpod 14; the attestors' Recovery case above).
The page reads `/list-my-break-glass-moves` (masterpod 14.4.1) beside
`/list-my-cases`, and each case of its answer is a row, sorted with the
trades and the disputes by the date it was opened: the icon
`lock_reset`; the title "Recovery: moving your money", a link to
`/cases/recovery/:caseId`; under it the status in words, how many
accounts are being moved (the case's moves) and when it was opened, "In
review · 2 accounts · opened Nov 11, 2026, 3:50:12 PM"; then the case
id, as the other rows have it. When `/list-my-break-glass-moves` is
refused, the error line reads `/list-my-break-glass-moves: <reason>` and
the trade and dispute rows still show. The subtitle names all three
kinds: "Your side of a trade an attestor is checking, of an escrow in
dispute, or of a recovery whose money is being moved." Until then the
recovery case showed nowhere on the person's side but in the line under
a lost account's card (8.2, Wallet), so the person had no way to the
video call an attestor had scheduled.

**My case** (`/cases/:caseId`), from `/get-my-case`, refreshed by a button
and every 15 s. For a trade: "An attestor is checking your trade", the
status in words, "See the transfer" under the transaction id, to the
transfer page of the sending account
(`/wallet/:accountId/assisted/:transactionId`, 2026-11-06), the timeline
the person may see (case opened, scheduled with the meeting link,
decided, dismissed with the reason in words, sent), and Share my lookup
id: one button, disabled once shared, which opens the identity blob in
session (`SessionService.getIdentity`) and runs `/share-lookup-id`;
"Nothing but the lookup id leaves this device". For a
dispute: the same frame with "Attestors are looking at this escrow", your
side (seller or buyer), and Evidence: a file input (pictures, JPEG, PNG
or WebP, several at once; no PDFs since 2026-11-12, section 11) with
Upload, which redraws each file as a fresh JPEG (since 2026-11-12; a file
the browser cannot read as a picture stops the upload), makes a content
key for it, encrypts the picture under it, wraps the key under the pod's
encryption key
(`keyForMe`) and to the case key (`keyForCase`, aad the case id), and runs
`/add-dispute-evidence`; the list of your files, each opened with
`keyForMe` and shown as on the attestor's page; and Supply again, offered
on a file of yours from another case (the Cases list of your own evidence
across cases comes from the other cases' `/get-my-case` answers, cached),
which wraps its content key to this case's key and posts it under
`existing`. After the decision: "The attestors' copies have been deleted;
your copies stay."

Both kinds have, since 2026-11-12 (section 11), the heading "Chat with
the attestor" after the kind's own part (the lookup id, the evidence) and
before the timeline, and under it the person's chats about the case (8.7,
`<app-case-chat-list>`): an attestor who started a chat and waits for an
answer, "attestorjoy is an attestor on this case and wants to chat with
you", with Accept (the conversation opens) and Decline; a chat the person
is in, the attestor's avatar and username with Open chat; "No attestor
has started a chat with you about this case yet." when there is neither.
Two attestors work on a case, so a person can have two chats on one case.
The same request shows on the Requests page of Chat (8.2), and the person
may accept it there. On a dispute, under that block, the muted line "To
let the attestor read your marketplace chat, open that chat, then its
menu, then Invite an attestor." (2026-11-12, section 11, step 6; 8.2,
Chat, the attestor in a marketplace chat).

**My recovery case** (`/cases/recovery/:caseId`, every edition,
2026-11-12, section 11; the plan is
forclaude/wallet-case-chats-plan-1.md, its section 3): the person's side
of the recovery case, in the frame of My case. It reads
`/list-my-break-glass-moves` when it opens, by Refresh and every 15 s
(`CASES_POLL_MS`, quiet in the log), and takes the case with its id;
when the answer has none: "No recovery case of yours with this id." A
refused read shows as `/list-my-break-glass-moves: <reason>` and leaves
what the page shows. Top to bottom:

- The card's title "Your recovery: moving your money"; the case id in
  short form with Copy; a link back to Cases; Refresh.
- The status in words, with the status's icon: "Open: two attestors have
  to check that it is you. Then your money moves to your new accounts.",
  "In review: an attestor is checking your case.", "Decided: two
  attestors signed. Your money is moving to your new accounts.", or
  "Dismissed: <the reason in words>.", as My case words a dismissal.
  Under it, while the case is open or in review, "1 of 2 attestors have
  signed.", the number from the answer's `signOffs`.
- Video call, while the case is open or in review. With a `scheduled`
  event, the newest one: "An attestor set up a video call for <date and
  time>." and the flat button Join the video call, which opens the
  event's `meetLink` in a new tab. Without one, the muted line "No video
  call is set up yet. An attestor will set one up, or start a chat with
  you to agree on a time." A closed case shows neither the heading nor
  the lines; the call stays in the timeline.
- Chat with the attestor: the person's chats about the case (8.7,
  `<app-case-chat-list>`), as on My case. The masterpod marks a recovery
  chat with the break-glass case's id, which is the recovery case's id
  (masterpod 18), so the block finds the chat an attestor started from
  the Recovery case page.
- Your accounts: one line per move, in the answer's order, "Spending
  account: a1b2c3d4…e5f6 to Spending account 2": the account's kind in
  words, the old account's id in short form, and the new account by its
  name among the session's accounts (account-names.ts, as the Wallet
  page names them), else its id in short form. The new account is a link
  to its page, `/wallet/:accountId`.
- The timeline, as My case draws it, with the four kinds the masterpod
  shows the person (masterpod 14.4.1): `scheduled` reads "Video call
  scheduled for <time>." with the meeting link, `decided` "Two attestors
  signed", `sent` "The decision was sent to the validators", `dismissed`
  "Dismissed: <the reason in words>"; "Nothing yet." while there is
  none. The filing of the moves is not among the person's events, so a
  new case has an empty timeline.

No attestor is named on the page outside the chat block: the answer
carries none. The notification `recoveryCaseScheduled` leads here (8.2,
Notifications).

### 13.4 Services and state, new or changed

    attesting.service       the attestor's staked account for the session (accountId, its keyBlob opened per
                            signature as the account page does), the trade and dispute lists from the validator
                            with their profiles (the trade list carries the break-glass moves too since
                            2026-11-08; tradeOf finds a move), the case pairs and opened content keys per case
                            while a page is open; everything in RAM
    masterpod-api.service   one method per route of masterpod 13.4 (eighteen) and their shapes; listAttestorCases
                            sends {} when no filter is given; since 2026-11-08 the seven attestor routes of
                            masterpod 14.4.2 (listBreakGlassCases, getBreakGlassCase,
                            listBreakGlassCaseSecurityRecords, scheduleBreakGlassCase, signOffBreakGlassCase,
                            markBreakGlassCaseSent, dismissBreakGlassCase) with BreakGlassCaseRow,
                            BreakGlassCaseAnswer, BreakGlassAttestation and BREAK_GLASS_DISMISS_REASONS
    anos-api.service        listAssistedTransfers(pairOne, accountId), listDisputedEscrows(pairOne, accountId):
                            the account envelope of section 5.3, as getAccount builds it; AssistedTransferItem
                            carries type since 2026-11-08 (assistedAnosTransfer or breakGlassTransfer)
    crypto.service          additions only: wrapCaseSecret(secret, chatP256PublicHex, chatKemPublicHex) and
                            unwrapCaseSecret(bytes, chat), the room key wrap of section 7 over the 96 secret
                            bytes (1725 bytes); newContentKey(); everything else reused as it is (encrypt,
                            decrypt, encryptToHybrid, decryptFromHybrid, generateHybridKeys,
                            hybridKeysFromSecret, buildFollowUp, signAccountEnvelope)
    config.service          attestorEdition in WalletConfig's edition
    notifications page      the five case kinds in words, each linking to /cases/:caseId by reference id; since
                            2026-11-12 recoveryCaseScheduled too, linking to /cases/recovery/:caseId
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

- Email or any message to the parties outside the app; the app is the
  channel: the case pages, the notifications and, since 2026-11-12
  (section 11), the chat an attestor starts with a party from the case
  page (13.3) and the marketplace chat of a disputed trade, which either
  trader can bring an attestor on the dispute into (8.2, Chat).
- A party deleting their evidence; evidence beyond the four content types.
- Several validators asked at once; the lists come from the session's
  validator, as every anos call does.
- A moderator who is also an attestor.
- Notifications to attestors when a recovery's moves are filed, and to the
  person when the case is decided, sent or dismissed (2026-11-08;
  masterpod 14.7): the attestor edition lists the cases, the person's
  wallet reads them. Since 2026-11-12 (section 11) one thing does notify
  the person: a scheduled video call, `recoveryCaseScheduled` (13.3).

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

#### Build 4, the recoveries (2026-11-08)

Built from `forclaude/break-glass-plan-1.md` (FINAL), section 6, the
wallet's third and last step of the plan, after the step 4 and step 5 notes
of section 11; the three are deployed together after the testnet reset.
Why: since step 5 the recovery's finish files one `breakGlassTransfer` per
lost account that holds anos, and two attestors have to sign each move like
an assisted transfer; the masterpod keeps a break-glass case per recovery
(its section 14), and this build gives the attestor edition the list and
the page that signs. Changed: `attesting.page.ts`, `app.routes.ts`,
`attesting.guard.ts` (a comment), `masterpod-api.service.ts`,
`anos-api.service.ts`, `en.ts`, `th.ts`, this spec; new:
`pages/attesting-recovery-case.page.ts`. What the plan left open and how it
was decided:

- The Recoveries tab asks `/list-break-glass-cases` for all four statuses
  and applies the page's status filter itself, as the Trades and Disputes
  tabs do, so a filter change needs no new read; the tab starts at the
  plan's default statuses (`open`, `inReview`) because the filter does. A
  row shows the names the list carries (no selfie: the list answers no
  account id to look a profile up by; the case page has the selfie), the
  moves count, "n of 2 signed" (`attesting.signedOfTwo`, a key beyond the
  plan's three) and the status in words linking to the case page; no Open a
  case, the person's finish files the case. The Trades tab keeps the rows
  whose `type` is `assistedAnosTransfer`; a row without a `type` (a
  validator on old code) is left out too, as the plan reads.
- `AttestingService` is unchanged: its `trades` list now carries the
  break-glass moves as the validator lists them, and `tradeOf` finds a move
  by transaction id, which the recovery page uses; the profiles are fetched
  for the moves' old accounts too, harmlessly.
- The recovery page reads the validator's lists again (`loadLists`, quiet)
  on every load, the poll included, when an account is picked, so the
  moves' amounts and slots are current; a refusal shows under The moves in
  words (`recoveryCase.listRefused`) while the previous read's rows stay.
  The trade page reads the lists once; the recovery page needs them fresh
  for the Send (two bullets down).
- The stage of a move: `/list-assisted-transfers` carries no stage word
  (anossoftware 13.2), so the page shows what the list has, the amount, when
  the move was made and the attestations in its slots ("1 attestation on
  the validators", as the Trades tab reads), or "not listed on this
  validator (both attestations in, written, or cancelled)". A listed move
  is waiting for attestors by the list's own rule, an empty slot.
- The Send: `/mark-break-glass-case-sent` records `{ signer, status,
  error? }` per posted attestation, the signer alone (masterpod 14.10:
  "nothing names the move"), so the trade page's rule, post only what no
  sent event accepted, cannot be applied by signer when a signer has two or
  more attestations. The validator's list is the record instead: for a move
  the validator still lists, the stored attestations whose `attestorId` is
  not among the listed `attestorIds` are pending; a move it no longer lists
  has nothing to post. "Sent" reads once nothing is pending; the Send
  refuses while the lists were never read this session
  (`recoveryCase.listNotLoaded`), so an unread list is never taken for
  nothing pending. The stored attestations come from the
  `attestationSigned` events' `attestations`, the whole follow-up objects,
  each naming its move in `payload.transactionId` (masterpod 14.10). They
  are posted in event order then move order; the results under the button
  are tracked by position, since one signer appears once per move.
- Sign all attestations: `/api/sign` is called once per move, in move
  order, before the one `/sign-off-break-glass-case` call; the button is
  disabled for a case without moves (never: a case is made by a filing).
- The refusals in words: `400 attestations do not match the moves`
  (`recoveryCase.movesMismatch`, "refresh and sign again": the moves changed
  under the page), `400 sign-off does not match the case` (`mismatch`),
  `400 attestations differ in attestorId` (`differ`, unreachable from this
  page, which signs with one account), the rest as the trade page's (`409
  already signed off`, `409 case closed`, `409 case not decided`, `403 not
  your account`, `401 bad signature`). `/get-break-glass-case` 404 reads
  `recoveryCase.notFound`.
- The recovery block: the recovery case's status in `recoveryStatus` words
  and the approvals as "username · time" joined by commas
  (`noApprovals` when the list is empty, never in practice: a filing needs
  two). The lookup id is the recovery case's, shown with Copy, `noLookupId`
  when null; there is no sharing step, so the trade page's "waiting for the
  lookup id" has no counterpart and Pull key is enabled as soon as the case
  is loaded. The timeline: `opened` reads "<username> filed n moves" (the
  person's own filing, the count from the details), `attestationSigned`
  "<attestor> signed n attestations with account …"; the other kinds as the
  trade page. The Schedule outcome says the time and the link are recorded
  on the case: the person's wallet shows no scheduled event (step 4 built
  the five move states, none for a schedule), so the attestor sends the
  link another way; a gap for a later plan.
- The dismiss reasons are a third constant, `BREAK_GLASS_DISMISS_REASONS`
  (the trade case's six without `settled`), with `BreakGlassDismissReason`;
  the words are the staff dismiss reasons already in the dictionary. The
  outcome says the moves stay held until a cancel (masterpod 14.4.2).
- `MasterpodApiService`: the seven methods under a new heading, with
  `BreakGlassCaseRow`, `BreakGlassListedMove` (a move without `createdAt`,
  as the list answers it), `BreakGlassApproval`, `BreakGlassCaseAnswer`
  (`recoveryStatus` typed as the recovery's `CaseStatus`),
  `BreakGlassAttestation`; `listBreakGlassCases` sends `{}` with no filter,
  as `listAttestorCases` does. `AnosApiService`: `AssistedTransferItem.type`.
  The routes' and the guard's comments count four Attesting pages; 13.2
  lists the route.
- Words: `attesting.recoveriesTab`, `noRecoveries`, `movesCount`,
  `signedOfTwo`; the `recoveryCase` section (the titles, the move lines,
  the sign-off and Send lines, the refusals, the two event lines); the page
  reuses `tradeCase.lookupIdTitle`, `attest`, `signedSoFar`, `stillToSend`,
  `attestationBy`, `allAccepted`, `alreadySigned`, `noStake` and the
  `attesting` and `common` sentences where the English is the same. The
  Thai lines were written here by the glossary of
  `forclaude/wallet-languages-plan-1.md` 1.6 ("break-glass" as ฉุกเฉิน, as
  the step 4 and 5 words have it) and are to be checked by a Thai reader.
- Spec: 13.2, 13.3, 13.4, 13.6 and this note; README unchanged.
- `npx ng build` clean. Not run in a browser here: the user resets the
  testnet, deploys the three wallet steps together and runs a recovery
  through, then signs its moves from two attestor pods, expecting the
  Recoveries tab to list the case after the finish's Move your money step,
  the case page to show the moves with their amounts from the validator,
  the second sign-off to decide the case and post two attestations per
  move, and the lost accounts' cards to read "being written" and then
  "Moved to …".
