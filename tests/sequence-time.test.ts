import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { medianTimePast, secondsUntilActivation } from '../src/gate/maturity.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

describe('sequence locks read as median time past', () => {
  it('takes the median of eleven timestamps', () => {
    expect(medianTimePast([5, 1, 9, 3, 7, 11, 2, 8, 4, 10, 6])).toBe(6);
    expect(() => medianTimePast([])).toThrow(/no block timestamps/);
  });

  it('matches the chipnet refusals and acceptance measured on 2026-11-18', () => {
    // Pending UTXO mined at 336009; median time past of block 336008 = 23:57:11 UTC (86231 s into the day).
    const coin = 86_231;
    // A 1-block lock (600 s) was refused with the tip at 336015 (median 00:06:21 = 86400 + 381) and
    // accepted with the tip at 336018 (median 00:07:46 = 86400 + 466).
    expect(secondsUntilActivation(coin, 1, 86_400 + 381, 600)).toBeGreaterThan(0);
    expect(secondsUntilActivation(coin, 1, 86_400 + 466, 600)).toBe(0);
    expect(secondsUntilActivation(undefined, 3, 1, 600)).toBeUndefined();
  });
});

let f: CliFixture;
afterEach(() => f?.cleanup());

describe('activate on a network with time-read sequence locks', () => {
  it('waits for the median time past, not only for blocks', async () => {
    const config = loadConfig();
    config.networks.mock = { ...config.networks.mock, sequenceSecondsPerBlock: 600 };
    const chain = { confirmed: undefined as number | undefined, mtp: new Map<number, number>() };
    f = cliFixture({ config, confirmedHeight: async () => chain.confirmed, medianTime: async (h) => chain.mtp.get(h) ?? 0 });
    f.fund('payer-mock');
    const net = ['--network', 'mock'];
    await f.run('token', 'genesis', '--amount', '1000', ...net);
    await f.run('deploy', ...net);
    const a = f.file('a.json', { allocations: [{ address: f.address('demo-1'), amount: '10' }] });
    const e = (await f.run('epoch', 'build', '--source', 'fixture', '--file', a, ...net)).json?.out as string;
    await f.run('propose', '--epoch', e, ...net);
    const tip = await f.provider.getBlockHeight();
    chain.confirmed = tip;
    chain.mtp.set(tip - 1, 10_000);
    // Ten blocks later the 3-block delay is met by height, but only 1,000 of the 1,800 seconds have passed.
    f.provider.setBlockHeight(tip + 10);
    chain.mtp.set(tip + 10, 11_000);
    const early = await f.run('activate', ...net);
    expect(early.code, early.text).toBe(3);
    expect(early.text).toMatch(/median time past advances 800 more second/);
    expect((await f.run('status', ...net)).json?.pool).toMatchObject({ pending: { blocksLeft: 1, secondsLeft: 800 } });
    f.provider.setBlockHeight(tip + 11);
    chain.mtp.set(tip + 11, 11_800);
    const ok = await f.run('activate', ...net);
    expect(ok.code, ok.text).toBe(0);
  });
});
