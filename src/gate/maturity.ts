// Relative timelock arithmetic for root activation (BIP68, block-based).

/** Sequence number for an input that must be `delay` blocks old; the type flag (bit 22) stays clear for blocks. */
export function blockSequence(delay: number): number {
  if (!Number.isInteger(delay) || delay < 0 || delay > 0xffff) throw new RangeError(`delay must be 0..65535 blocks: ${delay}`);
  return delay;
}

/**
 * Blocks left before a pending root confirmed at `confirmedHeight` can be activated in a block at `tipHeight + 1`.
 * Returns undefined while the pending UTXO is unconfirmed.
 */
export function blocksUntilActivation(confirmedHeight: number | undefined, delay: number, tipHeight: number): number | undefined {
  if (confirmedHeight === undefined || confirmedHeight <= 0) return undefined;
  // A UTXO mined at height h has age (H - h) in a block at height H; BIP68 needs that age to reach `delay`.
  const firstHeight = confirmedHeight + delay;
  return Math.max(0, firstHeight - (tipHeight + 1));
}

/** Median of the timestamps of a block and the ten before it (BIP113), given oldest-to-newest or any order. */
export function medianTimePast(timestamps: readonly number[]): number {
  if (timestamps.length === 0) throw new Error('no block timestamps');
  const sorted = [...timestamps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Seconds left when the node reads a block-count sequence lock as `secondsPerBlock` units of median time past, as
 * measured on chipnet after one-minute blocks: the lock is met once the tip's median time past reaches the median
 * time past of the block before the pending UTXO's block plus `delay * secondsPerBlock`.
 */
export function secondsUntilActivation(
  coinPrevMtp: number | undefined,
  delay: number,
  tipMtp: number,
  secondsPerBlock: number,
): number | undefined {
  if (coinPrevMtp === undefined) return undefined;
  return Math.max(0, coinPrevMtp + delay * secondsPerBlock - tipMtp);
}
