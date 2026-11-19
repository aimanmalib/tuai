// Shared by the relayer and the wallet prepare route: what a leaf may claim now, read from the chain.
import { binToHex } from '@bitauth/libauth';
import { findLeaf, type EpochFile, type LeafJson } from '../epoch/file.ts';
import { findReceipt, receiptKey } from '../pool/encoding.ts';
import type { PoolContracts } from '../pool/contracts.ts';
import { readPool, type PoolUtxos } from '../pool/utxos.ts';

export interface RelayReply {
  status: number;
  body: Record<string, unknown>;
}

export const reply = (status: number, code: string, extra: Record<string, unknown> = {}): RelayReply => ({ status, body: { code, ...extra } });
export const firstLine = (e: unknown): string => ((e as Error).message ?? String(e)).split('\n')[0]?.slice(0, 300) ?? 'error';

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the chain server did not answer in time')), ms)));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export interface LeafLookup {
  pool: PoolUtxos;
  entry: LeafJson;
  claimed: bigint;
  claimable: bigint;
}

/** Reads the pool and the leaf's receipt; a claim uses the epoch file holding the pool's active root. */
export async function lookupLeaf(
  contracts: PoolContracts,
  epochs: readonly EpochFile[],
  lockingBytecode: Uint8Array,
  ms: number,
): Promise<LeafLookup | RelayReply> {
  const pool = await withTimeout(readPool(contracts), ms);
  const file = epochs.find((f) => f.root === binToHex(pool.decodedState.root) && f.epoch === pool.decodedState.epoch);
  if (!file) return reply(503, 'epochMissing', { epoch: pool.decodedState.epoch });
  const entry = findLeaf(file, binToHex(lockingBytecode));
  if (!entry) return reply(404, 'notInEpoch', { epoch: file.epoch });
  const own = findReceipt(pool.receipts, (r) => r.receipt, receiptKey(lockingBytecode));
  const claimed = own?.kind === 'own' ? own.receipt.claimed : 0n;
  const cumulative = BigInt(entry.cumulative);
  return { pool, entry, claimed, claimable: cumulative > claimed ? cumulative - claimed : 0n };
}
