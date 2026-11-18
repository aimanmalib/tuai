import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hexToBin } from '@bitauth/libauth';
import { buildTxIndex, parseKind, txIndexFiles } from '../scripts/tx-index.ts';
import { epochHistory, topUps, unrecorded } from '../web/src/activity.ts';
import type { EpochFileView } from '../web/src/model.ts';

const en = JSON.parse(readFileSync('lang/en.json', 'utf8')) as { web: { activity: { step: Record<string, string> } } };
const ms = JSON.parse(readFileSync('lang/ms.json', 'utf8')) as { web: { activity: { step: Record<string, string> } } };
const explorer = 'https://explorer.example/tx/';
const indexes = buildTxIndex(process.cwd(), 'deployments', { chipnet: explorer });

// Committed runs: every deployments/<run>/transactions.json, read here independently of the generator.
const recorded = readdirSync('deployments')
  .filter((run) => existsSync(join('deployments', run, 'transactions.json')))
  .map((run) => ({ run, ...(JSON.parse(readFileSync(join('deployments', run, 'transactions.json'), 'utf8')) as { network: string; transactions: unknown[] }) }));
// Claims made from the page, recorded beside a run after an on-chain check.
const pageRecords = recorded
  .filter((r) => existsSync(join('deployments', r.run, 'page-claims.json')))
  .map((r) => ({
    run: r.run,
    ...(JSON.parse(readFileSync(join('deployments', r.run, 'page-claims.json'), 'utf8')) as {
      network: string;
      claims: { txid: string; height: number | null }[];
      refusals: { message: string }[];
    }),
  }));
const pageCount = (run: string) => {
  const p = pageRecords.find((r) => r.run === run);
  return p === undefined ? 0 : p.claims.length + p.refusals.length;
};

describe('activity index', () => {
  it('lists every recorded transaction of every run, grouped by network', () => {
    const indexed = indexes.flatMap((i) => i.runs.map((r) => ({ network: i.network, run: r.run, count: r.transactions.length })));
    expect(indexed.map((r) => r.run).sort()).toEqual(recorded.map((r) => r.run).sort());
    for (const r of recorded)
      expect(indexed.find((i) => i.run === r.run)).toMatchObject({ network: r.network, count: r.transactions.length + pageCount(r.run) });
    const total = indexes.reduce((n, i) => n + i.runs.reduce((m, r) => m + r.transactions.length, 0), 0);
    expect(total).toBe(recorded.reduce((n, r) => n + r.transactions.length + pageCount(r.run), 0));
    expect(txIndexFiles(indexes).map((f) => f.path)).toEqual(indexes.map((i) => `${i.network}/transactions.json`));
  });

  it('lists every claim made from the page with its txid, and every refused attempt without a link', () => {
    expect(pageRecords.length).toBeGreaterThan(0);
    for (const p of pageRecords) {
      const txs = indexes.find((i) => i.network === p.network)!.runs.find((r) => r.run === p.run)!.transactions;
      for (const c of p.claims) {
        expect(txs.find((t) => t.txid === c.txid), c.txid).toMatchObject({ step: 'claim-page', height: c.height, url: `${explorer}${c.txid}` });
      }
      const refused = txs.filter((t) => t.step === 'claim-page-refused');
      expect(refused.map((t) => t.error)).toEqual(p.refusals.map((r) => r.message.trim()));
      for (const t of refused) expect(t).toMatchObject({ txid: null, url: null });
    }
  });

  it('links mined transactions to the explorer and gives refused ones no link', () => {
    const txs = indexes.flatMap((i) => i.runs.flatMap((r) => r.transactions));
    const refused = txs.filter((t) => t.error !== undefined);
    expect(refused.length).toBeGreaterThan(0);
    for (const t of refused) expect(t.url).toBeNull();
    for (const t of txs.filter((x) => x.error === undefined && x.txid !== null)) expect(t.url).toBe(`${explorer}${t.txid}`);
    // Without an explorer for the network, nothing is linked.
    const bare = buildTxIndex(process.cwd(), 'deployments', {});
    expect(bare.flatMap((i) => i.runs.flatMap((r) => r.transactions)).every((t) => t.url === null)).toBe(true);
  });

  it('has a label for every recorded step in both languages', () => {
    const steps = new Set(indexes.flatMap((i) => i.runs.flatMap((r) => r.transactions.map((t) => t.step))));
    expect(steps.size).toBeGreaterThan(5);
    for (const step of steps) {
      expect(en.web.activity.step[step], `en ${step}`).toBeTruthy();
      expect(ms.web.activity.step[step], `ms ${step}`).toBeTruthy();
    }
  });

  it('splits a kind into its step and epoch', () => {
    expect(parseKind('claim-first-epoch-1')).toEqual({ step: 'claim-first', epoch: 1 });
    expect(parseKind('double-claim-epoch-12')).toEqual({ step: 'double-claim', epoch: 12 });
    expect(parseKind('fund-demo-5')).toEqual({ step: 'fund-demo', epoch: null });
    expect(parseKind('deploy')).toEqual({ step: 'deploy', epoch: null });
  });

  it('totals each epoch and shows the top-up between epochs', () => {
    const run = indexes.flatMap((i) => i.runs).find((r) => r.epochs.length > 1);
    expect(run).toBeDefined();
    const files = run!.epochs.map(
      (e) => JSON.parse(readFileSync(join('deployments', run!.run, `epoch-${e.epoch}.json`), 'utf8')) as EpochFileView,
    );
    for (const [i, e] of run!.epochs.entries()) {
      expect(e.leaves).toBe(files[i]!.leaves.length);
      expect(BigInt(e.total)).toBe(files[i]!.leaves.reduce((s, l) => s + BigInt(l.cumulative), 0n));
    }
    const [up] = topUps(run!.epochs);
    expect(up!.added).toBe(BigInt(run!.epochs[1]!.total) - BigInt(run!.epochs[0]!.total));
    expect(up!.added > 0n).toBe(true);
  });
});

describe('activity page logic', () => {
  it('reports pool history the record does not hold, once, newest first', () => {
    const index = { network: 'chipnet', runs: [{ run: 'a', pool: 'p', epochs: [], transactions: [{ txid: '11'.repeat(32) }, { txid: null }] }] };
    const history = [
      { tx_hash: '11'.repeat(32), height: 5 },
      { tx_hash: '22'.repeat(32), height: 6 },
      { tx_hash: '33'.repeat(32), height: 0 },
      { tx_hash: '22'.repeat(32), height: 6 },
      { tx_hash: '44'.repeat(32), height: 9 },
    ];
    expect(unrecorded(index as never, history).map((h) => h.txid.slice(0, 2))).toEqual(['33', '44', '22']);
  });

  it('gives one address its cumulative amount and top-up per epoch', () => {
    const files = [2, 1].map((e) => JSON.parse(readFileSync(`deployments/chipnet/epoch-${e}.json`, 'utf8')) as EpochFileView);
    const leaf = files[0]!.leaves[0]!;
    const history = epochHistory(files, hexToBin(leaf.lockingBytecode));
    const first = files[1]!.leaves.find((l) => l.lockingBytecode === leaf.lockingBytecode)!;
    expect(history).toEqual([
      { epoch: 1, cumulative: BigInt(first.cumulative), topUp: null },
      { epoch: 2, cumulative: BigInt(leaf.cumulative), topUp: BigInt(leaf.cumulative) - BigInt(first.cumulative) },
    ]);
    const absent = epochHistory(files, new Uint8Array(25));
    expect(absent.every((e) => e.cumulative === null && e.topUp === null)).toBe(true);
  });
});
