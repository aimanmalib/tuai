// The committed chipnet record of the operator push on a tree of the full demonstration size (config `demo`).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { explorersOf } from '../src/explorers.ts';
import { treeDepth } from '../src/merkle/tree.ts';
import { renderTransactions, type PublicTx } from '../src/demo/report.ts';

const NAME = 'chipnet-push-tree';
const dir = resolve(REPO_ROOT, 'deployments', NAME);
const config = loadConfig();
const record = JSON.parse(readFileSync(resolve(dir, 'transactions.json'), 'utf8')) as { deployment: string; transactions: PublicTx[] };
const pool = JSON.parse(readFileSync(resolve(dir, 'pool.json'), 'utf8')) as { push?: { minimum: string } };
const epoch = JSON.parse(readFileSync(resolve(dir, 'epoch-1.json'), 'utf8')) as { depth: number; leaves: unknown[] };

describe('committed chipnet operator push on the demonstration tree', () => {
  it('ran the version 2 contracts on a tree of the configured demonstration size', () => {
    expect(record.deployment).toBe(NAME);
    expect(pool.push?.minimum).toMatch(/^[1-9]\d*$/);
    expect(epoch.leaves).toHaveLength(config.demo.leafCount);
    expect(epoch.depth).toBe(treeDepth(config.demo.leafCount));
    expect(verifyEpoch(resolve(dir, 'epoch-1.json')).problems).toEqual([]);
  });

  it('records the arm and an accepted push in a block, and a refused push below the minimum', () => {
    const mined = record.transactions.filter((t) => t.txid !== null && t.height !== null && t.height > 0);
    expect(mined.every((t) => /^[0-9a-f]{64}$/.test(t.txid ?? ''))).toBe(true);
    const kinds = mined.map((t) => t.kind);
    for (const k of ['deploy', 'propose-epoch-1', 'activate-epoch-1', 'arm-epoch-1', 'push-first-epoch-1']) {
      expect(kinds).toContain(k);
    }
    const refused = record.transactions.filter((t) => t.txid === null && t.kind === 'push-first-epoch-1');
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused.some((t) => /below the minimum/.test(t.note ?? ''))).toBe(true);
  });

  it('MEASURED.md shows the same table as transactions.json', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/MEASURED.md'), 'utf8');
    expect(doc).toContain(renderTransactions(record.transactions, explorersOf(config.networks.chipnet)));
  });
});
