import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { readEpochFile } from '../src/epoch/file.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { explorersOf } from '../src/explorers.ts';
import { renderTransactions, type PublicTx } from '../src/demo/report.ts';

const dir = resolve(REPO_ROOT, 'deployments/chipnet');
const record = JSON.parse(readFileSync(resolve(dir, 'transactions.json'), 'utf8')) as { transactions: PublicTx[] };

describe('committed chipnet demonstration', () => {
  it('epoch files recompute from their committed inputs', () => {
    for (const n of [1, 2]) {
      const path = resolve(dir, `epoch-${n}.json`);
      expect(verifyEpoch(path).problems).toEqual([]);
      const file = readEpochFile(path);
      expect(file.leaves.length).toBeGreaterThanOrEqual(300);
    }
  });

  it('records every required step with a full txid', () => {
    const ok = record.transactions.filter((t) => t.txid !== null);
    expect(ok.every((t) => /^[0-9a-f]{64}$/.test(t.txid ?? ''))).toBe(true);
    const kinds = ok.map((t) => t.kind);
    for (const k of ['deploy', 'propose-epoch-1', 'activate-epoch-1', 'propose-epoch-2', 'activate-epoch-2']) expect(kinds).toContain(k);
    expect(kinds.filter((k) => k === 'claim-first-epoch-1')).toHaveLength(5);
    expect(kinds).toContain('claim-additional-epoch-2');
    const refused = record.transactions.filter((t) => t.txid === null).map((t) => t.kind);
    expect(refused).toContain('activate-epoch-1');
    expect(refused).toContain('double-claim-epoch-1');
  });

  it('MEASURED.md shows the same table as transactions.json', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/MEASURED.md'), 'utf8');
    const url = explorersOf(loadConfig().networks.chipnet);
    expect(doc).toContain(renderTransactions(record.transactions, url));
  });
});
