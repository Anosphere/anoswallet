/**
 * An account id in short form (wallet spec 8.2): the first 8 characters, an
 * ellipsis, the last 4, "a1b2c3d4…e5f6". Used by the account cards, the
 * Home to-do lines and the history rows; the pinned listing card keeps its
 * own copy.
 */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
