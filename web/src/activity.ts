// Activity page logic without the DOM: epoch top-ups, transactions seen on chain but not recorded, and one leaf's history.
import { binToHex } from '@bitauth/libauth';
import type { EpochFileView } from './model.ts';
import type { ActivityIndex, ActivityRun } from '../../src/demo/activity-index.ts';

export type { ActivityIndex, ActivityRun, ActivityTx } from '../../src/demo/activity-index.ts';

export interface TopUp {
  epoch: number;
  previous: number;
  leaves: number;
  total: bigint;
  added: bigint;
}

/** For every epoch after the first: how much the cumulative total grew over the epoch before it. */
export function topUps(epochs: ActivityRun['epochs']): TopUp[] {
  const out: TopUp[] = [];
  for (let i = 1; i < epochs.length; i++) {
    const prev = epochs[i - 1]!;
    const cur = epochs[i]!;
    const total = BigInt(cur.total);
    out.push({ epoch: cur.epoch, previous: prev.epoch, leaves: cur.leaves, total, added: total - BigInt(prev.total) });
  }
  return out;
}

export const refusedCount = (run: ActivityRun): number => run.transactions.filter((t) => t.error !== undefined).length;

/** Transactions in the pool contract's history that no run of this network recorded, newest first; unconfirmed last. */
export function unrecorded(index: ActivityIndex, history: readonly { tx_hash: string; height: number }[]): { txid: string; height: number }[] {
  const known = new Set(index.runs.flatMap((r) => r.transactions.map((t) => t.txid)).filter((t): t is string => t !== null));
  const seen = new Set<string>();
  const out: { txid: string; height: number }[] = [];
  for (const h of history) {
    if (known.has(h.tx_hash) || seen.has(h.tx_hash)) continue;
    seen.add(h.tx_hash);
    out.push({ txid: h.tx_hash, height: h.height });
  }
  const key = (h: number) => (h > 0 ? h : Number.MAX_SAFE_INTEGER);
  return out.sort((a, b) => key(b.height) - key(a.height));
}

export interface EpochEntry {
  epoch: number;
  /** Null when the address has no leaf in that epoch. */
  cumulative: bigint | null;
  /** Growth over the previous epoch that had a leaf; null for the first. */
  topUp: bigint | null;
}

/** The address's cumulative amount in every published epoch, oldest first, with the top-up each epoch added. */
export function epochHistory(files: readonly EpochFileView[], lockingBytecode: Uint8Array): EpochEntry[] {
  const hex = binToHex(lockingBytecode);
  let last: bigint | null = null;
  return [...files]
    .sort((a, b) => a.epoch - b.epoch)
    .map((f) => {
      const leaf = f.leaves.find((l) => l.lockingBytecode === hex);
      const cumulative = leaf ? BigInt(leaf.cumulative) : null;
      const topUp = cumulative !== null && last !== null ? cumulative - last : null;
      if (cumulative !== null) last = cumulative;
      return { epoch: f.epoch, cumulative, topUp };
    });
}
