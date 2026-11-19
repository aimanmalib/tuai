import { describe, expect, it } from 'vitest';
import { confirmedHeight, type HeightSource } from '../src/tx-height.ts';

/** A chain whose tip advances by one block after the given number of tip reads. */
function chain(start: number, blockAfterReads: number[], minedAt: number | null): HeightSource {
  let reads = 0;
  let tip = start;
  return {
    tip: async () => {
      reads++;
      if (blockAfterReads.includes(reads)) tip++;
      return tip;
    },
    confirmations: async () => (minedAt === null ? 0 : tip - minedAt + 1),
  };
}

describe('confirmedHeight', () => {
  it('returns the block height when the tip is steady', async () => {
    expect(await confirmedHeight(chain(337400, [], 337326), 'a')).toBe(337326);
  });

  it('is not one short when a block arrives between the tip and the confirmations', async () => {
    // First tip read sees 337400, then a block arrives before confirmations are read (75 + 1).
    // Reading the tip once at the start would give 337400 - 76 + 1 = 337325.
    expect(await confirmedHeight(chain(337400, [2], 337326), 'a')).toBe(337326);
  });

  it('returns null for an unconfirmed transaction', async () => {
    expect(await confirmedHeight(chain(337400, [], null), 'a')).toBeNull();
  });

  it('gives up when the tip keeps moving', async () => {
    await expect(confirmedHeight(chain(1, [2, 4, 6], 1), 'a', 3)).rejects.toThrow(/kept moving/);
  });
});
