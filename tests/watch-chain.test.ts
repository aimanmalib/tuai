import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binToHex, encodeTransaction, hexToBin, type Output } from '@bitauth/libauth';
import { sha256 } from '../src/bytes.ts';
import { sha256Hex } from '../src/epoch/canonical.ts';
import { buildEpoch } from '../src/epoch/build.ts';
import { readEpochFile } from '../src/epoch/file.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { encodeState } from '../src/pool/encoding.ts';
import { statesInTransaction, watchDeployment } from '../src/watch/chain-roots.ts';
import { checkLinks } from '../src/watch/fah.ts';
import { payoutsInTransaction, replayAllocations } from '../src/watch/replay.ts';
import { buildWatchReport, type WatchReport } from '../src/watch/report.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const label = (s: string): Uint8Array => sha256(new TextEncoder().encode(s));
const p2pkh = (s: string): string => `76a914${binToHex(label(s)).slice(0, 40)}88ac`;
const POOL_CATEGORY = binToHex(label('pool category'));
const REWARD_CATEGORY = binToHex(label('reward category'));

function rawTx(outputs: Output[], salt: string): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointIndex: 0, outpointTransactionHash: label(salt), sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
      outputs,
    }),
  );
}

const stateOutput = (root: string, epoch: number, inputsHash: string): Output => ({
  lockingBytecode: hexToBin(p2pkh('pool')),
  valueSatoshis: 1000n,
  token: {
    amount: 0n,
    category: hexToBin(POOL_CATEGORY),
    nft: { capability: 'mutable', commitment: encodeState({ root: hexToBin(root), epoch, inputsHash: hexToBin(inputsHash) }) },
  },
});

/** A one-epoch deployment folder whose propose and activate transactions commit to the given state. */
function deployment(commit?: { root: string; inputsHash: string }) {
  dir = mkdtempSync(join(tmpdir(), 'tuai-watch-'));
  const allocations = { allocations: ['alice', 'bob', 'carol'].map((n, i) => ({ lockingBytecode: p2pkh(n), amount: (i + 1) * 100 })) };
  const epochPath = join(dir, 'epoch-1.json');
  const file = buildEpoch({
    network: 'chipnet', prefix: 'bchtest', outPath: epochPath, maxDepth: 24, defaultMethod: 0, decimals: 8,
    sources: [{ bytes: new TextEncoder().encode(JSON.stringify(allocations)) }],
  });
  const state = commit ?? { root: file.root, inputsHash: file.inputsHash };
  const txs = new Map<string, string>([
    ['aa'.repeat(32), rawTx([stateOutput(state.root, 1, state.inputsHash)], 'propose')],
    ['bb'.repeat(32), rawTx([stateOutput(state.root, 1, state.inputsHash)], 'activate')],
  ]);
  writeFileSync(join(dir, 'pool.json'), JSON.stringify({ network: 'chipnet', poolCategory: POOL_CATEGORY }));
  writeFileSync(
    join(dir, 'transactions.json'),
    JSON.stringify({
      transactions: [
        { kind: 'propose-epoch-1', txid: 'aa'.repeat(32) },
        { kind: 'activate-epoch-1' },
        { kind: 'activate-epoch-1', txid: 'bb'.repeat(32) },
      ],
    }),
  );
  const getRaw = async (txid: string) => {
    const hex = txs.get(txid);
    if (!hex) throw new Error(`unknown txid ${txid}`);
    return hex;
  };
  return { epochPath, file, getRaw };
}

describe('watcher against roots on chain', () => {
  it('reads the state NFT of the pool category from a raw transaction', () => {
    const root = binToHex(label('r'));
    const other = { ...stateOutput(root, 4, root), token: { ...stateOutput(root, 4, root).token!, category: label('other') } };
    const states = statesInTransaction(rawTx([other, stateOutput(root, 3, root)], 's'), POOL_CATEGORY);
    expect(states.map((s) => s.epoch)).toEqual([3]);
  });

  it('matches a deployment whose transactions commit to the recomputed root and inputs hash', async () => {
    const { file, getRaw } = deployment();
    const r = await watchDeployment(dir, getRaw);
    expect(r.findings).toEqual([]);
    expect(r.epochs).toEqual([
      { epoch: 1, rootOnChain: file.root, rootRecomputed: file.root, inputsHashOnChain: file.inputsHash, inputsHashRecomputed: file.inputsHash },
    ]);
  });

  it('reports a changed allocation: the recomputed root and inputs hash no longer match the chain', async () => {
    const { epochPath, file, getRaw } = deployment();
    // An operator edits one amount after proposing and rewrites the manifest so the file still looks consistent.
    const edited = readEpochFile(epochPath);
    const input = edited.manifest.inputs[0]!;
    const bytes = readFileSync(join(dir, input.file), 'utf8').replace('"amount":100', '"amount":101');
    const hash = sha256Hex(new TextEncoder().encode(bytes));
    writeFileSync(join(dir, `inputs/${hash}.json`), bytes);
    edited.manifest.inputs[0] = { ...input, file: `inputs/${hash}.json`, sha256: hash };
    writeFileSync(epochPath, JSON.stringify(edited));
    const r = await watchDeployment(dir, getRaw);
    expect(r.epochs[0]!.rootOnChain).toBe(file.root);
    expect(r.epochs[0]!.rootRecomputed).not.toBe(file.root);
    expect(r.epochs[0]!.inputsHashRecomputed).not.toBe(file.inputsHash);
    expect(r.findings.join(' ')).toMatch(/root on chain differs/);
    expect(r.findings.join(' ')).toMatch(/inputs hash on chain differs/);
  });

  it('reports a chain state that differs from the files and a missing transaction', async () => {
    const wrong = binToHex(label('wrong'));
    const { file, getRaw } = deployment({ root: wrong, inputsHash: wrong });
    writeFileSync(join(dir, 'transactions.json'), JSON.stringify({ transactions: [{ kind: 'propose-epoch-1', txid: 'aa'.repeat(32) }] }));
    const r = await watchDeployment(dir, getRaw);
    expect(r.epochs[0]).toMatchObject({ rootOnChain: wrong, rootRecomputed: file.root });
    expect(r.findings).toContain('epoch 1: no activate-epoch-1 transaction is recorded');
    expect(r.findings).toContain('epoch 1: root on chain differs from the recomputed root');
  });
});

describe('replay of push distributions', () => {
  const pay = (who: string, amount: bigint, category = REWARD_CATEGORY): Output => ({
    lockingBytecode: hexToBin(p2pkh(who)),
    valueSatoshis: 1000n,
    token: { amount, category: hexToBin(category) },
  });
  const change: Output = { lockingBytecode: hexToBin(p2pkh('distributor')), valueSatoshis: 5000n };

  it('sums payouts of the reward category per recipient and ignores other outputs', () => {
    const tx1 = rawTx([change, pay('alice', 5n), pay('bob', 7n)], '1');
    const tx2 = rawTx([change, pay('alice', 3n), pay('carol', 9n, binToHex(label('other')))], '2');
    expect(payoutsInTransaction(tx2, REWARD_CATEGORY)).toEqual([{ lockingBytecode: p2pkh('alice'), amount: 3n }]);
    const totals = Object.fromEntries(replayAllocations([tx1, tx2], REWARD_CATEGORY).allocations.map((a) => [a.lockingBytecode, a.amount]));
    expect(totals).toEqual({ [p2pkh('alice')]: '8', [p2pkh('bob')]: '7' });
  });

  it('keeps addresses and names out of the tracked report', async () => {
    const { file, getRaw } = deployment();
    const chain = await watchDeployment(dir, getRaw);
    const links = checkLinks(file, new Map([[p2pkh('alice'), ['someone_bitcoincash:q']]]));
    const report = buildWatchReport(
      chain,
      { url: 'https://example.invalid/s.bz2', sha256: 'cd'.repeat(32), bytes: 10, fetchedAt: '2026-11-18T00:00:00.000Z' },
      { distributions: 2, leaves: file.leaves.length, root: file.root, links },
      new Date('2026-11-18T00:00:00Z'),
    );
    expect(report.fah).toMatchObject({ method0Checked: 3, method0Matched: 1, method0Mismatched: 2 });
    const text = JSON.stringify(report);
    for (const n of ['alice', 'bob', 'carol']) expect(text).not.toContain(p2pkh(n));
    expect(text).not.toContain('someone');
  });
});

describe('the committed chipnet watcher report', () => {
  const report = JSON.parse(readFileSync('reports/watch-chipnet.json', 'utf8')) as WatchReport;

  it('has no findings and every epoch on chain equals the recomputed values', () => {
    expect(report.findings).toEqual([]);
    expect(report.epochs.length).toBeGreaterThanOrEqual(2);
    for (const e of report.epochs) {
      expect(e.rootOnChain).toBe(e.rootRecomputed);
      expect(e.inputsHashOnChain).toBe(e.inputsHashRecomputed);
      const v = verifyEpoch(`deployments/${report.network}/epoch-${e.epoch}.json`);
      expect([v.recomputedRoot, v.recomputedInputsHash]).toEqual([e.rootRecomputed, e.inputsHashRecomputed]);
    }
  });

  it('records the Folding@home download by hash and counts every replay leaf', () => {
    expect(report.fah?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.fah!.method0Matched + report.fah!.method0Mismatched).toBe(report.fah!.method0Checked);
    expect(report.fah!.method0Checked).toBe(report.replay!.leaves);
    expect(report.replay!.root).toMatch(/^[0-9a-f]{64}$/);
  });
});
