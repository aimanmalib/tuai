import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

let f: CliFixture;
afterEach(() => f?.cleanup());

const tokensAt = async (fx: CliFixture, address: string, category: string) =>
  (await fx.provider.getUtxos(address)).filter((u) => u.token?.category === category && !u.token.nft).reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);

describe('tuai CLI on the mock network', () => {
  it('builds, proposes, activates, claims and reports status across two epochs', async () => {
    f = cliFixture();
    f.fund('payer-mock');
    f.fund('demo-2', 100_000n);
    const net = ['--network', 'mock'];
    const genesis = await f.run('token', 'genesis', '--amount', '1000000', ...net);
    expect(genesis.code, genesis.text).toBe(0);
    const category = genesis.json?.category as string;

    const [d1, d2, d3] = ['demo-1', 'demo-2', 'demo-3'].map((r) => f.address(r)) as [string, string, string];
    const e1 = join(f.dir, 'deployments/mock/epoch-1.json');
    const a1 = f.file('a1.json', { allocations: [{ address: d1, amount: '1000' }, { address: d2, amount: '2000' }, { address: d3, amount: 3000 }] });
    const built = await f.run('epoch', 'build', '--source', 'fixture', '--file', a1, ...net);
    expect(built.code, built.text).toBe(0);
    expect(built.json).toMatchObject({ epoch: 1, leaves: 3, out: e1 });
    expect((await f.run('epoch', 'verify', e1)).code).toBe(0);

    expect((await f.run('deploy', ...net)).code).toBe(0);
    const before = await f.run('status', ...net);
    expect(before.json?.pool).toMatchObject({ active: { epoch: 0 }, pending: { epoch: 0 }, balance: '1000000' });
    expect((await f.run('propose', '--epoch', e1, ...net)).code).toBe(0);
    expect((await f.run('claim', d1, '--epoch', e1, ...net)).text).toMatch(/not the active root/);
    expect((await f.run('activate', ...net)).code).toBe(0);

    const c1 = await f.run('claim', d1, '--epoch', e1, ...net);
    expect(c1.code, c1.text).toBe(0);
    expect(c1.json).toMatchObject({ kind: 'first', paid: '1000' });
    expect(await tokensAt(f, d1, category)).toBe(1000n);
    const again = await f.run('claim', d1, '--epoch', e1, ...net);
    expect(again.code).toBe(1);
    expect(again.text).toMatch(/already fully claimed/);

    // demo-2 pays for demo-3's claim; the tokens still go to demo-3.
    const paidByOther = await f.run('claim', d3, '--epoch', e1, '--payer', 'demo-2', ...net);
    expect(paidByOther.code, paidByOther.text).toBe(0);
    expect(await tokensAt(f, d3, category)).toBe(3000n);
    expect(await tokensAt(f, d2, category)).toBe(0n);

    const a2 = f.file('a2.json', { allocations: [{ address: d1, amount: '500' }] });
    const b2 = await f.run('epoch', 'build', '--source', 'fixture', '--file', a2, '--previous', e1, ...net);
    expect(b2.json).toMatchObject({ epoch: 2, leaves: 3 });
    const e2 = b2.json?.out as string;
    expect((await f.run('propose', '--epoch', e2, '--operators', '2,3', ...net)).code).toBe(0);
    expect((await f.run('activate', ...net)).code).toBe(0);
    const c2 = await f.run('claim', d1, '--epoch', e2, ...net);
    expect(c2.json).toMatchObject({ kind: 'additional', paid: '500', cumulative: '1500' });
    expect(await tokensAt(f, d1, category)).toBe(1500n);

    const after = await f.run('status', ...net);
    expect(after.json?.pool).toMatchObject({ active: { epoch: 2 }, balance: String(1_000_000 - 4500), receipts: 2 });
    const w = await f.run('watch', '--epoch', e2, ...net);
    expect(w.code, w.text).toBe(0);
    expect(w.json?.chain).toMatchObject({ activeEpoch: 2, matched: true });
  });

  it('refuses a proposal signed by a single operator key twice', async () => {
    f = cliFixture();
    f.fund('payer-mock');
    const net = ['--network', 'mock'];
    await f.run('token', 'genesis', '--amount', '1000', ...net);
    await f.run('deploy', ...net);
    const a = f.file('a.json', { allocations: [{ address: f.address('demo-1'), amount: '10' }] });
    const e = (await f.run('epoch', 'build', '--source', 'fixture', '--file', a, ...net)).json?.out as string;
    const r = await f.run('propose', '--epoch', e, '--operators', '1,1', ...net);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/two distinct operator keys/);
  });

  it('will not activate before the delay and says how many blocks remain', async () => {
    const chain: { confirmed: number | undefined } = { confirmed: undefined };
    f = cliFixture({ confirmedHeight: async () => chain.confirmed });
    f.fund('payer-mock');
    const net = ['--network', 'mock'];
    await f.run('token', 'genesis', '--amount', '1000', ...net);
    await f.run('deploy', ...net);
    const a = f.file('a.json', { allocations: [{ address: f.address('demo-1'), amount: '10' }] });
    const e = (await f.run('epoch', 'build', '--source', 'fixture', '--file', a, ...net)).json?.out as string;
    await f.run('propose', '--epoch', e, ...net);
    const unconfirmed = await f.run('activate', ...net);
    expect(unconfirmed.code).toBe(3);
    expect(unconfirmed.text).toMatch(/not confirmed yet/);
    const tip = await f.provider.getBlockHeight();
    chain.confirmed = tip;
    const early = await f.run('activate', ...net);
    expect(early.code).toBe(3);
    expect(early.text).toMatch(/in 2 more block/);
    f.provider.setBlockHeight(tip + 2);
    expect((await f.run('activate', ...net)).code).toBe(0);
  });

  it('prints usage for an unknown command and exits 2', async () => {
    f = cliFixture();
    const r = await f.run('nonsense');
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/Usage: tuai/);
  });
});
