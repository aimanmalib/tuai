// `tuai arm`, `tuai push` and `--run` on the mock network (docs/decisions/0008-operator-push.md).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { RunLog } from '../src/cli/runs.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

let f: CliFixture;
afterEach(() => f?.cleanup());

const net = ['--network', 'mock'];
const MINIMUM = BigInt(loadConfig().push.minimumUnits);
const ABOVE = MINIMUM * 2n;
const BELOW = MINIMUM / 2n;

const tokensAt = async (address: string, category: string) =>
  (await f.provider.getUtxos(address)).filter((u) => u.token?.category === category && !u.token.nft).reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);

const runLog = (name: string): RunLog => JSON.parse(readFileSync(join(f.dir, 'state', 'runs', `${name}.json`), 'utf8')) as RunLog;

/** A pool under `--run push` with one leaf above the push minimum and one below, root active. */
async function activePushPool(extra: string[] = []) {
  f.fund('payer-mock');
  const run = ['--run', 'push', ...net, ...extra];
  const genesis = await f.run('token', 'genesis', '--amount', String(ABOVE + BELOW + MINIMUM), ...run);
  expect(genesis.code, genesis.text).toBe(0);
  const deployed = await f.run('deploy', '--vault-sats', '20000', ...run);
  expect(deployed.code, deployed.text).toBe(0);
  const [d1, d2] = [f.address('demo-1'), f.address('demo-2')];
  const a = f.file('a.json', { allocations: [{ address: d1, amount: String(ABOVE) }, { address: d2, amount: String(BELOW) }] });
  const built = await f.run('epoch', 'build', '--source', 'fixture', '--file', a, ...run);
  expect(built.json?.out).toBe(join(f.dir, 'deployments', 'mock-push', 'epoch-1.json'));
  const e = built.json?.out as string;
  expect((await f.run('propose', '--epoch', e, ...run)).code).toBe(0);
  return { run, e, d1, d2, category: genesis.json?.category as string };
}

describe('tuai arm and push', () => {
  it('keeps a named run apart, arms after activation, pushes above the minimum and refuses below it', async () => {
    f = cliFixture();
    const { run, e, d1, d2, category } = await activePushPool();
    expect((await f.run('activate', ...run)).code).toBe(0);
    expect(existsSync(join(f.dir, 'state', 'runs', 'mock.json'))).toBe(false);
    expect(runLog('mock-push').pool?.push).toMatchObject({ minimum: MINIMUM.toString() });

    const early = await f.run('push', d1, '--epoch', e, ...run);
    expect(early.code).toBe(1);
    expect(early.text).toMatch(/not armed/);

    const armed = await f.run('arm', ...run);
    expect(armed.code, armed.text).toBe(0);
    expect(armed.json).toMatchObject({ armed: { epoch: 1 } });
    expect((await f.run('arm', ...run)).text).toMatch(/already armed/);

    const below = await f.run('push', d2, '--epoch', e, ...run);
    expect(below.code).toBe(1);
    expect(below.text).toMatch(/below the push minimum/);
    const forced = await f.run('push', d2, '--epoch', e, '--force', ...run);
    expect(forced.code).toBe(1);
    expect(forced.text).toMatch(/payment >= pushMinimum/);
    const refused = runLog('mock-push').txs.at(-1);
    expect(refused).toMatchObject({ kind: 'push-first-epoch-1', txid: null });
    expect(refused?.note).toMatch(/below the minimum/);

    const pushed = await f.run('push', d1, '--epoch', e, ...run);
    expect(pushed.code, pushed.text).toBe(0);
    expect(pushed.json).toMatchObject({ kind: 'first', paid: ABOVE.toString() });
    expect(BigInt(pushed.json?.vaultSats as string)).toBeLessThanOrEqual(BigInt(loadConfig().push.maxSatsPerPush));
    expect(await tokensAt(d1, category)).toBe(ABOVE);
    expect((await f.run('claim', d1, '--epoch', e, ...run)).text).toMatch(/already fully claimed/);

    // The balance below the minimum is still claimable by pull.
    const pulled = await f.run('claim', d2, '--epoch', e, ...run);
    expect(pulled.code, pulled.text).toBe(0);
    expect(await tokensAt(d2, category)).toBe(BELOW);
  });

  it('will not arm before the push delay and says how many blocks remain', async () => {
    const chain: { confirmed: number | undefined } = { confirmed: undefined };
    f = cliFixture({ confirmedHeight: async () => chain.confirmed });
    const { run } = await activePushPool();
    const tip = await f.provider.getBlockHeight();
    chain.confirmed = tip - 3;
    expect((await f.run('activate', ...run)).code).toBe(0);
    chain.confirmed = undefined;
    expect((await f.run('arm', ...run)).text).toMatch(/not confirmed yet; arming pushes/);
    chain.confirmed = tip;
    const early = await f.run('arm', ...run);
    expect(early.code).toBe(3);
    expect(early.text).toMatch(/arming pushes is possible in 2 more block/);
    f.provider.setBlockHeight(tip + 2);
    expect((await f.run('arm', ...run)).code).toBe(0);
  });

  it('rejects a malformed run name', async () => {
    f = cliFixture();
    const r = await f.run('status', '--run', '../x', ...net);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/--run must be/);
  });
});
