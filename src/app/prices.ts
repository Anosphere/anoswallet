/**
 * Prices and totals of the marketplace (wallet spec 8.2, Marketplace;
 * 2026-11-06, section 11). A price per anos is a decimal string with up to
 * eight decimals, as the masterpod keeps it; a quantity is millionths of an
 * anos. Everything is done on the digits, never through a float, as
 * amounts.ts does amounts; the browser gives only the group and decimal
 * marks of its locale and the names of the currencies. The notes' price
 * per anos comes from here too (wallet spec 8.2; 2026-11-07).
 */

const PRICE_DECIMALS = 8;
const PRICE_UNITS = 10n ** BigInt(PRICE_DECIMALS);

/** quantity (millionths, 10^-6) times price (10^-8) is in 10^-14; cents are 10^-2. */
const PRODUCT_TO_CENTS = 10n ** 12n;

/** A price scaled to eight decimals, as a whole number: "35.5" is 3550000000n; null for anything that is not a price. */
export function priceUnits(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!match) return null;
  return BigInt(match[1]) * PRICE_UNITS + BigInt((match[2] ?? '').padEnd(PRICE_DECIMALS, '0'));
}

let cachedMarks: { group: string; decimal: string } | null = null;

/** The group and decimal marks of the browser's locale, read once. */
function marks(): { group: string; decimal: string } {
  if (!cachedMarks) {
    const parts = new Intl.NumberFormat().formatToParts(1234567.8);
    cachedMarks = {
      group: parts.find((p) => p.type === 'group')?.value ?? ',',
      decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    };
  }
  return cachedMarks;
}

/**
 * A decimal string as money: the whole part grouped by the browser's
 * locale, at least `minimumDecimals` decimals (two by default, so a price
 * reads "35.50 THB"; the decimals the string has when it has more), and the
 * currency code after the number, never a symbol. A text that is not a
 * number comes back as given, with the code.
 */
export function formatPrice(amount: string, currency: string, minimumDecimals = 2): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return `${amount} ${currency}`;
  const { group, decimal } = marks();
  const whole = match[1].replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const fraction = (match[2] ?? '').padEnd(minimumDecimals, '0');
  return `${whole}${fraction ? decimal + fraction : ''} ${currency}`;
}

/**
 * The total of a listing, quantity (millionths) times price, rounded to two
 * decimals on the digits: "3550" for 100 anos at 35.50, "3554.38" for
 * 100.123456 anos at 35.50. A whole total has no decimals, any other has
 * two, so formatPrice(total, currency, 0) reads "3,550 THB" or "3,554.38
 * THB". "0" for a price that is not one.
 */
export function totalOf(quantityMillionths: string | bigint, price: string): string {
  const units = priceUnits(price);
  if (units === null) return '0';
  const product = BigInt(quantityMillionths) * units;
  const cents = (product + PRODUCT_TO_CENTS / 2n) / PRODUCT_TO_CENTS;
  const whole = cents / 100n;
  const rest = cents % 100n;
  return rest === 0n ? `${whole}` : `${whole}.${rest.toString().padStart(2, '0')}`;
}

/**
 * The price per anos behind a total: `money` (a decimal string, up to eight
 * decimals) over `amountMillionths` anos, rounded down to eight decimals on
 * the digits, trailing zeros trimmed: "35.5" for 3550 over 100 anos. Null
 * when the money is not a number or the amount is zero.
 */
export function perAnosOf(money: string, amountMillionths: string | bigint): string | null {
  const units = priceUnits(money);
  const amount = BigInt(amountMillionths);
  if (units === null || amount === 0n) return null;
  const per = (units * 1_000_000n) / amount;
  const whole = per / PRICE_UNITS;
  const rest = per % PRICE_UNITS;
  if (rest === 0n) return `${whole}`;
  return `${whole}.${rest.toString().padStart(PRICE_DECIMALS, '0').replace(/0+$/, '')}`;
}

/**
 * { code, name } for the currency picker: every currency the browser knows
 * (Intl.supportedValuesOf) with its name in the app's language (`tag`, the
 * language service's locale tag, wallet spec 8.8), sorted by code. A browser
 * without supportedValuesOf gives an empty list, and the picker then takes
 * a typed three-letter code.
 */
export function currencyOptions(tag: string): { code: string; name: string }[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf !== 'function') return [];
  try {
    const names = new Intl.DisplayNames([tag], { type: 'currency' });
    return intl
      .supportedValuesOf('currency')
      .map((code) => ({ code, name: names.of(code) ?? code }))
      .sort((a, b) => a.code.localeCompare(b.code));
  } catch {
    return [];
  }
}
