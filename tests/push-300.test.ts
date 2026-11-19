// The operator push path on the full demonstration tree (config `demo`), run end to end from the command line on the
// mock network under a named run: the same commands a chipnet run uses, with a version 2 pool (push enabled).
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binToHex } from '@bitauth/libauth';
import { sha256 } from '../src/bytes.ts';
import { loadConfig } from '../src/config.ts';
import { treeDepth } from '../src/merkle/tree.ts';
import type { RunLog } from '../src/cli/runs.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

let f: CliFixture;
afterEach(() => f?.cleanup());

const config = loadConfig();
const demo = config.demo;
const unit = 10n ** BigInt(config.rewards.decimals);
const MINIMUM = BigInt(config.push.minimumUnits);
const RUN = ['--run', 'push-tree', '--network', 'mock'];
const DEPLOYMENT = 'mock-push-tree';
/** The leaf the chipnet run pushes: the demo key in the middle of the tree. */
const PUSHED_INDEX = demo.keyIndices[Math.floor(demo.keyIndices.length / 2)] as number;

interface EpochFile {
  depth: number;
  leaves: Array<{ index: number; address: string; cumulative: string }>;
}

const readEpoch = (path: string): EpochFile => JSON.parse(readFileSync(path, 'utf8')) as EpochFile;
const runLog = (): RunLog => JSON.parse(readFileSync(join(f.dir, 'state', 'runs', `${DEPLOYMENT}.json`), 'utf8')) as RunLog;

const tokensAt = async (address: string, category: string) =>
  (await f.provider.getUtxos(address)).filter((u) => u.token?.category === category && !u.token.nft).reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);

/** The CLI fixture holds three demo keys; the demonstration tree places one per configured index. */
function addDemoKeys(): void {
  for (let i = 4; i <= demo.keyIndices.length; i += 1) {
    const role = `demo-${i}`;
    const privateKey = binToHex(sha256(new TextEncoder().encode(`tuai cli test key ${role}`)));
    writeFileSync(join(f.dir, 'state', 'keys', `${role}.json`), JSON.stringify({ role, privateKey }));
  }
}

describe(`operator push on the ${demo.leafCount}-leaf demonstration tree`, () => {
  it('arms, pushes the middle demo key, refuses a balance below the minimum, and a later pull pays the top-up only', async () => {
    f = cliFixture();
    addDemoKeys();
    f.fund('payer-mock', 10_000_000n);
    const genesis = await f.run('token', 'genesis', '--amount', String(BigInt(demo.tokenSupplyWhole) * unit), ...RUN);
    expect(genesis.code, genesis.text).toBe(0);
    const category = genesis.json?.category as string;
    const deployed = await f.run('deploy', '--vault-sats', '30000', ...RUN);
    expect(deployed.code, deployed.text).toBe(0);
    expect(runLog().pool?.push).toMatchObject({ minimum: MINIMUM.toString() });

    const a1 = join(f.dir, 'a1.json');
    expect((await f.run('demo', 'allocations', '--round', '1', '--out', a1, ...RUN)).code).toBe(0);
    const built = await f.run('epoch', 'build', '--source', 'fixture', '--file', a1, ...RUN);
    expect(built.code, built.text).toBe(0);
    const e1 = built.json?.out as string;
    expect(e1).toBe(join(f.dir, 'deployments', DEPLOYMENT, 'epoch-1.json'));
    const epoch1 = readEpoch(e1);
    expect(epoch1.leaves).toHaveLength(demo.leafCount);
    expect(epoch1.depth).toBe(treeDepth(demo.leafCount));
    const demoAddresses = new Set(demo.keyIndices.map((_, i) => f.address(`demo-${i + 1}`)));
    expect(epoch1.leaves.filter((l) => demoAddresses.has(l.address)).map((l) => l.index)).toEqual([...demo.keyIndices].sort((x, y) => x - y));

    expect((await f.run('propose', '--epoch', e1, ...RUN)).code).toBe(0);
    expect((await f.run('activate', ...RUN)).code).toBe(0);
    const armed = await f.run('arm', ...RUN);
    expect(armed.code, armed.text).toBe(0);
    expect(armed.json).toMatchObject({ armed: { epoch: 1 } });

    // Push the demo key in the middle of the tree: the vault pays, the leaf's own address receives its whole balance.
    const target = epoch1.leaves[PUSHED_INDEX];
    if (!target) throw new Error(`no leaf ${PUSHED_INDEX}`);
    expect(demoAddresses.has(target.address)).toBe(true);
    const pushed = await f.run('push', target.address, '--epoch', e1, ...RUN);
    expect(pushed.code, pushed.text).toBe(0);
    expect(pushed.json).toMatchObject({ kind: 'first', leaf: PUSHED_INDEX, paid: target.cumulative });
    expect(BigInt(target.cumulative)).toBe(BigInt(demo.keyAmountWhole) * unit);
    expect(BigInt(pushed.json?.vaultSats as string)).toBeLessThanOrEqual(BigInt(config.push.maxSatsPerPush));
    expect(await tokensAt(target.address, category)).toBe(BigInt(target.cumulative));
    expect((await f.run('push', target.address, '--epoch', e1, ...RUN)).text).toMatch(/already fully claimed/);

    // A synthetic leaf below the push minimum: refused before sending, and the forced attempt fails the contract.
    const small = epoch1.leaves.find((l) => !demoAddresses.has(l.address) && BigInt(l.cumulative) < MINIMUM);
    if (!small) throw new Error('the demonstration tree has no leaf below the push minimum');
    const below = await f.run('push', small.address, '--epoch', e1, ...RUN);
    expect(below.code).toBe(1);
    expect(below.text).toMatch(/below the push minimum/);
    const forced = await f.run('push', small.address, '--epoch', e1, '--force', ...RUN);
    expect(forced.code).toBe(1);
    expect(forced.text).toMatch(/payment >= pushMinimum/);
    expect(runLog().txs.at(-1)).toMatchObject({ kind: 'push-first-epoch-1', txid: null });

    // Round 2 tops up every demo key; pulling the pushed leaf afterwards pays the difference only.
    const a2 = join(f.dir, 'a2.json');
    expect((await f.run('demo', 'allocations', '--round', '2', '--out', a2, ...RUN)).code).toBe(0);
    const built2 = await f.run('epoch', 'build', '--source', 'fixture', '--file', a2, '--previous', e1, ...RUN);
    expect(built2.code, built2.text).toBe(0);
    const e2 = built2.json?.out as string;
    expect(readEpoch(e2).leaves).toHaveLength(demo.leafCount);
    expect((await f.run('propose', '--epoch', e2, ...RUN)).code).toBe(0);
    expect((await f.run('activate', ...RUN)).code).toBe(0);
    const pulled = await f.run('claim', target.address, '--epoch', e2, ...RUN);
    expect(pulled.code, pulled.text).toBe(0);
    expect(await tokensAt(target.address, category)).toBe(BigInt(demo.keyAmountWhole + demo.topUpWhole) * unit);
    expect((await f.run('claim', target.address, '--epoch', e2, ...RUN)).text).toMatch(/already fully claimed/);

    const kinds = runLog().txs.filter((t) => t.txid !== null).map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['arm-epoch-1', 'push-first-epoch-1']));
    // About sixteen CLI steps, each compiling the contracts and checking its transaction in the VM; allow for a busy CI host.
  }, 360_000);
});
