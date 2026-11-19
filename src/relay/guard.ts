// Second line of defence for the relayer (the contracts are the first): before anything is sent, every output of a
// planned claim must pay one of the scripts a claim may touch, and the reward tokens must reach the leaf exactly.
import { binToHex } from '@bitauth/libauth';
import type { Output } from 'cashscript';
import { addressToLockingBytecode } from '../leaf.ts';

export interface GuardScripts {
  /** The leaf's own locking bytecode: the only place reward tokens may leave the pool to. */
  leaf: Uint8Array;
  /** Pool contract (state NFT) and vault contract (reward tokens and receipts). */
  pool: Uint8Array;
  vault: Uint8Array;
  /** The relayer's own address, for BCH change only. */
  relayer: Uint8Array;
}

export interface GuardExpectation {
  rewardCategory: string;
  /** Reward tokens the leaf must receive: cumulative minus claimed. */
  payment: bigint;
}

export const scriptOf = (to: Output['to']): string => binToHex(typeof to === 'string' ? addressToLockingBytecode(to) : to);

/** Returns why the outputs are refused, or null when every output is one a claim may create. */
export function checkClaimOutputs(outputs: readonly Output[], s: GuardScripts, e: GuardExpectation): string | null {
  const leaf = binToHex(s.leaf);
  const contracts = new Set([binToHex(s.pool), binToHex(s.vault)]);
  const relayer = binToHex(s.relayer);
  let paidToLeaf = 0n;
  for (const [i, out] of outputs.entries()) {
    const script = scriptOf(out.to);
    if (script === relayer) {
      if (out.token) return `output ${i} sends tokens to the relayer`;
      continue;
    }
    if (contracts.has(script)) continue;
    if (script !== leaf) return `output ${i} pays a script that is not the leaf, the pool or the relayer`;
    if (!out.token || out.token.category !== e.rewardCategory || out.token.nft) return `output ${i} to the leaf is not a reward token payment`;
    paidToLeaf += out.token.amount;
  }
  if (paidToLeaf !== e.payment) return `the leaf would receive ${paidToLeaf}, not ${e.payment}`;
  return null;
}
