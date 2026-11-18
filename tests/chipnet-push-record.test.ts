// The committed chipnet record of the operator push path (docs/decisions/0008-operator-push.md).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { renderTransactions, type PublicTx } from '../src/demo/report.ts';

const dir = resolve(REPO_ROOT, 'deployments/chipnet-push');
const record = JSON.parse(readFileSync(resolve(dir, 'transactions.json'), 'utf8')) as { deployment: string; transactions: PublicTx[] };
const pool = JSON.parse(readFileSync(resolve(dir, 'pool.json'), 'utf8')) as { push?: { minimum: string } };

describe('committed chipnet operator push demonstration', () => {
  it('ran the version 2 contracts, with the push path', () => {
    expect(record.deployment).toBe('chipnet-push');
    expect(pool.push?.minimum).toMatch(/^[1-9]\d*$/);
    expect(verifyEpoch(resolve(dir, 'epoch-1.json')).problems).toEqual([]);
  });

  it('records the arm, an accepted push, a pull claim and a refused push below the minimum', () => {
    const ok = record.transactions.filter((t) => t.txid !== null);
    expect(ok.every((t) => /^[0-9a-f]{64}$/.test(t.txid ?? ''))).toBe(true);
    const kinds = ok.map((t) => t.kind);
    for (const k of ['deploy', 'propose-epoch-1', 'activate-epoch-1', 'arm-epoch-1', 'push-first-epoch-1', 'claim-first-epoch-1']) {
      expect(kinds).toContain(k);
    }
    const refused = record.transactions.filter((t) => t.txid === null && t.kind === 'push-first-epoch-1');
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]?.note).toMatch(/below the minimum/);
  });

  it('MEASURED.md shows the same table as transactions.json', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/MEASURED.md'), 'utf8');
    const url = loadConfig().networks.chipnet.explorerTxUrl ?? '';
    expect(doc).toContain(renderTransactions(record.transactions, url));
  });
});
