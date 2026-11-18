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

