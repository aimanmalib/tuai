// The committed mainnet record: claims by the project's demo keys with its own test token, within the configured spending limit.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { explorersOf } from '../src/explorers.ts';
import { treeDepth } from '../src/merkle/tree.ts';
import { renderTransactions, type PublicTx } from '../src/demo/report.ts';

const dir = resolve(REPO_ROOT, 'deployments', 'mainnet');
const config = loadConfig();
const record = JSON.parse(readFileSync(resolve(dir, 'transactions.json'), 'utf8')) as { network: string; transactions: PublicTx[] };
const pool = JSON.parse(readFileSync(resolve(dir, 'pool.json'), 'utf8')) as { rewardCategory: string };
const epoch = JSON.parse(readFileSync(resolve(dir, 'epoch-1.json'), 'utf8')) as { depth: number; leaves: unknown[] };

describe('committed mainnet claim with a test token', () => {
  it('ran on a tree of the configured demonstration size whose token the project created', () => {
    expect(record.network).toBe('mainnet');
    expect(epoch.leaves).toHaveLength(config.demo.leafCount);
    expect(epoch.depth).toBe(treeDepth(config.demo.leafCount));
    expect(verifyEpoch(resolve(dir, 'epoch-1.json')).problems).toEqual([]);
    const genesis = record.transactions.find((t) => t.kind === 'token-genesis');
    expect(genesis?.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(pool.rewardCategory).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the token genesis, deploy, activation and the first claims, each in a block', () => {
    const mined = record.transactions.filter((t) => t.txid !== null && t.height !== null && t.height > 0);
    for (const k of ['token-genesis', 'deploy', 'propose-epoch-1', 'activate-epoch-1', 'claim-first-epoch-1']) {
      expect(mined.map((t) => t.kind)).toContain(k);
    }
    const claims = record.transactions.filter((t) => t.kind.startsWith('claim-'));
    expect(claims.length).toBeGreaterThanOrEqual(1);
    for (const c of claims) expect(mined).toContain(c);
  });

  it('paid only leaves held by the project demo keys, each leaf once', () => {
    const leaves = record.transactions
      .filter((t) => t.kind.startsWith('claim-'))
      .map((t) => Number(/^leaf (\d+)$/.exec(t.note ?? '')?.[1]));
    expect(leaves.length).toBeLessThanOrEqual(config.demo.keyIndices.length);
    expect(new Set(leaves).size).toBe(leaves.length);
    for (const leaf of leaves) expect(config.demo.keyIndices).toContain(leaf);
  });

  it('spent less than the configured mainnet limit in fees and outputs', () => {
    const fees = record.transactions.reduce((n, t) => n + t.feeSats, 0);
    expect(fees).toBeLessThanOrEqual(config.budget.mainnetMaxSats);
  });

  it('MEASURED.md shows the same table as transactions.json', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/MEASURED.md'), 'utf8');
    expect(doc).toContain(renderTransactions(record.transactions, explorersOf(config.networks.mainnet)));
  });
});
