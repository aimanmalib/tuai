import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { binToHex, decodeTransaction, encodeTransaction, hexToBin, type Output } from '@bitauth/libauth';
import { COST_DOC_PATH, loadCostInputs, renderCostDoc } from '../scripts/cost.ts';
import { decodeTx, measureDistribution } from '../src/cost/distributions.ts';
import { buildPushDistribution, maxRecipientsPerTx, planPush, pushDistributionBytes } from '../src/cost/push.ts';
import { buildCostModel, pushModelFrom } from '../src/cost/report.ts';

const { config, sizes, push } = loadCostInputs();
const model = pushModelFrom(config, sizes.feeRateSatsPerByte);
const dust = BigInt(config.fees.tokenOutputDustSats);

/** The outputs a built push distribution spends: its single input belongs to the distributor (output 0). */
function spentBy(hex: string): Output[] {
  const tx = decodeTx(hex);
  const change = tx.outputs[0]!;
  const paid = tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  return [{ lockingBytecode: change.lockingBytecode, valueSatoshis: paid + BigInt(hex.length / 2) }];
}

describe('push distribution builder', () => {
  it('reproduces the size of every live one-input distribution', () => {
    const live = push.distributions.filter((d) => d.inputs === 1);
    expect(live.length).toBeGreaterThan(0);
    for (const d of live) expect(pushDistributionBytes(d.recipients, model)).toBe(d.bytes);
  });

  it('builds the sponsor layout: change first, then one dust and token output per recipient', () => {
    const hex = buildPushDistribution(3, model);
    const m = measureDistribution('built', hex, spentBy(hex), config.cost.sponsorCategory, dust);
    expect(m).toMatchObject({ recipients: 3, inputs: 1, bytes: hex.length / 2, dustSats: 3 * config.fees.tokenOutputDustSats });
    expect(m?.feeSats).toBe(Math.ceil((hex.length / 2) * sizes.feeRateSatsPerByte));
  });

  it('splits at the standard transaction size', () => {
    const max = maxRecipientsPerTx(config.cost.maxStandardTxBytes, model);
    expect(pushDistributionBytes(max, model)).toBeLessThanOrEqual(config.cost.maxStandardTxBytes);
    expect(() => pushDistributionBytes(max + 1, model)).toThrow(/too large|greater than/i);
    const plan = planPush(2 * max + 1, max, model);
    expect(plan.transactions).toBe(3);
    expect(plan.bytes).toBe(2 * pushDistributionBytes(max, model) + pushDistributionBytes(1, model));
    expect(plan.dustSats).toBe((2 * max + 1) * config.fees.tokenOutputDustSats);
  });
});

describe('distribution classifier', () => {
  const hex = buildPushDistribution(2, model);
  const spent = spentBy(hex);

  it('rejects another category, another dust amount or a foreign input', () => {
    expect(measureDistribution('x', hex, spent, '00'.repeat(32), dust)).toBeUndefined();
    expect(measureDistribution('x', hex, spent, config.cost.sponsorCategory, dust + 1n)).toBeUndefined();
    const foreign = [{ ...spent[0]!, lockingBytecode: hexToBin(`76a914${'11'.repeat(20)}88ac`) }];
    expect(measureDistribution('x', hex, foreign, config.cost.sponsorCategory, dust)).toBeUndefined();
  });

  it('rejects a transaction whose change output carries tokens', () => {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === 'string') throw new Error(tx);
    // Swapping the change to the end leaves a token output at index 0.
    const swapped = { ...tx, outputs: [...tx.outputs.slice(1), tx.outputs[0]!] };
    const altered = binToHex(encodeTransaction(swapped));
    expect(measureDistribution('x', altered, spent, config.cost.sponsorCategory, dust)).toBeUndefined();
  });
});

describe('docs/COST.md', () => {
  it('matches a fresh render (run npm run cost after changing any input)', () => {
    expect(readFileSync(COST_DOC_PATH, 'utf8')).toBe(renderCostDoc());
  });

  it('keeps the pull operator cost flat while push grows with recipients', () => {
    const m = buildCostModel(config, sizes, push);
    const pull = new Set(m.rows.map((r) => r.pullOperatorSats));
    expect(pull.size).toBe(1);
    const pushed = m.rows.map((r) => r.pushSats);
    expect([...pushed].sort((a, b) => a - b)).toEqual(pushed);
    const last = m.rows.at(-1)!;
    expect(last.pushSats).toBeGreaterThan(last.pullOperatorSats);
    expect(m.operatorBreakEvenRecipients).toBeGreaterThanOrEqual(1);
    for (const r of m.rows) {
      expect(r.firstClaimSats).toBeGreaterThan(r.additionalClaimSats);
      // At the break-even interval one claim costs no more than the pushes it replaces; one epoch earlier it costs more.
      const claim = r.additionalClaimSats + r.paymentDustSats;
      expect(claim).toBeLessThanOrEqual(r.breakEvenClaimIntervalEpochs * r.pushPerRecipientSats);
      expect(claim).toBeGreaterThan((r.breakEvenClaimIntervalEpochs - 1) * r.pushPerRecipientSats);
    }
  });
});
