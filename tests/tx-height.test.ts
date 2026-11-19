import { describe, expect, it } from 'vitest';
import { confirmedHeight, type HeightSource } from '../src/tx-height.ts';

/**
 * A chain whose tip advances by one block at chosen moments: after the n-th tip read, or at the start of the n-th
 * confirmations call (before that call counts confirmations from the new tip).
 */
function chain(
  start: number,
  blocks: { afterTipReads?: number[]; duringConfirmations?: number[] },
  minedAt: number | null,
): HeightSource {
  let tipReads = 0;
  let confCalls = 0;
  let tip = start;
  return {
    tip: async () => {
      tipReads++;
      if (blocks.afterTipReads?.includes(tipReads)) tip++;
      return tip;
    },
    confirmations: async () => {
      confCalls++;
      if (blocks.duringConfirmations?.includes(confCalls)) tip++;
      return minedAt === null ? 0 : tip - minedAt + 1;
    },
  };
}

describe('confirmedHeight', () => {
  it('returns the block height when the tip is steady', async () => {
    expect(await confirmedHeight(chain(337400, {}, 337326), 'a')).toBe(337326);
  });

  it('is not one short when a block arrives between the tip and the confirmations', async () => {
    // The first tip read sees 337400, then block 337401 arrives before the first confirmations call counts,
    // so it reports 76. Pairing that with the earlier tip would give 337400 - 76 + 1 = 337325.
    expect(await confirmedHeight(chain(337400, { duringConfirmations: [1] }, 337326), 'a')).toBe(337326);
  });

  it('returns null for an unconfirmed transaction', async () => {
    expect(await confirmedHeight(chain(337400, {}, null), 'a')).toBeNull();
  });

  it('gives up when the tip keeps moving', async () => {
    await expect(confirmedHeight(chain(1, { afterTipReads: [2, 4, 6] }, 1), 'a', 3)).rejects.toThrow(/kept moving/);
  });
});
