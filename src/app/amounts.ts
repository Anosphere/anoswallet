import { MILLIONTHS_PER_ANOS } from './constants';

/**
 * Amounts on the wire are millionths of an anos as a decimal string; the
 * forms take anos with up to six decimal places. Done on the digits, never
 * through a float.
 */

/** "1", "0.5", "2.25" to millionths; null for anything else or zero. */
export function anosToMillionths(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  const millionths = BigInt(whole) * MILLIONTHS_PER_ANOS + BigInt(fraction.padEnd(6, '0'));
  return millionths > 0n ? millionths : null;
}

/** Millionths as a decimal string to anos, trailing zeros of the fraction dropped: "1500000" is "1.5". */
export function millionthsToAnos(millionths: string | bigint): string {
  const value = BigInt(millionths);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / MILLIONTHS_PER_ANOS;
  const fraction = (abs % MILLIONTHS_PER_ANOS).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? '.' + fraction : ''}`;
}
