import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORT_PATH, renderClaimSizes } from '../scripts/claim-sizes.ts';
import { DEPTH_DOC_PATH, depthLimits, type ClaimSizeReport } from '../scripts/depth-doc.ts';

describe('reports/claim-sizes.json and docs/DEPTH.md', () => {
  it('match a fresh measurement (run npm run claim-sizes after changing the contracts)', async () => {
    const fresh = await renderClaimSizes();
    expect(readFileSync(REPORT_PATH, 'utf8')).toBe(fresh.report);
    expect(readFileSync(DEPTH_DOC_PATH, 'utf8')).toBe(fresh.depthDoc);
    const report = JSON.parse(fresh.report) as ClaimSizeReport;
    for (const c of report.claims) {
      expect(c.additionalClaimBytes).toBeLessThan(c.firstClaimBytes);
      expect(c.poolInput.operationCost).toBeLessThan(c.poolInput.maximumOperationCost);
      expect(c.poolInput.hashDigestIterations).toBeLessThan(c.poolInput.maximumHashDigestIterations);
    }
    // The configured maximum depth must sit inside every VM limit the measurements extrapolate to.
    const limits = depthLimits(report);
    expect(limits.maxDepth).toBeGreaterThanOrEqual(24);
    expect(report.operator.proposeBytes).toBeGreaterThan(0);
    expect(report.operator.activateBytes).toBeGreaterThan(0);
    // Measuring evaluates every transaction in the VM debugger twice; allow for a busy CI host.
  }, 240_000);
});
