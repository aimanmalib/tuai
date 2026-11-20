// Legacy BTC leaves (link method 2, ADR 0015). Every address here is generated from a test hash; no real user data.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binToHex, encodeBase58Address, hexToBin } from '@bitauth/libauth';
import { sha256 } from '../src/bytes.ts';
import { buildEpoch } from '../src/epoch/build.ts';
import { readEpochFile } from '../src/epoch/file.ts';
import { DistroEntriesError, distroToAllocations, type DistroResponse } from '../src/epoch/inputs.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { LinkMethod, lockingBytecodeToAddress } from '../src/leaf.ts';
import { LegacyBtcAddressError, legacyBtcToLockingBytecode, lockingBytecodeToLegacyBtc } from '../src/leaf-legacy.ts';
import { checkLinks, legacyAddressesInFahSummary, addressesInFahSummary } from '../src/watch/fah.ts';
import { eachFahLine } from '../src/watch/fah-file.ts';
import { loadConfig, validateConfig } from '../src/config.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

const hash = (label: string): Uint8Array => sha256(new TextEncoder().encode(label)).slice(0, 20);
const legacy = (label: string): string => encodeBase58Address('p2pkh', hash(label));
const script = (label: string): string => `76a914${binToHex(hash(label))}88ac`;
const cashAddr = (label: string): string => lockingBytecodeToAddress(hexToBin(script(label)), 'bitcoincash');
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

let dir: string | undefined;
let fixture: CliFixture | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  fixture?.cleanup();
  dir = undefined;
  fixture = undefined;
});

describe('legacy BTC address to leaf script', () => {
  it('maps a P2PKH address to the same hash160 script (zero hash vector)', () => {
    // Base58Check of version 0x00 and twenty zero bytes; the script is OP_DUP OP_HASH160 <0x00*20> OP_EQUALVERIFY OP_CHECKSIG.
    expect(legacyBtcToLockingBytecode('1111111111111111111114oLvT2')).toBe(`76a914${'00'.repeat(20)}88ac`);
    expect(legacyBtcToLockingBytecode(legacy('alice'))).toBe(script('alice'));
    expect(lockingBytecodeToLegacyBtc(script('alice'))).toBe(legacy('alice'));
    expect(lockingBytecodeToLegacyBtc('a914' + '00'.repeat(20) + '87')).toBeUndefined();
  });

  it('refuses a corrupted checksum, a P2SH address and a bech32 address by name', () => {
    const good = legacy('bob');
    const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    const reason = (a: string) => {
      try {
        legacyBtcToLockingBytecode(a);
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(LegacyBtcAddressError);
        return (e as LegacyBtcAddressError).reason;
      }
    };
    expect(reason(bad)).toBe('checksum');
    expect(reason(encodeBase58Address('p2sh20', hash('bob')))).toBe('p2sh');
    expect(reason('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe('bech32');
    expect(reason(encodeBase58Address('p2pkhTestnet', hash('bob')))).toBe('version');
    expect(reason('not an address')).toBe('format');
  });
});

describe('distribution responses with all user types', () => {
  it('gives CashTokens entries the default method and legacy BTC entries method 2', () => {
    const response: DistroResponse = {
      success: true,
      distro: [
        { amount: 1.5, cashTokensAddress: cashAddr('carol'), bitcoinAddress: null },
        { amount: 0.25, bitcoinAddress: legacy('dave'), cashTokensAddress: null },
      ],
    };
    expect(distroToAllocations(response, LinkMethod.fahName)).toEqual([
      { lockingBytecode: script('carol'), method: 0, amount: 150_000_000n },
      { lockingBytecode: script('dave'), method: 2, amount: 25_000_000n },
    ]);
  });

  it('lists every refused entry instead of stopping at the first or skipping it', () => {
    const response: DistroResponse = {
      distro: [
        { amount: 1, bitcoinAddress: legacy('erin') },
        { amount: 1, bitcoinAddress: encodeBase58Address('p2sh20', hash('frank')) },
        { amount: 1, cashTokensAddress: null, bitcoinAddress: null },
      ],
    };
    let error: DistroEntriesError | undefined;
    try {
      distroToAllocations(response, 0);
    } catch (e) {
      error = e as DistroEntriesError;
    }
    expect(error).toBeInstanceOf(DistroEntriesError);
    expect(error?.rejected.map((r) => [r.index, r.reason])).toEqual([[1, 'p2sh'], [2, 'no CashTokens or legacy BTC address']]);
  });

  it('adds a recipient that appears in two windows into one leaf and verifies the epoch', () => {
    dir = mkdtempSync(join(tmpdir(), 'tuai-legacy-'));
    const out = join(dir, 'epoch-1.json');
    const october = { success: true, distro: [{ amount: 2, bitcoinAddress: legacy('gina') }, { amount: 1, cashTokensAddress: cashAddr('hal') }] };
    const november = { success: true, distro: [{ amount: 0.5, bitcoinAddress: legacy('gina') }] };
    const file = buildEpoch({
      network: 'chipnet', prefix: 'bchtest', maxDepth: 9, defaultMethod: 0, decimals: 8, outPath: out,
      sources: [{ bytes: enc(october) }, { bytes: enc(november) }],
    });
    const gina = file.leaves.find((l) => l.lockingBytecode === script('gina'));
    expect(gina).toMatchObject({ method: 2, cumulative: '250000000' });
    expect(file.leaves).toHaveLength(2);
    expect(verifyEpoch(out).ok).toBe(true);
  });
});

describe('watcher check of legacy BTC leaves', () => {
  function epochWithLegacy(): string {
    dir = mkdtempSync(join(tmpdir(), 'tuai-legacy-'));
    const out = join(dir, 'epoch-1.json');
    const distro = ['ivy', 'jo', 'kim'].map((l) => ({ amount: 1, bitcoinAddress: legacy(l) }));
    buildEpoch({
      network: 'chipnet', prefix: 'bchtest', maxDepth: 9, defaultMethod: 0, decimals: 8, outPath: out,
      sources: [{ bytes: enc({ success: true, distro: [...distro, { amount: 1, cashTokensAddress: cashAddr('lee') }] }) }],
    });
    return out;
  }
  const summary = (...names: string[]) =>
    ['Wed Nov 18 03:31:00 GMT 2026', 'name\tnewcredit\tsum(total)\tteam', ...names.map((n) => `${n}\t10\t1\t0`)].join('\n');

  it('finds an address that is the whole name or an underscore separated part', () => {
    const fah = summary(legacy('ivy'), `folder_ALL_${legacy('jo')}`, `x_FLDC_${legacy('kim')}`);
    const r = checkLinks(readEpochFile(epochWithLegacy()), addressesInFahSummary(fah), legacyAddressesInFahSummary(fah));
    expect(r.legacy).toEqual({ checked: 3, found: 3, missing: [] });
    expect(r.mappingOnly).toBe(0);
  });

  it('reports a legacy leaf whose address is in no name, and does not accept the CashAddr form instead', async () => {
    const path = epochWithLegacy();
    const kimCash = cashAddr('kim').replace('bitcoincash:', '');
    const text = summary(legacy('ivy'), `folder_ALL_${legacy('jo')}x`, `x_${kimCash}`);
    const fahPath = join(dir as string, 'summary.txt');
    writeFileSync(fahPath, text);
    const legacyMap = new Map<string, string[]>();
    const { addLegacyFahLine } = await import('../src/watch/fah.ts');
    await eachFahLine(fahPath, (line) => addLegacyFahLine(legacyMap, line));
    const r = checkLinks(readEpochFile(path), addressesInFahSummary(text), legacyMap);
    expect(r.legacy.checked).toBe(3);
    expect(r.legacy.found).toBe(1);
    expect(r.legacy.missing.map((m) => m.address).sort()).toEqual([legacy('jo'), legacy('kim')].sort());
  });

  it('prints the legacy count through the watch command', async () => {
    const path = epochWithLegacy();
    const fahPath = join(dir as string, 'summary.txt');
    writeFileSync(fahPath, summary(legacy('ivy'), `a_${legacy('jo')}`));
    fixture = cliFixture();
    const r = await fixture.run('watch', '--network', 'mock', '--epoch', path, '--fah', fahPath);
    expect(r.code).toBe(1);
    const links = r.json?.links as { legacy: { checked: number; found: number } };
    expect(links.legacy).toMatchObject({ checked: 3, found: 2 });
    expect(r.json?.legacySummary).toMatch(/2 of 3/);
    expect((r.json?.findings as string[]).join(' ')).toContain(legacy('kim'));
  });
});

describe('real epoch query', () => {
  it('keeps the production query and requires real epoch windows in order', () => {
    const c = loadConfig();
    expect(c.sponsorApi.includeFoldingUserTypes).toBe(8);
    expect(c.sponsorApi.realEpoch.windows.length).toBeGreaterThanOrEqual(2);
    expect(validateConfig(c)).toEqual([]);
    const bad = structuredClone(c);
    bad.sponsorApi.realEpoch.windows = [{ startDate: '2026-11-02T00:00:00Z', endDate: '2026-11-01T00:00:00Z' }];
    expect(validateConfig(bad).join(' ')).toMatch(/realEpoch window/);
  });

  it('builds with --real: one cached request per window, all user types, legacy leaves get method 2', async () => {
    const urls: string[] = [];
    let clock = Date.parse('2026-11-20T12:00:00Z');
    const body = (i: number) =>
      JSON.stringify({ success: true, distro: [{ amount: 1, bitcoinAddress: legacy(`w${i}`) }, { amount: 1, bitcoinAddress: legacy('both') }] });
    const fakeFetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(body(urls.length), { status: 200 });
    }) as unknown as typeof fetch;
    fixture = cliFixture({ fetch: fakeFetch, now: () => new Date(clock) });
    const out = join(fixture.dir, 'epoch-real.json');
    const first = await fixture.run('epoch', 'build', '--network', 'mock', '--source', 'api', '--real', '--out', out);
    expect(first.text).toMatch(/retry after/);
    clock += 61_000;
    const second = await fixture.run('epoch', 'build', '--network', 'mock', '--source', 'api', '--real', '--out', out);
    expect(second.code).toBe(0);
    expect(second.json?.fromCache).toEqual([true, false]);
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.includes('includeFoldingUserTypes=15'))).toBe(true);
    const file = JSON.parse(readFileSync(out, 'utf8')) as { leaves: Array<{ method: number; lockingBytecode: string; cumulative: string }> };
    expect(file.leaves).toHaveLength(3);
    expect(file.leaves.every((l) => l.method === 2)).toBe(true);
    expect(file.leaves.find((l) => l.lockingBytecode === script('both'))?.cumulative).toBe('200000000');
  });

  it('adds a wallet leaf file after the API responses (--file with --source api), one leaf at the configured amount', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ success: true, distro: [{ amount: 1, bitcoinAddress: legacy('api') }] }), { status: 200 })) as unknown as typeof fetch;
    let clock = Date.parse('2026-11-20T12:00:00Z');
    fixture = cliFixture({ fetch: fakeFetch, now: () => new Date(clock) });
    const net = ['--network', 'mock'];
    const plain = lockingBytecodeToAddress(hexToBin(script('wallet')), 'bchtest', false);
    const walletFile = join(fixture.dir, 'wallet.json');
    const w = await fixture.run('demo', 'allocations', '--round', 'wallet', '--address', plain, '--out', walletFile, ...net);
    expect(w.code, w.text).toBe(0);
    const units = String(BigInt(loadConfig().demo.walletLeafWhole) * 10n ** 8n);
    expect(w.json).toMatchObject({ allocations: 1, total: units });
    const wrongNet = lockingBytecodeToAddress(hexToBin(script('wallet')), 'bitcoincash', false);
    expect((await fixture.run('demo', 'allocations', '--round', 'wallet', '--address', wrongNet, '--out', walletFile, ...net)).code).toBe(1);

    const out = join(fixture.dir, 'epoch-mixed.json');
    const args = ['epoch', 'build', ...net, '--source', 'api', '--real', '--file', walletFile, '--out', out];
    expect((await fixture.run(...args)).text).toMatch(/retry after/);
    clock += 61_000;
    const built = await fixture.run(...args);
    expect(built.code, built.text).toBe(0);
    const file = JSON.parse(readFileSync(out, 'utf8')) as {
      leaves: Array<{ method: number; lockingBytecode: string; cumulative: string }>;
      manifest: { inputs: Array<{ kind: string; request?: unknown }> };
    };
    expect(file.manifest.inputs.map((i) => [i.kind, Boolean(i.request)])).toEqual([['distro', true], ['distro', true], ['allocations', false]]);
    const leaf = file.leaves.find((l) => l.lockingBytecode === script('wallet'));
    expect(leaf).toMatchObject({ method: 0, cumulative: units });
    expect(verifyEpoch(out).ok).toBe(true);
  });
});
