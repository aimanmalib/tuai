import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORT_PATH, renderClaimSizes } from '../scripts/claim-sizes.ts';

describe('reports/claim-sizes.json', () => {
  it('matches a fresh measurement (run npm run claim-sizes after changing the contracts)', async () => {
    const fresh = await renderClaimSizes();
    expect(readFileSync(REPORT_PATH, 'utf8')).toBe(fresh);
    const report = JSON.parse(fresh) as { claims: Array<{ depth: number; firstClaimBytes: number; additionalClaimBytes: number }> };
    for (const c of report.claims) {
      expect(c.additionalClaimBytes).toBeLessThan(c.firstClaimBytes);
      // A standard transaction is at most 100,000 bytes; the deepest proof must stay far below it.
      expect(c.firstClaimBytes).toBeLessThan(5_000);
    }
  });
});
