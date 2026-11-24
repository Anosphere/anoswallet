/**
 * The stickers of the wallet's chat (wallet spec 4.16 and 8.2, Chat;
 * 2026-11-23, forclaude/stickers-database-plan-1.md). A sticker is a
 * picture, still or moving, that the team makes. Stickers are free and
 * the same for everybody. They are kept in the masterpod's database, in
 * sets: a set has a name, and each of its stickers a number within the
 * set.
 *
 * A sticker message is an ordinary chat message whose whole text is the
 * sticker's code, "[sticker:<set>/<number>]". So the masterpod stores it
 * like any other message, encrypted, and cannot tell it from a text. A
 * reader's wallet draws the picture from that text alone: the picture's
 * address, /stickers/<set>/<number> under the wallet's own address
 * (stickerSrc), is made of the two parts of the code and needs no list.
 * Where the picture cannot be fetched, the word "Sticker" stands in its
 * place.
 *
 * The list of the sets (services/stickers.service.ts asks the masterpod
 * for it once after each login) is for what the wallet offers: the
 * stickers under the message box, and the suggestions while a person
 * types. This file holds what is done with a code and with a list. It
 * knows no set by itself.
 *
 * A set's name is 1 to 32 small letters, digits and hyphens, and a
 * sticker's number is two digits: the masterpod's rules (its spec,
 * section 28). Both stand in every message that sends the sticker, for
 * good. A picture never changes under its number, and a number is never
 * used a second time: that is what lets a phone keep a picture for a
 * year.
 */

/** One sticker as the list has it: its number, and the words that bring it up as a suggestion while a person types (small letters, any language, in one list). */
export interface StickerEntry {
  number: string;
  tags: string[];
}

/** One set of stickers: its name, and its stickers in the order the wallet draws them, at least one. The first one is also the set's small picture in the row of sets. */
export interface StickerSet {
  name: string;
  stickers: StickerEntry[];
}

/** One sticker: its set's name and its own number within the set. */
export interface Sticker {
  set: string;
  number: string;
}

/** The form of a set's name and of a sticker's number. */
const SET_NAME = /^[a-z0-9-]{1,32}$/;
const NUMBER = /^[0-9]{2}$/;

/**
 * The sets of the masterpod's answer to /list-stickers, as the wallet
 * takes them. `list` is the answer's body: { "sets": [ { "name": "bear",
 * "stickers": [ { "number": "01", "tags": ["hello", "hi"] } ] } ] }, the
 * sets in the order of their row and each set's stickers in their order.
 * Nothing in it is trusted. A set is taken when its name has the form of
 * a name, no set before it has that name, and at least one of its
 * stickers is taken. A sticker is taken when its number has the form of
 * a number and no sticker before it in its set has that number. Of a
 * sticker's tags the ones that are text are taken, each without the
 * spaces at its ends and in small letters; an empty one and one that
 * stood before are left out. Whatever else the answer holds is passed
 * over, and what is not taken is as if it were not there. Null when the
 * body is no list at all: it has no "sets" that is a list.
 */
export function readStickerSets(list: unknown): StickerSet[] | null {
  if (typeof list !== 'object' || list === null) return null;
  const given = (list as { sets?: unknown }).sets;
  if (!Array.isArray(given)) return null;
  const sets: StickerSet[] = [];
  for (const one of given as unknown[]) {
    if (typeof one !== 'object' || one === null) continue;
    const { name, stickers: entries } = one as { name?: unknown; stickers?: unknown };
    if (typeof name !== 'string' || !SET_NAME.test(name) || !Array.isArray(entries) || sets.some((s) => s.name === name)) continue;
    const stickers: StickerEntry[] = [];
    for (const each of entries as unknown[]) {
      if (typeof each !== 'object' || each === null) continue;
      const { number, tags } = each as { number?: unknown; tags?: unknown };
      if (typeof number !== 'string' || !NUMBER.test(number) || stickers.some((s) => s.number === number)) continue;
      const words = (Array.isArray(tags) ? (tags as unknown[]) : []).filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().toLowerCase());
      stickers.push({ number, tags: [...new Set(words.filter((tag) => tag !== ''))] });
    }
    if (stickers.length > 0) sets.push({ name, stickers });
  }
  return sets;
}

/** A sticker's code as the whole of a message. */
const CODE = /^\[sticker:([a-z0-9-]{1,32})\/([0-9]{2})\]$/;

/**
 * The sticker a message's text names: the whole text, the spaces around
 * it aside, is a sticker's code. Null for every other text. The answer
 * says how a message is drawn and nothing more: a person can type a code
 * by hand, and whether the masterpod has that sticker shows only when
 * its picture is fetched.
 */
export function stickerNamed(text: string): Sticker | null {
  const found = CODE.exec(text.trim());
  return found ? { set: found[1], number: found[2] } : null;
}

/** True when the list `sets` has that set and, in it, that sticker. */
export function hasSticker(sets: StickerSet[], sticker: Sticker): boolean {
  return sets.find((set) => set.name === sticker.set)?.stickers.some((entry) => entry.number === sticker.number) ?? false;
}

/** The text of the message that sends this sticker. */
export function stickerCode(sticker: Sticker): string {
  return `[sticker:${sticker.set}/${sticker.number}]`;
}

/** The address of the sticker's picture, under the wallet's own address. The wallet's server program asks the masterpod for the picture and hands it on marked to be kept for a year (server/app.js; wallet spec 4.16). */
export function stickerSrc(sticker: Sticker): string {
  return `/stickers/${sticker.set}/${sticker.number}`;
}

/** Where this phone keeps the stickers sent lately: the browser's own storage, for the phone and not for one pod. */
const RECENT_KEY = 'anopod-wallet.stickers-sent';
/** How many stickers sent lately the phone keeps. */
const RECENT_STICKERS = 24;

/** The phone's own list of the stickers sent from it, the newest first, each once: whatever names a sticker, whether or not the masterpod's list has that sticker now. Empty when none was sent yet, and when the storage is blocked. */
function keptStickers(): Sticker[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const list: Sticker[] = [];
    for (const entry of parsed) {
      const sticker = typeof entry === 'string' ? stickerNamed(`[sticker:${entry}]`) : null;
      if (sticker && !list.some((s) => s.set === sticker.set && s.number === sticker.number)) list.push(sticker);
    }
    return list.slice(0, RECENT_STICKERS);
  } catch {
    return [];
  }
}

/** The stickers sent lately from this phone, the newest first: the ones of the phone's own list that the list `sets` has. */
export function recentStickers(sets: StickerSet[]): Sticker[] {
  return keptStickers().filter((sticker) => hasSticker(sets, sticker));
}

/** Notes that a sticker was sent just now: it goes to the front of the phone's own list, which keeps the newest RECENT_STICKERS. */
export function rememberSticker(sticker: Sticker): void {
  const list = [sticker, ...keptStickers().filter((s) => s.set !== sticker.set || s.number !== sticker.number)].slice(0, RECENT_STICKERS);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.map((s) => `${s.set}/${s.number}`)));
  } catch {
    // Private mode or blocked storage: nothing is kept, and the clock does not show.
  }
}

/** How many stickers the strip of suggestions shows at most: four stand side by side on a phone, so the strip never slides. */
const SUGGESTED_STICKERS = 4;

/** A sticker to suggest, and how many characters at the end of the typed text brought it up. */
export interface Suggestion {
  sticker: Sticker;
  cut: number;
}

/**
 * The stickers of the list `sets` to suggest for what stands in the
 * message box. A sticker fits when the text ends with one of its tags,
 * whole, of two characters or more, not in the middle of an English
 * word; or when the last word typed, of three characters or more, is the
 * beginning of one of its tags. Nothing while the text is empty or ends
 * in a space. At most `limit` stickers, in this order: first the ones in
 * `recent`, the stickers sent lately from this phone, as that list has
 * them; then the ones a whole tag fits, before the ones only a tag's
 * beginning fits; and within each of those two, one from every set in
 * turn, in the order of the sets and of a set's own list, so that no set
 * fills the strip.
 */
export function suggestedStickers(sets: StickerSet[], text: string, recent: Sticker[] = [], limit = SUGGESTED_STICKERS): Suggestion[] {
  const lower = text.toLowerCase();
  if (lower === '' || /\s$/.test(lower)) return [];
  const token = lower.split(/\s+/).pop() ?? '';
  const long = Array.from(token).length >= 3;
  const whole: Suggestion[][] = [];
  const begun: Suggestion[][] = [];
  for (const set of sets) {
    const wholeHere: Suggestion[] = [];
    const begunHere: Suggestion[] = [];
    for (const entry of set.stickers) {
      let cut = 0;
      let fitsWhole = false;
      for (const tag of entry.tags) {
        if (long && tag.startsWith(token)) cut = Math.max(cut, token.length);
        const before = lower[lower.length - tag.length - 1];
        if (Array.from(tag).length >= 2 && lower.endsWith(tag) && (before === undefined || !/[a-z0-9]/.test(before))) {
          cut = Math.max(cut, tag.length);
          fitsWhole = true;
        }
      }
      if (cut > 0) (fitsWhole ? wholeHere : begunHere).push({ sticker: { set: set.name, number: entry.number }, cut });
    }
    whole.push(wholeHere);
    begun.push(begunHere);
  }
  const inTurn = (lists: Suggestion[][]): Suggestion[] => {
    const out: Suggestion[] = [];
    for (let i = 0; lists.some((list) => i < list.length); i += 1) for (const list of lists) if (i < list.length) out.push(list[i]);
    return out;
  };
  const all = [...inTurn(whole), ...inTurn(begun)];
  const first = recent.flatMap((r) => all.filter((s) => s.sticker.set === r.set && s.sticker.number === r.number));
  return [...first, ...all.filter((s) => !first.includes(s))].slice(0, limit);
}
