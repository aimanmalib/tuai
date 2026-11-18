// Builds the public activity index the claim page lists: every recorded transaction of every deployment run,
// grouped by network, served as <epochsPath>/<network>/transactions.json. Data only; labels live in lang/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicTx } from '../src/demo/report.ts';
import type { ServedFile } from './web-epochs.ts';
import { parseKind, type ActivityIndex, type ActivityRun, type ActivityTx, type EpochTotal } from '../src/demo/activity-index.ts';

export { parseKind };

function epochTotals(dir: string): EpochTotal[] {
  return readdirSync(dir)
    .map((n) => /^epoch-(\d+)\.json$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
    .map((epoch) => {
      const file = JSON.parse(readFileSync(join(dir, `epoch-${epoch}.json`), 'utf8')) as { leaves: { cumulative: string }[] };
      const total = file.leaves.reduce((sum, l) => sum + BigInt(l.cumulative), 0n);
      return { epoch, leaves: file.leaves.length, total: total.toString() };
    });
}

/** One index per network found under the deployments folder; runs in folder-name order, transactions in recorded order. */
export function buildTxIndex(repoRoot: string, deploymentsDir: string, explorerTxUrl: Readonly<Record<string, string | undefined>>): ActivityIndex[] {
  const base = join(repoRoot, deploymentsDir);
  const byNetwork = new Map<string, ActivityRun[]>();
  for (const run of readdirSync(base).sort()) {
    const dir = join(base, run);
    if (!existsSync(join(dir, 'transactions.json')) || !existsSync(join(dir, 'pool.json'))) continue;
    const record = JSON.parse(readFileSync(join(dir, 'transactions.json'), 'utf8')) as { network: string; transactions: PublicTx[] };
    const pool = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8')) as { network: string; contracts: { pool: string } };
    if (record.network !== pool.network) throw new Error(`${run}: transactions.json is ${record.network}, pool.json is ${pool.network}`);
    const explorer = explorerTxUrl[record.network];
    const transactions = record.transactions.map((tx): ActivityTx => {
      const { step, epoch } = parseKind(tx.kind);
      const mined = tx.txid !== null && tx.error === undefined;
      return {
        step,
        epoch,
        kind: tx.kind,
        txid: tx.txid,
        bytes: tx.bytes,
        feeSats: tx.feeSats,
        height: tx.height,
        utc: tx.utc,
        ...(tx.note === undefined ? {} : { note: tx.note }),
        ...(tx.error === undefined ? {} : { error: tx.error.trim() }),
        url: mined && explorer ? `${explorer}${tx.txid}` : null,
      };
    });
    const runs = byNetwork.get(record.network) ?? [];
    runs.push({ run, pool: pool.contracts.pool, epochs: epochTotals(dir), transactions });
    byNetwork.set(record.network, runs);
  }
  return [...byNetwork].map(([network, runs]) => ({ network, runs }));
}

/** The index as files the build and the dev server serve under the epochs path. */
export const txIndexFiles = (indexes: readonly ActivityIndex[]): ServedFile[] =>
  indexes.map((index) => ({ path: `${index.network}/transactions.json`, body: `${JSON.stringify(index)}\n` }));
