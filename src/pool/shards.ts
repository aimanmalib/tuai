import type { SpendableUtxo } from 'cashscript';
import type { PoolState } from './encoding.ts';

/** Upper bound on shards: each one adds two outputs to the deploy transaction. */
export const MAX_SHARDS = 64;

/** One copy of the pool's minting state NFT. A sharded pool holds several; each claim spends one (ADR 0013). */
export interface StateShard {
  utxo: SpendableUtxo;
  state: PoolState;
}

const outpoint = (u: SpendableUtxo): string => `${u.txid}:${u.vout.toString().padStart(10, '0')}`;

/** A stable order (by outpoint), so two readers of the same UTXO set agree on shard numbers. */
export const byOutpoint = <T>(items: readonly T[], utxo: (item: T) => SpendableUtxo): T[] =>
  [...items].sort((a, b) => (outpoint(utxo(a)) < outpoint(utxo(b)) ? -1 : outpoint(utxo(a)) > outpoint(utxo(b)) ? 1 : 0));

/** The shard holding the newest epoch (the first such shard by outpoint). */
export function newestShard(shards: readonly StateShard[]): StateShard {
  const first = shards[0];
  if (!first) throw new Error('the pool has no state NFT');
  return shards.reduce((best, s) => (s.state.epoch > best.state.epoch ? s : best), first);
}

/** Spreads claimants over shards: the first 4 bytes of the receipt key, read as an unsigned integer. */
export function shardSlot(key: Uint8Array, count: number): number {
  if (count <= 1) return 0;
  const prefix = new DataView(key.buffer, key.byteOffset, key.byteLength).getUint32(0);
  return prefix % count;
}

/**
 * Picks the state NFT and reward token UTXO for one claim. Only shards holding the newest state qualify (the proof is
 * for that root). Different keys start at different slots, so claims built from the same snapshot of the pool spend
 * different UTXOs and can be broadcast in the same block. Reward UTXOs are tried in a ring from the key's slot; the
 * first one holding more than the payment is used (the contract keeps a non-zero token output in the vault).
 */
export function pickShard(
  shards: readonly StateShard[],
  rewards: readonly SpendableUtxo[],
  key: Uint8Array,
  payment: bigint,
): { state: SpendableUtxo; reward: SpendableUtxo | undefined } {
  const newest = newestShard(shards).state;
  const current = byOutpoint(
    shards.filter((s) => s.state.epoch === newest.epoch),
    (s) => s.utxo,
  );
  const state = current[shardSlot(key, current.length)] as StateShard;
  const ring = byOutpoint(rewards, (u) => u);
  const start = shardSlot(key, ring.length);
  const reward = ring.map((_, i) => ring[(start + i) % ring.length] as SpendableUtxo).find((u) => (u.token?.amount ?? 0n) > payment);
  return { state: state.utxo, reward };
}

/** Splits `total` reward tokens into `count` amounts; the first takes the remainder. */
export function splitAmount(total: bigint, count: number): bigint[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('shards must be a whole number of at least 1');
  const part = total / BigInt(count);
  if (part < 1n) throw new RangeError(`cannot split ${total} reward tokens into ${count} shards`);
  return Array.from({ length: count }, (_, i) => (i === 0 ? part + (total % BigInt(count)) : part));
}
