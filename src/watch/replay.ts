// Replays real push distributions as an off-chain epoch: every payout of the reward category becomes an allocation,
// summed per recipient, so the watcher can check the same link rules against the people the sponsor actually paid.
import { binToHex } from '@bitauth/libauth';
import { decodeTx } from '../cost/distributions.ts';
import type { AllocationsFile } from '../epoch/inputs.ts';

export interface Payout {
  lockingBytecode: string;
  amount: bigint;
}

/** Fungible amounts of `category` paid by a raw transaction, one entry per output. */
export function payoutsInTransaction(hex: string, category: string): Payout[] {
  return decodeTx(hex)
    .outputs.filter((o) => o.token && binToHex(o.token.category) === category && o.token.amount > 0n)
    .map((o) => ({ lockingBytecode: binToHex(o.lockingBytecode), amount: o.token!.amount }));
}

/** Sums the payouts of every transaction per recipient; recipients are sorted so the input bytes are reproducible. */
export function replayAllocations(hexes: readonly string[], category: string): AllocationsFile {
  const totals = new Map<string, bigint>();
  for (const hex of hexes) {
    for (const p of payoutsInTransaction(hex, category)) totals.set(p.lockingBytecode, (totals.get(p.lockingBytecode) ?? 0n) + p.amount);
  }
  return {
    allocations: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([lockingBytecode, amount]) => ({ lockingBytecode, amount: amount.toString() })),
  };
}
