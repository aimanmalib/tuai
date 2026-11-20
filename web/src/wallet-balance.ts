// The numbers of the wallet balance chip (wallet-balance-view.ts): BCH and reward tokens held by the wallet addresses
// this page derived from the shared keys. Pure: no DOM, no network.
import { formatUnits, type ElectrumUtxo } from './model.ts';

export interface WalletBalance {
  sats: bigint;
  /** Fungible amount of the reward category. */
  tokens: bigint;
  /** Distinct coins counted. */
  coins: number;
}

/** Sums every scanned address; a coin listed under two entries (an address scanned twice) counts once. */
export function sumBalance(lists: readonly (readonly ElectrumUtxo[])[], rewardCategory: string): WalletBalance {
  const seen = new Set<string>();
  let sats = 0n;
  let tokens = 0n;
  for (const list of lists) {
    for (const u of list) {
      const key = `${u.tx_hash}:${u.tx_pos}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sats += BigInt(u.value);
      if (u.token_data?.category === rewardCategory) tokens += BigInt(u.token_data.amount);
    }
  }
  return { sats, tokens, coins: seen.size };
}

/** Satoshis as BCH, eight decimals with trailing zeros trimmed. */
export const satsToBch = (sats: bigint, locale = 'en'): string => formatUnits(sats, 8, locale);
