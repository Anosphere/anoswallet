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
    DEFAULT_VALIDATOR   1                                                    the validator the wallet posts to
    DIST_DIR            dist/wallet/browser                                  the Angular build it serves
    RP_ID               localhost                                            the relying-party id the browser uses in both ceremonies; the masterpod's RP_ID
    GUARDED_LOCK_MINUTES  1    the validators' time lock on a guarded account, in minutes (10 on the testnet; a week in production)
    VAULT_LOCK_MINUTES    2    the same on a vault account (20 on the testnet; a month)
    LOCK_OFFSET_MINUTES   1    how much more than its lock a guarded or vault transfer may be dated ahead (5 on the testnet; 10)

The three lock numbers are the validators' (anossoftware's
network/testnet.env); the wallet dates a guarded or vault transfer the
lock plus the offset ahead and a validator refuses one outside its
window, so the two files are changed together (2026-11-06, section 11).

Routes

    GET  /api/config                  200 { validators, keyholders, shareThreshold, depositFloorPercent, defaultValidator, edition,
                                      rpId, guardedLockMinutes, vaultLockMinutes, lockOffsetMinutes }: the two counts are the
                                      list lengths; the browser never sees an address
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

Since 2026-11-08 the answer also carries role, after isSuperSeed:
"moderator", "attestor" or null, the pod's live appointment (masterpod
spec section 16, forclaude/appointments-plan-1.md). The account page's
Stake for list reads it (8.2). An older masterpod sends no role field,
and the wallet then shows all six purposes.

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
      the wallet's AccountAnswer has both optional, and only the Guardians pages read them.

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
    answer: 200 { transfer: { transactionId, accountId, accountIdTo, amount: string, createdAt,
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

    POST /get-locked-transfer (account)
    body { }
    answer: 200 { transfer: { transactionId, accountId, accountIdTo, amount: string, createdAt,
      unlocksAt: ISO 8601, stage: waiting | locked | due } | null }
    transfer: the locked_transactions row whose account_id is the signer, a guarded or vault transfer waiting
      out its time lock, or null when there is none (2026-11-06, anossoftware spec section 18). There is at
      most one: account_id is unique there, and the validator holds one transaction per account. The sender's
      only: the receiver sees it in the history when it lands. The held transfer only, nothing from logs or
      archives: a written transfer is on the chain under the same id, and the row is deleted when written.
      Nothing can be done with a locked transfer: no follow-up exists for it. unlocksAt is the row's
      future_date, the moment the transfer may be written. stage is named by the validator from the row by the
      database's clock, the one the ready list reads (anossoftware spec 18.2): waiting until every validator
      accepted the transfer; locked while the unlock moment is ahead; due once it has passed, until the next
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

A guard sends anyone without a session to /. Which pages the navigation
shows follows the status: vouching until vouched; identity and setup
until setup is complete; home first, then wallet, chat, marketplace, DAO
(2026-11-08) and account once it is (2026-11-06, section 11); seed when
isSeed. The Chat entry carries the number of unread rooms (8.2, Chat;
2026-11-05, section 11) and the Notifications entry the number of unread
notifications (2026-11-06); the side panel and the Home tiles draw one
list, navigation.service (8.3). The toolbar's "anoPod wallet" is a link
to /home once setup is complete.

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
card of the Wallet paragraph below, the same component; "Things to do",
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
carrying their unread counts at the top right, drawn from the same list
as the side panel (navigation.service, 8.3). On open /list-anos-accounts
(quiet) fills the session's accounts, a refusal in red, then the
balances are read; every 5 seconds they are read again while an account
is not on the ledger yet or any anos are held or pending, as the Wallet
page does. Beside the accounts, /list-dao-proposals { status: 'open',
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
8.3), the card Home shows too: Total, the balances as the validator says
them, with a refresh button; Available, Total minus what is spoken for;
then one small line per kind spoken for, each only when its number is
above zero ("25 anos in escrow trades", "10 anos in assisted transfers",
"15 anos waiting out a lock", "5 anos in pending transfers"), then "1
account is not on the ledger yet" and "1 account could not be read"
(plural likewise); "No anos account yet." without an account; "Reading…"
until the first read finished. The validator moves a balance only when a
transfer is written, so Total stays whole while anos are spoken for.
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
when the page opens, by the card's refresh button, by Refresh (which
reloads the account list too) and every 5 seconds while an account is
not on the ledger yet or any anos are held or pending; quiet in the log,
as the polls are. Then "Open a new account": a type select (spending,
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
from /get-locked-transfer as one row that is not a link, since nothing
can be done with it (no follow-up exists for a locked transfer, and it
has no page of its own): "5 anos to <receiver>", then "Waiting out the
lock · until <the unlock moment>" while the stage is locked, else the
stage in words and the date it was made; "No transfer is waiting." when
there is none; the read's refusal in red when it fails (a validator or
doorman without the route), the rest of the page unharmed. The stage
words, from the validator's stage (anossoftware spec 18.2,
locked-stage.ts): waiting, "Waiting for the validators"; locked,
"Waiting out the lock"; due, "Unlocked, being written"; a word the
wallet does not know, "Held". On any other account type nothing is read
and nothing shows.

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
minutes ahead and waits out its lock on the validators." under Send, the
minutes in words (minutes-words.ts: "7 days and 10 minutes" in
production); while the numbers have not loaded, Send is off and the line
reads "The lock settings have not loaded from the proxy. Refresh to try
again."; assisted sends
assistedAnosTransfer. The Stake for list shows the purposes this anoPod
may stake for (2026-11-08, section 11): all six while the status carries
no role (no status yet, or an older masterpod, 4.3); the four without
moderator and attestor when role is null; those four and the role the
pod holds otherwise; a pick that leaves the list goes back to daoVote.
Stake for starts at daoVote and the amount box starts empty (2026-11-10,
section 11; they started at attestor and at 1), so the form on a fresh
page and the form after a send are the same.
A moderator or attestor stake the validator refuses for the appointment
reads "Only an appointed attestor can stake for attestor." or "The
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
Cancel and Send. Cancel sends nothing and leaves the form as it was
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
it is written." Under Send, an assisted account
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
Yes builds the escrowSuccess, escrowCancel or escrowDispute follow-up
(crypto buildFollowUp, pair one from the keyBlob), /api/sign adds the
wallet pair, /escrow-signature takes it, then "Sent. ..." in green or
the validator's refusal in plain words (not all accepted yet; the other
side moved first, naming what they did; already in dispute; not this
account's to sign), and the page refreshes. No buttons in any other
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
be undone."), then "Yes, cancel the transfer" or Back. Yes builds the
assistedTransferCancel follow-up as the removed form did (crypto
buildFollowUp, pair one from the keyBlob), /api/sign adds the wallet
pair, /assisted-transfer-cancel takes it, then "Sent. The transfer is
being cancelled; the anos stay in this account." in green or the
validator's refusal in plain words (not all accepted yet; already being
cancelled; no longer held; not this account's to cancel), the rest as
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
them, "somchai · Selling 100 anos for THB". The
rooms are the latest /list-chat-rooms answer kept in the session, which
the shell's 5-second poll refreshes once setup is complete; the list
refreshes it once when it opens. "No chat keys in this tab: unlock
again." shows without chat keys.

One conversation, at /chat/:chatRoomId: a header with the avatar or icon,
the title, the members (the invited marked) and a menu with Invite
someone (the creator of a private or public room; the username search,
the person's selfie, Invite), Members (a panel of the members and the
invited with avatars) and Leave (a member who is not the creator; the
room key is dropped and the list opens). The thread opens at the room's
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
listing, under the header and its panels and above the thread: the
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

Requests, at /chat/requests: the invites to this pod (the inviter's
username, then `invited you to "<the public room's name>"`, `invited you
to a private chat` or, for a room about one of this pod's listings,
`wants to chat about your listing Selling 100 anos for THB`; 2026-11-06),
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
the two stake fields of /get-account. The data comes from the wallet's
defaultValidator through its doorman and the proxy, never from the
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
(2026-11-05, section 11).

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
                            DaoProposal and DaoVoteItem
    keyholder-api.service   the keyholder test app's, base path /api/keyholder/<n>
    anos-api.service        the anos test app's account-api.service.ts, base path /api/anos/<defaultValidator>,
                            plus the five signed reads (listEscrows added 2026-11-05, getAssistedTransfer and
                            getLockedTransfer 2026-11-06; listTransactions takes from and to, 2026-11-06);
                            getAccountAs, the /get-account read with an envelope the caller signed, the
                            break-glass pair's at the recovery's finish (2026-11-08); the two public fund
                            proposal reads of anossoftware 25 (2026-11-08), listFundProposals(filters, quiet)
                            and getFundProposal(transactionId, quiet), each a plain unsigned post with the
                            object body and no envelope, the wallet's first unsigned posts to a validator, with
                            the types FundProposalStatus, FundSettings, FundVoteItem, FundPayoutItem,
                            FundProposalItem, FundProposal and FundListFilters; AccountAnswer carries the
                            optional stakes and guardianVotes of /get-account (5.4)
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
                            without the field, which Home's fund proposal line reads, 2026-11-08)
                            read by refresh from /get-account, /list-transactions, /list-escrows and the
                            held-transfer read of the account's type, every account at once; the totals over
                            the session's accounts; needsPoll while an account is not on the ledger yet or
                            any anos are held or pending; a lost account (2026-11-08: its keyBlob does not open
                            under the session's key blob key) gets the lost entry and counts in no total and no
                            poll, isLost and usableAccounts tell the pages and the pickers, markLost tries every
                            keyBlob whenever the account list changes, and the lost accounts' break-glass moves
                            (moves, moveOf, loadMoves over /list-my-break-glass-moves and the new account's
                            history) are read with the balances
    notes.service           the noted transactions (2026-11-07): the last list read with its blobs opened,
                            byTransaction, add, update and remove, the preset kind and the starting currency
    settings.service        the wallet settings (2026-11-07): one encrypted object on the masterpod (4.7), read once
                            per session (Home, quiet) and saved whole (setup's Continue, the protect page's Save)
    navigation.service      the one navigation list (2026-11-06): NavItem (path, label, icon, badge) and items,
                            the side panel's entries by the status and the edition, Home first once setup is
                            complete, Chat and Notifications with their unread counts; the side panel and the
                            Home tiles both draw it; DAO after Marketplace and before Account (2026-11-08)
    chat.service            what the chat pages share (2026-11-05): room keys (roomKeyOf, wrapFor), decryptMessage,
                            piecesOf, a room's title, kind, icon and other person, the order by activity, shortWhen,
                            timeOf and dayLabel, requestedRooms, refreshRooms; listingWords, a listing in a few
                            words for a title or a request (2026-11-06)
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
                            2026-11-08)
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
live camera has, before anything else is done with it; a smaller or
undecodable file passes unchanged.

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
greeting (56 px).

### 8.7 The marketplace components

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
  [accountIds]>`): the pinned card of a private room about a listing (8.2,
  Chat), drawn by chat-room.page.ts under its header, above the thread.
  `accountIds` is the page's computed of the account ids found in the
  decrypted messages (the 64-hex pieces of `piecesOf`), each with its
  sender and position, newest first; the page changes only to draw the
  card and feed it. The card posts its own messages (Share an account,
  Escrow trade started and, since 2026-11-10, Escrow trade released, the
  last two from its check) encrypted with the room key, and the thread's
  poll shows them. It exports `FoundAccountId`. Since 2026-11-10 the card
  also reads the room's messages itself for their account ids (8.2,
  Chat): the page's computed holds the ids of the newest 50 messages and
  of what arrived since, which is not the whole chat.

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
`code` is true; `notes`, each a paragraph under the lines; and
`confirmLabel`, the words on the second button. A value too long for its
column wraps at a space, and is cut inside a word only when the word
alone is too long (`overflow-wrap: anywhere`); a value in the id font is
cut anywhere, by the global rule for `code`, so a 64-character id wraps
on a phone (2026-11-10, section 11: at first every value was cut
anywhere). The two buttons, at the right: Cancel
(`common.cancel`), which closes with false, and the caller's button,
which closes with true.

The box closes only by those two buttons. A click outside it and the
Escape key do nothing (`disableClose`), so the second click of a double
click on the page's button cannot close the box or answer it. The second
button cannot be pressed for the first half second after the box opens
(`CONFIRM_ARM_MS`, 500, in constants.ts), so that second click can never
land on it. Nothing in the box has the focus when it opens (`autoFocus:
'dialog'`: the focus goes to the box itself), so the Enter key answers
nothing. The box is 480 px wide, or the screen's width less 32 px where
that is narrower.

Two places use it (8.2): the Send form of the account page, before every
kind of send, and "Open a new account" on the Wallet page, before Create
anos account and Retry. Each does nothing while a box is already open.

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
  count of waiting vouch requests on Home for a seed (needs a read); a
  cancel for a locked transfer (none exists on the validator); the
  receiver's view of an incoming assisted transfer; a username for an
  account id; a notification when a transfer is written; asking several
  validators instead of one; "Anos" with a capital.
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
record and an email where a moderator can reach you. A moderator will
meet you on a video call and check your security buckets before anything
is released." Button: Start, to `/recover/open`. "Continue
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
2. Your account: "We found your account: alice" and the contact email.
   Next. Nobody types a username; there is no username path.
3. Open my case: one button. `/challenge` (openCase, the anoPod id) gives
   a fresh challenge and the username; the passkey registration with the
   PRF extension, that id as user handle and the username as name and
   display name; the PRF output from the registration or, when it
   returned none, one local assertion with a random challenge; `KEK_prf`;
   the recovery hybrid pair and `hybridKeyBlob`; the ephemeral keys;
   `/open-recovery-case`, the payload without a username. On 201 the
   recovery session is open and the page goes to `/recover/case`. The
   refusals shown: "a case is already open for this identity" (409), a
   masterpod refusal as `/challenge: <reason>` or `/open-recovery-case:
   <reason>`, the passkey messages as on Create.

**My recovery** (`/recover/case`). The case id (short, with Copy), the
status in words ("Open: a moderator will contact you at <email> and meet
you on a video call", "In review", "Approved: the bankers are sending your
keys", "Delivering: n of 3 key shares received", "Completed",
"Dismissed: <reason in words>"), the timeline from the events the person
may see (scheduled with the meeting link as a link, approved, dismissed,
recovered, completed), a Refresh button (`/get-recovery-pod`; also polled
every 15 s while the page is open). "Keep this device: you unlock this case
with the passkey you just made."

When three shares of one backup code `keyId` are in, the finish appears as
a second stepper on the same page. The person never sees a backup code,
here or on Setup (2026-11-10, section 11): on these screens it is "the
key the bankers keep", "the rebuilt key" or "the key".

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
3. New key for the bankers (until 2026-11-10 "New backup code", which
   showed the new code once as on Setup and waited for "I have written it
   down, complete"): one button, "Make the new key", makes a new code
   without showing it; `newBlob2`, the new backup code keys, the proof by
   the old keys, `/rotate-backup-code`; then the deposit as `backupcode`
   through `SharesService.deposit`, a new `keyId`; the button reads "Retry
   the deposit" when only the deposit failed. "The old key is now
   worthless."
4. Move your money (2026-11-08, `forclaude/break-glass-plan-1.md` step 5,
   section 11; in place of the "Break-glass keys" step that stood third
   from 2026-10-26, which matched each recovered seed to its account and
   stored it there with `/store-break-glass-blob`, and left with step 4 of
   that plan): "Your old accounts' keys are gone with the lost passkey.
   For each account that holds anos the wallet opens a new account of the
   same type and files a move signed by its break-glass key. Two attestors
   check you and sign; a guarded or vault account's move also waits out
   its lock." The button Move my money runs: (1) `/list-anos-accounts`
   into the session; each recovered seed's two break-glass public keys
   find the account whose `creation.payload.publicKeys` names them, and a
   seed that matches none is unmatched; (2) an account whose move
   `/list-my-break-glass-moves` already lists is filed and skipped; every
   other matched account is read with `/get-account` signed by its
   break-glass pair (the validators accept it since the user keys are
   gone, anossoftware 22), a balance of 0 is empty and skipped, every
   read before any write; (3) for each account left, a new account of the
   same type through `account-creation.service` (8.3), waited for on the
   ledger; (4) the `breakGlassTransfer` of the whole balance into it,
   chained on the latest transaction id read, dated now plus the type's
   minutes ahead (guarded and vault the lock plus the offset by the
   proxy's numbers, else 0), signed by the break-glass pair alone and
   posted to `/anos-transfer`, no signing server; a refusal saying the
   account already has a held transaction counts as filed; (5)
   `/file-break-glass-moves` with the case id and this run's moves, a
   `409 move already filed` counting as filed; (6) the seeds wiped and
   dropped from `RecoveryService`. The result: "2 moves filed, 1 account
   was empty, 0 seeds matched no account", or "No break-glass seeds were
   recovered, so there is nothing to move." The step is complete when the
   run ended without an error, even with nothing to move; Retry runs it
   again and skips what is filed. This is the one place in the wallet
   that uses a break-glass key: no card, account page or Account entry
   offers one. The old accounts' key blobs do not open under the new
   passkey's key blob key (section 7), so the wallet shows them as lost,
   with the move's progress (8.2).
5. Done: `/complete-recovery-case`; "You're back in." Continue to
   `/wallet`.

Each step keeps its result in RAM and can be retried; a refresh of the
page loses the combined code and the seeds, and the person starts the
finish again from Combine after unlocking the recovery pod (Move your
money then skips the moves already filed).

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
                            openCase with the anoPod id the keyholders named, and answers its username
                            (2026-11-08); listAnosAccounts items carry breakGlassBlob;
                            listMyBreakGlassMoves and fileBreakGlassMoves (masterpod 14.4.1, 2026-11-08)
    anos-api.service        getAccountAs(envelope, quiet) (2026-11-08): /get-account with an envelope the caller
                            signed, the break-glass pair's at the finish; getAccount calls it
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
    /attesting/recovery/:caseId   one recovery's break-glass moves: the person, the recovery case, the moves, the buckets, the sign-off (2026-11-08)
    /cases                        my cases (every edition)
    /cases/:caseId                one of my cases: share the lookup id, upload evidence, the timeline

The four Attesting pages need a session and the attestor edition
(`attestingGuard`, the shape of `moderationGuard`); a pod that is not an
attestor sees the masterpod's `403 not an attestor` as "This anoPod is not
an attestor". The two Cases pages need a session (`sessionGuard`).

### 13.3 The screens

**Attesting** (`/attesting`). Three tabs (the third since 2026-11-08). The
page asks the attestor for the staked account once per session (13.4, `AttestingService`): the picker
the moderation case page has, filled from `/list-anos-accounts`, the first
spending account picked; the choice signs every validator read, keyholder
pull and sign-off until the tab closes.

The Trades tab: the `assistedAnosTransfer` rows of `/list-assisted-transfers`
from the default validator (since 2026-11-08 the list carries the
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

**Recovery case** (`/attesting/recovery/:caseId`, 2026-11-08, break-glass
plan 1 step 6), from `/get-break-glass-case`, refreshed by a button and
every 15 s, the trade case's frame. Top to bottom:

- The person: public selfie, username, names, the status in words.
- The recovery: the recovery case's status in words and the moderators'
  approvals, each "username · time".
- The moves: per move the old account with its type, the new account with
  Copy, the transaction id with Copy, and what the default validator lists
  for it (`/list-assisted-transfers` matched by transaction id, read again
  on every refresh and poll): the amount, when it was made and the
  attestations in its slots, or "not listed on this validator (both
  attestations in, written, or cancelled)".
- The timeline: every event in words, as the trade case; the filing reads
  "<username> filed n moves", a sign-off "<attestor> signed n attestations
  with account …".
- Schedule: as the trade case (`/schedule-break-glass-case`).
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
  attestations the default validator does not hold yet (two per move once
  two attestors signed, from the `attestationSigned` events; the listed
  move's `attestorIds` tell which it holds) to `/attestation` one after the
  other, then `/mark-break-glass-case-sent` with the answers; "Sent" once
  the validator holds every attestation for the moves it still lists, Retry
  otherwise; the page of the attestor whose sign-off decided the case runs
  it at once.
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
- Notifications to attestors when a recovery's moves are filed, and to the
  person when the case moves (2026-11-08; masterpod 14.7): the attestor
  edition lists the cases, the person's wallet reads them.

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
