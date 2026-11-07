import type { AnosAccountItem } from './services/session.service';

/**
 * The accounts' names by id (wallet spec 8.2, Wallet). For each type, the
 * accounts of that type in list order (the masterpod lists oldest first):
 * one of a type reads "Spending account" (the type's words from the
 * dictionary, `kinds`, wallet spec 8.8; a type it does not know reads the
 * type word, then "account"); two or more read "Spending account 1",
 * "Spending account 2", and so on. Used by the Wallet page's cards, the
 * Home to-do lines and the history page's subtitle.
 */
export function accountNames(accounts: AnosAccountItem[], kinds: Record<string, string>): Map<string, string> {
  const ofType = new Map<string, AnosAccountItem[]>();
  for (const account of accounts) {
    const list = ofType.get(account.accountType) ?? [];
    list.push(account);
    ofType.set(account.accountType, list);
  }
  const names = new Map<string, string>();
  for (const [type, list] of ofType) {
    const word = kinds[type] ?? `${type} account`;
    list.forEach((account, index) => names.set(account.accountId, list.length === 1 ? word : `${word} ${index + 1}`));
  }
  return names;
}
