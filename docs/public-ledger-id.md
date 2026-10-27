# The public ledger id

How the wallet turns a person's birth record into the 32-byte public ledger
id (PLID) the keyholders store, and the lookup id a moderator or the home
computer finds the person by. This is the spec for this wallet, the only
implementation. It replaces the "ANOS PUBLIC LEDGER ID SPECIFICATION
Version 2" of an earlier project (64-byte output, several platforms): the
same fields, normalisation and scrypt parameters, the output cut to 32
bytes so a keyholder stores it as it is, and the two ambiguities of that
document settled (lowercase, not case folding; the whitespace set named).

## 1. The nine fields

    field             asked as               Unknown allowed
    firstname         First name             no
    lastname          Last name              no
    fatherfirstname   Father's first name    yes
    fatherlastname    Father's last name     yes
    motherfirstname   Mother's first name    yes
    mothermaidenname  Mother's maiden name   yes
    city              City of birth          yes
    country           Country of birth       no    a select of ISO 3166-1 alpha-2 codes
    date              Date of birth          no    a date picker, never free text

Unknown: the field has a Known / Unknown select beside it. Unknown makes
the value the literal string `unknown`, lowercase, which nobody types.
The form tells people to write what is on their birth certificate the way
it is commonly written today, and that during a recovery variants can be
tried, so the more exact the easier.

No field may contain the bar character `|` (U+007C); the form refuses it.

## 2. The date

Taken from the date picker as three numbers in the browser's local
calendar: day, month, year (getDate, getMonth + 1 and getFullYear on the
Date the picker hands over). Never through toISOString or UTC. Written
DD/MM/YYYY with zero padding: 05/09/1987. A time zone cannot change it.

## 3. Normalising a text field, in this order

1. Unicode NFKC: value.normalize('NFKC').
2. Whitespace: every character of the JavaScript regular expression class
   \s becomes U+0020. That class is U+0009 to U+000D, U+0020, U+00A0,
   U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and
   U+FEFF. Then runs of spaces become one space, and leading and trailing
   spaces are removed.
3. Lowercase: value.toLowerCase(), the Unicode-aware lowercase every
   platform has. Not case folding: ß stays ß.
4. Nothing else. No diacritics stripped, no homoglyphs merged, no
   punctuation touched, no digit systems changed. "St. Louis" and
   "Saint Louis" are different values, on purpose.

The seven name and city fields go through all four steps, `unknown`
included (it is already normalised). The country is the alpha-2 code
lowercased: `us`. The date is used as section 2 formats it.

## 4. Assembly

The ten parts joined with `|`, no trailing bar, as UTF-8 without a BOM:

    ANOS_PLID_V2|firstname|lastname|fatherfirstname|fatherlastname|motherfirstname|mothermaidenname|city|country|date

## 5. The key derivation

scrypt over those bytes with every parameter explicit: salt empty (zero
bytes), N 16384, r 8, p 1, dkLen 32, maxmem 64 MiB. In the wallet: scrypt
from @noble/hashes/scrypt. Node's crypto.scrypt with the same parameters
gives the same bytes (checked in the build, section 8).

Output: 32 bytes, written as 64 lowercase hex characters. That is the
publicLedgerId every /receive-share carries, and what owners.public_ledger_id
holds under the KMS on each keyholder.

## 6. The lookup id

    lookupId = SHA-256( UTF-8( "ANOS_LOOKUP_V1|" + plidHex[0..16) + "|" + firstname + "|" + lastname ) )

plidHex[0..16) is the first 16 hex characters of the PLID, its first 8
bytes. firstname and lastname are the normalised values of section 3. The
result is 32 bytes, 64 hex characters. A moderator or the home computer
with the person's answers recomputes both ids.

## 7. Where the two ids go, and where they do not

- To the five keyholders, in every share deposit (the publicLedgerId and
  lookupId fields of /receive-share). The first deposit writes the owners
  row there.
- To the masterpod once, at setup, inside identityBlob: PLID || lookupId
  (64 bytes) encrypted under the anoPod encryption key. /unlock hands it
  back and the phone opens it. The masterpod cannot read it.
- Nowhere else. The form's answers stay in RAM until the review step is
  confirmed and are dropped once the two ids exist. Nothing goes to
  browser storage.

## 8. Test vector

Computed 2026-10-25 with `scrypt` from `@noble/hashes/scrypt.js` (the
wallet's library, run under Node on the same code the browser bundles) and
checked against `node:crypto`'s `scryptSync` with the same parameters: the
same 32 bytes; the lookup id likewise with `@noble/hashes` SHA-256 and
`node:crypto`. The answers were chosen to exercise every rule of section 3:
leading, trailing and doubled spaces, a no-break space (U+00A0), a decomposed
accent (e + U+0301, NFKC composes it), uppercase, a hyphen, a period and a
curly apostrophe (U+2019) left alone, and one field Unknown.

    field             as typed                       normalised
    firstname         "  JOSÉ  María "  (É as E + U+0301)   josé maría
    lastname          "Müller-Smith"                 müller-smith
    fatherfirstname   "Jean"                         jean
    fatherlastname    Unknown                        unknown
    motherfirstname   "Ana Luisa"  (U+00A0 between)  ana luisa
    mothermaidenname  "O’Brien"  (U+2019)            o’brien
    city              "St. Louis"                    st. louis
    country           US                             us
    date              5 September 1987 (local)       05/09/1987

Assembled (one line, UTF-8, no BOM):

    ANOS_PLID_V2|josé maría|müller-smith|jean|unknown|ana luisa|o’brien|st. louis|us|05/09/1987

PLID (scrypt, salt empty, N 16384, r 8, p 1, dkLen 32, maxmem 64 MiB):

    2fe661dbbc5c0c8c20ecb6a81c4988e7f7d59f62fb3ba0858e74e9da3e47c2b8

Lookup id input and result:

    ANOS_LOOKUP_V1|2fe661dbbc5c0c8c|josé maría|müller-smith
    d2591b682e6795188c8d9004bcccc0dbc08dce6a938b00c789c45611fd585bdb

The wallet's implementation is `src/app/services/public-ledger-id.ts`;
`identityIdsOf(answers)` on these answers gives the same assembled string
and both ids. The check in the browser itself happens on the identity
page, which runs that file.
