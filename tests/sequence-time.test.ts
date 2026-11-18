import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { blocksUntilActivation } from '../src/gate/maturity.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

describe('block-count sequence locks scaled by the network', () => {
  it('matches the chipnet refusals and acceptance measured on 2026-11-18', () => {
    // A 1-block lock on a coin mined at 336009 was refused with the tip at 336015 and accepted with the tip at
    // 336018; with a scale of 10 the first block that may include it is 336019.
    expect(blocksUntilActivation(336_009, 1 * 10, 336_015)).toBeGreaterThan(0);
    expect(blocksUntilActivation(336_009, 1 * 10, 336_018)).toBe(0);
    // The 3-block activation lock on the same height was refused with the tip at 336021 and 336034.
    expect(blocksUntilActivation(336_009, 3 * 10, 336_021)).toBeGreaterThan(0);
    expect(blocksUntilActivation(336_009, 3 * 10, 336_034)).toBeGreaterThan(0);
  });
});

let f: CliFixture;
afterEach(() => f?.cleanup());

describe('activate on a network with a sequence block scale', () => {
  it('waits for delay times scale blocks', async () => {
    const config = loadConfig();
    config.networks.mock = { ...config.networks.mock, sequenceBlockScale: 10 };
    const chain = { confirmed: undefined as number | undefined };
    f = cliFixture({ config, confirmedHeight: async () => chain.confirmed });
    f.fund('payer-mock');
    const net = ['--network', 'mock'];
    await f.run('token', 'genesis', '--amount', '1000', ...net);
    await f.run('deploy', ...net);
    const a = f.file('a.json', { allocations: [{ address: f.address('demo-1'), amount: '10' }] });
    const e = (await f.run('epoch', 'build', '--source', 'fixture', '--file', a, ...net)).json?.out as string;
    await f.run('propose', '--epoch', e, ...net);
    const tip = await f.provider.getBlockHeight();
    chain.confirmed = tip;
    // The contract's delay of 3 is met by height 3 blocks on, but the network needs 30.
    f.provider.setBlockHeight(tip + 10);
    const early = await f.run('activate', ...net);
    expect(early.code, early.text).toBe(3);
    expect(early.text).toMatch(/in 19 more block/);
    expect((await f.run('status', ...net)).json?.pool).toMatchObject({ pending: { blocksLeft: 19 } });
    f.provider.setBlockHeight(tip + 29);
    const ok = await f.run('activate', ...net);
    expect(ok.code, ok.text).toBe(0);
  });
});
