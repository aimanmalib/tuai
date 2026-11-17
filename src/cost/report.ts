// Push-versus-pull cost model. Every input is measured: claim and root-gate sizes from reports/claim-sizes.json,
// live push distributions and the BCH price from reports/push-distributions.json, push sizes from built transactions.
import { treeDepth } from '../merkle/tree.ts';
import type { TuaiConfig } from '../config.ts';
import type { DistributionMeasurement } from './distributions.ts';
import { maxRecipientsPerTx, planPush, type PushModel, type PushPlan } from './push.ts';

export interface PushDistributionReport {
  description: string;
  generatedBy: string;
  measuredAtUtc: string;
  indexer: string;
  electrum: string;
  category: string;
  candidatesChecked: number;
  price: { usdPerBch: number; source: string; measuredAtUtc: string };
  distributions: Array<DistributionMeasurement & { blockHeight: number; blockTimeUtc: string }>;
}

/** The parts of reports/claim-sizes.json the cost model reads. */
export interface ClaimSizes {
  feeRateSatsPerByte: number;
  claims: Array<{ depth: number; firstClaimBytes: number; additionalClaimBytes: number }>;
  operator: { proposeBytes: number; activateBytes: number };
}

export interface CostRow {
  recipients: number;
  push: PushPlan;
  /** Fee plus dust the distributor spends on one push epoch. */
  pushSats: number;
  /** Propose plus activate fees, paid once per epoch whatever the recipient count. */
  pullOperatorSats: number;
  depth: number;
  firstClaimBytes: number;
  additionalClaimBytes: number;
  /** Claimant's fee plus the receipt dust that stays in the pool. */
  firstClaimSats: number;
  additionalClaimSats: number;
  /** Dust on the claimant's own payment output; it stays with the claimant. */
  paymentDustSats: number;
  /** What one recipient's share of a push epoch costs: fee share plus the dust sent to them. */
  pushPerRecipientSats: number;
  /** Fewest epochs between claims at which one pull claim costs no more than the pushes it replaces. */
  breakEvenClaimIntervalEpochs: number;
}

export interface CostModel {
  feeRate: number;
  epochsPerYear: number;
  maxStandardTxBytes: number;
  maxRecipientsPerTx: number;
  usdPerBch: number;
  /** Smallest recipient count at which one push epoch costs the distributor more than one pull epoch. */
  operatorBreakEvenRecipients: number;
  rows: CostRow[];
}

export const pushModelFrom = (config: TuaiConfig, feeRate: number): PushModel => ({
  category: config.cost.sponsorCategory,
  amountPerRecipient: BigInt(config.cost.pushTokenAmountPerRecipient),
  dustSats: BigInt(config.fees.tokenOutputDustSats),
  feeRate,
});

const fee = (bytes: number, rate: number): number => Math.ceil(bytes * rate);

export function buildCostModel(config: TuaiConfig, sizes: ClaimSizes, push: PushDistributionReport): CostModel {
  const rate = sizes.feeRateSatsPerByte;
  const model = pushModelFrom(config, rate);
  const maxPerTx = maxRecipientsPerTx(config.cost.maxStandardTxBytes, model);
  const pullOperatorSats = fee(sizes.operator.proposeBytes, rate) + fee(sizes.operator.activateBytes, rate);
  const pushSatsFor = (n: number) => {
    const p = planPush(n, maxPerTx, model);
    return p.feeSats + p.dustSats;
  };
  let operatorBreakEvenRecipients = 1;
  while (pushSatsFor(operatorBreakEvenRecipients) <= pullOperatorSats) operatorBreakEvenRecipients += 1;

  const rows = config.cost.recipientCounts.map((recipients): CostRow => {
    const depth = Math.max(1, treeDepth(recipients));
    const claim = sizes.claims.find((c) => c.depth === depth);
    if (!claim) throw new Error(`reports/claim-sizes.json has no claim measured at depth ${depth}; run npm run claim-sizes`);
    const plan = planPush(recipients, maxPerTx, model);
    const paymentDustSats = config.fees.tokenOutputDustSats;
    const additionalClaimSats = fee(claim.additionalClaimBytes, rate);
    const pushPerRecipientSats = Math.ceil((plan.feeSats + plan.dustSats) / recipients);
    return {
      recipients,
      push: plan,
      pushSats: plan.feeSats + plan.dustSats,
      pullOperatorSats,
      depth,
      firstClaimBytes: claim.firstClaimBytes,
      additionalClaimBytes: claim.additionalClaimBytes,
      firstClaimSats: fee(claim.firstClaimBytes, rate) + config.fees.receiptDustSats,
      additionalClaimSats,
      paymentDustSats,
      pushPerRecipientSats,
      // Both models hand the recipient one dust output, so the dust is counted on both sides.
      breakEvenClaimIntervalEpochs: Math.ceil((additionalClaimSats + paymentDustSats) / pushPerRecipientSats),
    };
  });
  return {
    feeRate: rate,
    epochsPerYear: config.cost.epochsPerYear,
    maxStandardTxBytes: config.cost.maxStandardTxBytes,
    maxRecipientsPerTx: maxPerTx,
    usdPerBch: push.price.usdPerBch,
    operatorBreakEvenRecipients,
    rows,
  };
}
