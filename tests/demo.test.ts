import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { demoLayout, syntheticAmount } from '../src/demo/layout.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

const p2pkh = (byte: number) => `76a914${byte.toString(16).padStart(2, '0').repeat(20)}88ac`;
const KEYS = [p2pkh(0xc0), p2pkh(0x10), p2pkh(0x80)];

describe('demonstration tree layout', () => {
  it('puts each demo key at its index among sorted synthetic leaves', () => {
    const leaves = demoLayout({ demoKeys: KEYS, indices: [150, 0, 299], leafCount: 300, label: 't' });
    expect(leaves).toHaveLength(300);
    expect(new Set(leaves).size).toBe(300);
    expect([...leaves].sort()).toEqual(leaves);
    expect([leaves[0], leaves[150], leaves[299]]).toEqual([p2pkh(0x10), p2pkh(0x80), p2pkh(0xc0)]);
    expect(leaves.filter((l) => KEYS.includes(l))).toHaveLength(3);
    expect(leaves.every((l) => /^76a914[0-9a-f]{40}88ac$/.test(l))).toBe(true);
  });

  it('is deterministic per label and differs between labels', () => {
    const o = { demoKeys: KEYS, indices: [0, 1, 2], leafCount: 50 };
    expect(demoLayout({ ...o, label: 'a' })).toEqual(demoLayout({ ...o, label: 'a' }));
    expect(demoLayout({ ...o, label: 'a' })).not.toEqual(demoLayout({ ...o, label: 'b' }));
  });

  it('refuses bad input', () => {
    expect(() => demoLayout({ demoKeys: KEYS, indices: [0, 1], leafCount: 10, label: 'x' })).toThrow(/exactly one index/);
    expect(() => demoLayout({ demoKeys: KEYS, indices: [0, 1, 10], leafCount: 10, label: 'x' })).toThrow(/0\.\.9/);
    expect(() => demoLayout({ demoKeys: [p2pkh(1), p2pkh(1)], indices: [0, 1], leafCount: 10, label: 'x' })).toThrow(/distinct/);
    expect(() => demoLayout({ demoKeys: ['a914'], indices: [0], leafCount: 10, label: 'x' })).toThrow(/P2PKH/);
    // Two adjacent hashes leave no room for a leaf between them.
    const tight = [`76a914${'00'.repeat(19)}0188ac`, `76a914${'00'.repeat(19)}0288ac`];
    expect(() => demoLayout({ demoKeys: tight, indices: [0, 2], leafCount: 3, label: 'x' })).toThrow(/not enough room/);
  });

  it('gives synthetic leaves 1..max whole tokens', () => {
    for (const l of demoLayout({ demoKeys: KEYS, indices: [0, 1, 2], leafCount: 40, label: 'y' })) {
      const a = syntheticAmount(l, 5n, 100n);
      expect(a % 100n).toBe(0n);
      expect(a >= 100n && a <= 500n).toBe(true);
    }
  });
});

let f: CliFixture;
afterEach(() => f?.cleanup());

function demoFixture(): CliFixture {
  const config = loadConfig();
  config.demo = { ...config.demo, leafCount: 20, keyIndices: [0, 10, 19] };
  return cliFixture({ config });
}

describe('demo CLI commands on the mock network', () => {
  it('writes demo allocations that build into a tree with the demo keys at their indices', async () => {
    f = demoFixture();
    const net = ['--network', 'mock'];
    const out = join(f.dir, 'a1.json');
    const r = await f.run('demo', 'allocations', '--round', '1', '--out', out, ...net);
    expect(r.code, r.text).toBe(0);
    expect(r.json).toMatchObject({ allocations: 20, demoKeys: 3 });
    const built = await f.run('epoch', 'build', '--source', 'fixture', '--file', out, ...net);
    expect(built.json).toMatchObject({ leaves: 20, depth: 5 });
    const epoch = JSON.parse(readFileSync(built.json?.out as string, 'utf8')) as { leaves: Array<{ index: number; address: string }> };
    const demo = new Set(['demo-1', 'demo-2', 'demo-3'].map((role) => f.address(role)));
    expect(epoch.leaves.filter((l) => demo.has(l.address)).map((l) => l.index)).toEqual([0, 10, 19]);

    const top = await f.run('demo', 'allocations', '--round', '2', '--out', join(f.dir, 'a2.json'), ...net);
    expect(top.json).toMatchObject({ allocations: 3, total: String(3 * 250 * 1e8) });
    expect((await f.run('demo', 'allocations', '--round', '3', '--out', out, ...net)).code).toBe(1);
  });

  it('funds only project keys', async () => {
    f = demoFixture();
    f.fund('payer-mock');
    const net = ['--network', 'mock'];
    expect((await f.run('fund', 'bchtest:qqq7ganu4kkt5gtgl5r30egjdaylvquj05pfqs2tnz', ...net)).code).toBe(1);
    const r = await f.run('fund', 'demo-2', '--sats', '5000', ...net);
    expect(r.code, r.text).toBe(0);
    const got = (await f.provider.getUtxos(f.address('demo-2'))).reduce((s, u) => s + u.satoshis, 0n);
    expect(got).toBe(5000n);
  });

  it('funds the relayer key on chipnet only', async () => {
    f = demoFixture();
    f.fund('payer-mock');
    const r = await f.run('fund', 'relay-chipnet', '--sats', '5000', '--network', 'mock');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/chipnet only/);
    expect((await f.run('fund', 'relay-other', '--network', 'mock')).code).toBe(1);
  });

  it('records a refused double claim and refuses a leaf with no receipt', async () => {
    f = demoFixture();
    f.fund('payer-mock');
    const net = ['--network', 'mock'];
    await f.run('token', 'genesis', '--amount', String(10n ** 14n), ...net);
    await f.run('deploy', ...net);
    const out = join(f.dir, 'a1.json');
    await f.run('demo', 'allocations', '--round', '1', '--out', out, ...net);
    const e1 = (await f.run('epoch', 'build', '--source', 'fixture', '--file', out, ...net)).json?.out as string;
    await f.run('propose', '--epoch', e1, ...net);
    await f.run('activate', ...net);
    const d1 = f.address('demo-1');
    expect((await f.run('demo', 'double-claim', d1, '--epoch', e1, ...net)).text).toMatch(/no receipt yet/);
    expect((await f.run('claim', d1, '--epoch', e1, ...net)).code).toBe(0);
    const r = await f.run('demo', 'double-claim', d1, '--epoch', e1, ...net);
    expect(r.code, r.text).toBe(0);
    expect(r.json).toMatchObject({ ok: true, txid: null });
    expect([0, 10, 19]).toContain(r.json?.leaf);
    expect(String(r.json?.localRefusal)).toMatch(/ClaimPool|require|failed/i);
    const log = JSON.parse(readFileSync(join(f.dir, 'state/runs/mock.json'), 'utf8')) as { txs: Array<{ kind: string; error?: string }> };
    expect(log.txs.at(-1)).toMatchObject({ kind: 'double-claim-epoch-1' });
    expect(log.txs.at(-1)?.error).toMatch(/^local: /);
  });
});
