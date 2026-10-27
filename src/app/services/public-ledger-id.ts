import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The public ledger id (PLID) and the lookup id, exactly as
 * docs/public-ledger-id.md makes them. Pure functions; the only
 * implementation. Nothing here keeps state: the answers come in, the two
 * ids go out, and the caller drops the answers.
 */

/** The nine fields, in the order of section 1. */
export const IDENTITY_FIELDS = [
  'firstname', 'lastname', 'fatherfirstname', 'fatherlastname',
  'motherfirstname', 'mothermaidenname', 'city', 'country', 'date',
] as const;

export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** The five fields that allow Unknown (section 1). */
export const UNKNOWN_ALLOWED: readonly IdentityField[] = ['fatherfirstname', 'fatherlastname', 'motherfirstname', 'mothermaidenname', 'city'];

/** The literal an Unknown field becomes. */
export const UNKNOWN = 'unknown';

/** The version label at the head of the assembled string (section 4). */
export const PLID_LABEL = 'ANOS_PLID_V2';

/** The label at the head of the lookup id's input (section 6). */
export const LOOKUP_LABEL = 'ANOS_LOOKUP_V1';

/** The answers as the form hands them over: the seven texts (or `unknown`), the alpha-2 country code, the date from the picker. */
export interface IdentityAnswers {
  firstname: string;
  lastname: string;
  fatherfirstname: string;
  fatherlastname: string;
  motherfirstname: string;
  mothermaidenname: string;
  city: string;
  country: string;
  date: Date;
}

/** The two ids, 64 lowercase hex characters each. */
export interface IdentityIds {
  publicLedgerId: string;
  lookupId: string;
}

/** The bar character no field may contain (section 1). */
export const BAR = '|';

/**
 * Section 3: NFKC; every \s character to U+0020, runs to one space, trimmed;
 * toLowerCase; nothing else.
 */
export function normaliseText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .toLowerCase();
}

/** Section 2: the picker's Date as DD/MM/YYYY in the browser's local calendar, zero padded. Never UTC. */
export function formatDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  return `${dd}/${mm}/${yyyy}`;
}

/** The normalised ten parts (section 3): the seven texts, the country code lowercased, the date formatted. */
export function normaliseAnswers(answers: IdentityAnswers): Record<IdentityField, string> {
  return {
    firstname: normaliseText(answers.firstname),
    lastname: normaliseText(answers.lastname),
    fatherfirstname: normaliseText(answers.fatherfirstname),
    fatherlastname: normaliseText(answers.fatherlastname),
    motherfirstname: normaliseText(answers.motherfirstname),
    mothermaidenname: normaliseText(answers.mothermaidenname),
    city: normaliseText(answers.city),
    country: answers.country.trim().toLowerCase(),
    date: formatDate(answers.date),
  };
}

/** Section 4: the ten parts joined with a bar, no trailing bar. */
export function assemble(normalised: Record<IdentityField, string>): string {
  return [PLID_LABEL, ...IDENTITY_FIELDS.map((field) => normalised[field])].join(BAR);
}

/** scrypt of section 5 over the UTF-8 bytes of the assembled string: salt empty, N 16384, r 8, p 1, dkLen 32, maxmem 64 MiB. Hex. */
export function publicLedgerIdOf(assembled: string): string {
  const bytes = scrypt(utf8ToBytes(assembled), new Uint8Array(0), { N: 16384, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024 });
  return bytesToHex(bytes);
}

/** Section 6: SHA-256(UTF-8("ANOS_LOOKUP_V1|" + plidHex[0..16) + "|" + firstname + "|" + lastname)), the normalised names. Hex. */
export function lookupIdOf(publicLedgerIdHex: string, firstname: string, lastname: string): string {
  return bytesToHex(sha256(utf8ToBytes([LOOKUP_LABEL, publicLedgerIdHex.slice(0, 16), firstname, lastname].join(BAR))));
}

/** The whole thing: the answers in, the assembled string and both ids out. */
export function identityIdsOf(answers: IdentityAnswers): IdentityIds & { assembled: string } {
  const normalised = normaliseAnswers(answers);
  const assembled = assemble(normalised);
  const publicLedgerId = publicLedgerIdOf(assembled);
  return { assembled, publicLedgerId, lookupId: lookupIdOf(publicLedgerId, normalised.firstname, normalised.lastname) };
}
