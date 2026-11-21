// Address discovery for a connected wallet (docs/decisions/0012-wallet-claims.md, "Address discovery"): a fake
// wallet derives addresses by (path, index) and a fake chain answers each batch, so the scan's stopping rule, the
// gap limit and the change address are checked without a network. The page text never asks the user for money.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activityOf, scanWallet, walletForRelay, type AddressActivity, type KeyPath, type ScanOptions } from '../web/src/wallet-scan.ts';
import type { WalletAddress } from '../web/src/wallet-check.ts';
import { fakeWallet } from './helpers/fake-wallet.ts';
import { config } from './helpers/relay-fixture.ts';

const W = config.relay.wallet;
const wallet = fakeWallet('scan');
const cache = new Map<string, WalletAddress>();
const addr = (path: KeyPath, index: number): WalletAddress => {
  const id = `${path} ${index}`;
  let a = cache.get(id);
  if (!a) {
    const k = wallet.key(path, index);
    a = { address: k.address, lockingBytecode: k.lockingBytecode, path, index };
    cache.set(id, a);
  }
  return a;
};

interface Chain {
  /** Addresses with history but no coins. */
  history?: [KeyPath, number][];
  /** Coins without tokens, in satoshis. */
  coins?: [KeyPath, number, bigint][];
  /** Addresses holding only a token coin. */
  tokensOnly?: [KeyPath, number][];
}

function world(chain: Chain, o: Partial<Pick<ScanOptions, 'gapLimit' | 'maxAddressesPerScan'>> & { paths?: KeyPath[] } = {}) {
  const answers = new Map<string, AddressActivity>();
  for (const [p, i] of chain.history ?? []) answers.set(addr(p, i).address, { used: true, sats: 0n });
  for (const [p, i] of chain.tokensOnly ?? []) answers.set(addr(p, i).address, activityOf([], [{ value: 1000, token_data: { amount: '5' } }]));
  for (const [p, i, sats] of chain.coins ?? []) answers.set(addr(p, i).address, { used: true, sats });
  const calls: string[][] = [];
  const paths = o.paths ?? ['receive', 'change'];
  const options: ScanOptions = {
    derive: (path, index) => (paths.includes(path) ? addr(path, index) : undefined),
    lookup: async (addresses) => {
      calls.push([...addresses]);
      return addresses.map((a) => answers.get(a) ?? { used: false, sats: 0n });
    },
    gapLimit: o.gapLimit ?? W.gapLimit,
    maxAddressesPerScan: o.maxAddressesPerScan ?? W.maxAddressesPerScan,
  };
  return { options, calls };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('wallet address scan', () => {
  it('uses the gap limit and scan cap from config, not fixed numbers', () => {
    expect(W.gapLimit).toBeGreaterThanOrEqual(1);
    expect(W.maxAddressesPerScan).toBeGreaterThanOrEqual(W.gapLimit);
    expect(W.maxAddresses).toBeGreaterThanOrEqual(2);
    // The old fixed count of addresses is gone: these are all the wallet settings.
    expect(Object.keys(W).sort()).toEqual(
      ['enabled', 'gapLimit', 'maxAddresses', 'maxAddressesPerScan', 'maxBodyBytes', 'maxPreparesPerHour', 'maxSpendSats', 'preparePath', 'relayUrls'].sort(),
    );
  });

  it('(a) finds coins on the 25th receive address after 24 used ones, and the next receive address is the 26th', async () => {
    const { options } = world({ history: range(0, 24).map((i) => ['receive', i]), coins: [['receive', 24, 7_000n]] });
    const r = await scanWallet(options);
    expect(r.funded.map((f) => [f.path, f.index, f.sats])).toEqual([['receive', 24, 7_000n]]);
    expect(r.receive).toMatchObject({ path: 'receive', index: 25 });
    expect(r.used).toHaveLength(25);
  });

  it('(b) finds coins on the change path, and the change address is the first unused change address', async () => {
    const { options } = world({ history: range(0, 7).map((i) => ['change', i]), coins: [['change', 7, 4_500n]] });
    const r = await scanWallet(options);
    expect(r.funded.map((f) => [f.path, f.index])).toEqual([['change', 7]]);
    expect(r.change).toMatchObject({ path: 'change', index: 8 });
    expect(r.receive).toMatchObject({ path: 'receive', index: 0 });
  });

  it('(c) crosses a gap shorter than the limit: used at 0 and at 20 with coins', async () => {
    const { options } = world({ history: [['receive', 0]], coins: [['receive', 20, 3_000n]] });
    const r = await scanWallet(options);
    expect(r.funded.map((f) => f.index)).toEqual([20]);
    expect(r.receive).toMatchObject({ index: 1 });
    expect(r.scanned.receive).toBeGreaterThanOrEqual(20 + W.gapLimit);
  });

  it('(d) stops after gapLimit unused addresses in a row, so coins after a full gap are not seen (BIP44 behaviour)', async () => {
    const { options } = world({ coins: [['receive', W.gapLimit, 9_000n]] });
    const r = await scanWallet(options);
    expect(r.funded).toEqual([]);
    expect(r.scanned).toEqual({ receive: W.gapLimit, change: W.gapLimit });
    expect(r.stoppedAtCap).toBe(false);
  });

  it('(e) never derives more than maxAddressesPerScan on a path and says it stopped at the cap', async () => {
    const { options, calls } = world({ history: range(0, 30).map((i) => ['receive', i]) }, { gapLimit: 5, maxAddressesPerScan: 12 });
    const r = await scanWallet(options);
    expect(r.scanned.receive).toBe(12);
    expect(r.stoppedAtCap).toBe(true);
    expect(calls.flat().filter((a) => addr('receive', 12).address === a)).toEqual([]);
  });

  it('(f) a wallet without a change key pays change to its first unused receive address', async () => {
    const { options } = world({ history: [['receive', 0]], coins: [['receive', 1, 5_000n]] }, { paths: ['receive'] });
    const r = await scanWallet(options);
    expect(r.scanned.change).toBe(0);
    expect(r.change).toMatchObject({ path: 'receive', index: 2 });
    expect(r.change).toEqual(r.receive);
  });

  it('(g) an address holding only token coins is used but not funded', async () => {
    const { options } = world({ tokensOnly: [['receive', 0]], coins: [['receive', 1, 2_000n], ['change', 3, 8_000n]] });
    const r = await scanWallet(options);
    expect(r.funded.map((f) => [f.path, f.index])).toEqual([
      ['change', 3],
      ['receive', 1],
    ]);
    expect(r.used.map((u) => u.index)).toContain(0);
    expect(activityOf([], [{ value: 1000, token_data: { amount: '1' } }])).toEqual({ used: true, sats: 0n });
    expect(activityOf([{ tx_hash: 'aa', height: 1 }], [])).toEqual({ used: true, sats: 0n });
  });

  it('(h) looks addresses up in batches: at most ceil(scanned / gapLimit) calls per path, each of at most gapLimit', async () => {
    const { options, calls } = world({ history: range(0, 24).map((i) => ['receive', i]), coins: [['change', 2, 1_000n]] });
    const r = await scanWallet(options);
    const receiveCalls = calls.filter((c) => cacheHas('receive', c[0]!));
    expect(receiveCalls.length).toBeLessThanOrEqual(Math.ceil(r.scanned.receive / W.gapLimit));
    expect(calls.length - receiveCalls.length).toBeLessThanOrEqual(Math.ceil(r.scanned.change / W.gapLimit));
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(W.gapLimit);
    expect(calls.flat()).toHaveLength(r.scanned.receive + r.scanned.change);
  });
});

function cacheHas(path: KeyPath, address: string): boolean {
  return [...cache.values()].some((a) => a.path === path && a.address === address);
}

describe('wallet addresses sent to the relay', () => {
  it('sends the largest funded addresses within maxAddresses, then the unused change address', () => {
    const funded = range(0, 30).map((i) => ({ ...addr('receive', i), sats: BigInt(1000 + i) }));
    const change = addr('change', 0);
    const list = walletForRelay(funded.slice().reverse(), change, W.maxAddresses);
    expect(list).toHaveLength(W.maxAddresses);
    expect(list.at(-1)).toBe(change);
    expect(list[0]).toMatchObject({ index: 29 });
  });
});

describe('wallet claim text', () => {
  // The keys that describe what the contract or this page sends, not what the user should do.
  const ALLOWED = new Set(['text', 'refused']);
  const ASKS = {
    en: /\b(send|sending|transfer|deposit|top ?up|fund|funds|needs about)\b/i,
    ms: /\b(hantar|menghantar|hantarkan|pindah|pindahkan|deposit|tambah nilai|isikan|perlukan kira-kira)\b/i,
  };
  const strings = (o: unknown, path: string[] = []): [string, string][] =>
    typeof o === 'string' ? [[path.join('.'), o]] : o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => strings(v, [...path, k])) : [];

  for (const lang of ['en', 'ms'] as const) {
    it(`never asks the user to send or add money (${lang})`, () => {
      const w = (JSON.parse(readFileSync(`lang/${lang}.json`, 'utf8')) as { web: { walletClaim: Record<string, unknown> } }).web.walletClaim;
      for (const k of ['searching', 'noCoins', 'withoutWallet']) expect(typeof w[k], k).toBe('string');
      const asking = strings(w).filter(([k, v]) => !ALLOWED.has(k.split('.')[0]!) && ASKS[lang].test(v));
      expect(asking).toEqual([]);
    });
  }
});
