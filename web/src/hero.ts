// The hero above the address form: one sentence, the push and pull drawing (static markup in index.html) and two
// measured costs. Both numbers come from committed reports at build time; nothing here is typed in by hand.
import pushReport from '../../reports/push-distributions.json' with { type: 'json' };
import sizesReport from '../../reports/claim-sizes.json' with { type: 'json' };

/** The parts of reports/push-distributions.json the hero reads. */
export interface PushInput {
  distributions: ReadonlyArray<{ recipients: number; feeSats: number; dustSats: number }>;
}

/** The parts of reports/claim-sizes.json the hero reads. */
export interface SizesInput {
  feeRateSatsPerByte: number;
  operator: { proposeBytes: number; activateBytes: number };
}

export interface HeroCosts {
  /** Fee plus dust the operator spends per recipient on a live push, averaged over every measured distribution. */
  pushPerRecipientSats: number;
  /** How many live distributions the average covers. */
  pushDistributions: number;
  /** Propose plus activate fees: what one pull epoch costs the operator, whatever the recipient count. */
  pullOperatorSats: number;
}

/** Works out the two hero numbers; throws when a report has nothing to measure from. */
export function heroCosts(push: PushInput, sizes: SizesInput): HeroCosts {
  let spent = 0;
  let recipients = 0;
  for (const d of push.distributions) {
    spent += d.feeSats + d.dustSats;
    recipients += d.recipients;
  }
  if (recipients <= 0) throw new Error('push report has no recipients to average over');
  const rate = sizes.feeRateSatsPerByte;
  const fee = (bytes: number) => Math.ceil(bytes * rate);
  return {
    pushPerRecipientSats: Math.round(spent / recipients),
    pushDistributions: push.distributions.length,
    pullOperatorSats: fee(sizes.operator.proposeBytes) + fee(sizes.operator.activateBytes),
  };
}

/** The two numbers for the committed reports, worked out once when the page loads. */
export const HERO_COSTS = heroCosts(pushReport, sizesReport);

type Translate = (key: string, vars: Record<string, string>) => string;

/** The hero's two cost lines, numbers grouped for the locale. */
export function heroCostLines(costs: HeroCosts, translate: Translate, locale: string): { push: string; pull: string } {
  const n = new Intl.NumberFormat(locale);
  return {
    push: translate('hero.costPush', { sats: n.format(costs.pushPerRecipientSats), count: n.format(costs.pushDistributions) }),
    pull: translate('hero.costPull', { sats: n.format(costs.pullOperatorSats) }),
  };
}
