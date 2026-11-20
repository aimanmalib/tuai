// The balance chip of a connected wallet: BCH and reward tokens summed over the scanned addresses, each coin once.
import { describe, expect, it } from 'vitest';
import { satsToBch, sumBalance } from '../web/src/wallet-balance.ts';
import type { ElectrumUtxo } from '../web/src/model.ts';

const REWARD = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

const coin = (n: number, value: number, token?: { category: string; amount: string; nft?: { capability: string; commitment: string } }): ElectrumUtxo => ({
  tx_hash: n.toString(16).padStart(64, '0'),
  tx_pos: n % 3,
  height: 1000 + n,
  value,
  ...(token ? { token_data: token } : {}),
});

describe('wallet balance', () => {
  it('adds BCH over every address and only the reward category for tokens', () => {
    const receive = [coin(1, 50_000), coin(2, 1_000, { category: REWARD, amount: '1250' })];
    const change = [coin(3, 800, { category: OTHER, amount: '99' }), coin(4, 1_000, { category: REWARD, amount: '250' })];
    expect(sumBalance([receive, change], REWARD)).toEqual({ sats: 52_800n, tokens: 1_500n, coins: 4 });
  });

  it('counts a coin once when the same address was scanned twice', () => {
    const list = [coin(1, 10_000), coin(2, 1_000, { category: REWARD, amount: '700' })];
    expect(sumBalance([list, [...list], list], REWARD)).toEqual({ sats: 11_000n, tokens: 700n, coins: 2 });
  });

  it('treats two outputs of one transaction as two coins', () => {
    const a = coin(5, 3_000);
    const b = { ...a, tx_pos: a.tx_pos + 1 };
    expect(sumBalance([[a, b]], REWARD).sats).toBe(6_000n);
  });

  it('adds nothing for an NFT without a fungible amount', () => {
    const receipt = coin(6, 1_000, { category: REWARD, amount: '0', nft: { capability: 'none', commitment: '00' } });
    expect(sumBalance([[receipt]], REWARD)).toEqual({ sats: 1_000n, tokens: 0n, coins: 1 });
  });

  it('keeps token amounts above 2^53 exact', () => {
    const big = coin(7, 1_000, { category: REWARD, amount: '9007199254740993' });
    expect(sumBalance([[big, coin(8, 1_000, { category: REWARD, amount: '1' })]], REWARD).tokens).toBe(9_007_199_254_740_994n);
  });

  it('is empty for a wallet with no coins', () => {
    expect(sumBalance([[], []], REWARD)).toEqual({ sats: 0n, tokens: 0n, coins: 0 });
  });

  it('shows satoshis as BCH with trailing zeros trimmed', () => {
    expect(satsToBch(52_800n)).toBe('0.000528');
    expect(satsToBch(123_456_789_000n)).toBe('1,234.56789');
    expect(satsToBch(0n)).toBe('0');
  });
});
