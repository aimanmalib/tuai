// The two hero numbers on the claim page: worked out from the measured reports, never typed in.
import { describe, expect, it } from 'vitest';
import { heroCostLines, heroCosts, type PushInput, type SizesInput } from '../web/src/hero.ts';
import { loadCostInputs } from '../scripts/cost.ts';
import { buildCostModel } from '../src/cost/report.ts';

const sizes: SizesInput = { feeRateSatsPerByte: 1, operator: { proposeBytes: 1000, activateBytes: 1500 } };

describe('hero costs', () => {
  it('averages fee plus dust over every recipient of every distribution', () => {
    const push: PushInput = {
      distributions: [
        { recipients: 3, feeSats: 417, dustSats: 3000 },
        { recipients: 1, feeSats: 263, dustSats: 1000 },
      ],
    };
    const c = heroCosts(push, sizes);
    expect(c.pushPerRecipientSats).toBe(Math.round((417 + 3000 + 263 + 1000) / 4));
    expect(c.pushDistributions).toBe(2);
  });

  it('charges the operator propose plus activate per epoch, rounded up per transaction', () => {
    const c = heroCosts({ distributions: [{ recipients: 1, feeSats: 1, dustSats: 1 }] }, { feeRateSatsPerByte: 1.5, operator: { proposeBytes: 3, activateBytes: 5 } });
    expect(c.pullOperatorSats).toBe(Math.ceil(4.5) + Math.ceil(7.5));
  });

  it('refuses a push report with nothing to average over', () => {
    expect(() => heroCosts({ distributions: [] }, sizes)).toThrow(/no recipients/);
  });

  it('fills both cost lines with numbers grouped for the locale', () => {
    const c = { pushPerRecipientSats: 1171, pushDistributions: 22, pullOperatorSats: 2709 };
    const seen: Array<[string, Record<string, string>]> = [];
    const lines = heroCostLines(c, (key, vars) => (seen.push([key, vars]), `${key}:${Object.values(vars).join('/')}`), 'en-US');
    expect(lines).toEqual({ push: 'hero.costPush:1,171/22', pull: 'hero.costPull:2,709' });
    expect(seen.map(([k]) => k)).toEqual(['hero.costPush', 'hero.costPull']);
  });

  it('agrees with the cost model in docs/COST.md for the committed reports', () => {
    const { config, sizes: real, push } = loadCostInputs();
    const c = heroCosts(push, real);
    expect(c.pullOperatorSats).toBe(buildCostModel(config, real, push).rows[0]!.pullOperatorSats);
    expect(c.pushDistributions).toBe(push.distributions.length);
    expect(Number.isInteger(c.pushPerRecipientSats)).toBe(true);
    // A live push hands every recipient one dust output, so its per-recipient cost is at least that dust.
    expect(c.pushPerRecipientSats).toBeGreaterThanOrEqual(config.fees.tokenOutputDustSats);
  });
});
