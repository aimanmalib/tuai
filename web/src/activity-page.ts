// The activity view: the published transaction record of one network, then what the pool contracts' history adds to it,
// then the page's own check of every listed transaction on chain.
import { t } from './i18n.ts';
import { getJson } from './fetch-json.ts';
import { checkOnChain, readHistories } from './electrum.ts';
import { unrecorded, type ActivityIndex } from './activity.ts';
import { pendingChecks, renderActivity, renderSeen, showChainCheck } from './activity-view.ts';
import type { Explorer } from '../../src/explorers.ts';

export interface ActivityNetwork {
  key: string;
  name: string;
  wssUrl: string;
  explorers: Explorer[];
}

export interface ActivityLimits {
  timeoutMs: number;
  /** Transactions asked about at the same time. */
  concurrency: number;
}

/** Loads and renders the record, then reads the chain; each call replaces what the previous one drew. */
export async function showActivity(
  target: HTMLElement,
  status: HTMLElement,
  epochsPath: string,
  net: ActivityNetwork,
  limits: ActivityLimits,
  decimals: number,
): Promise<void> {
  status.className = 'status';
  status.textContent = t('activity.loading');
  let index: ActivityIndex;
  try {
    index = await getJson<ActivityIndex>(`${epochsPath}/${net.key}/transactions.json`);
  } catch (e) {
    target.replaceChildren();
    status.className = 'status error';
    status.textContent = t('activity.failed', { reason: (e as Error).message });
    return;
  }
  status.textContent = '';
  const server = new URL(net.wssUrl).hostname;
  const seen = renderActivity(target, index, net.name, server, decimals);
  if (index.runs.length === 0) return;
  const check = (txids: string[]) =>
    checkOnChain(net.wssUrl, limits.timeoutMs, txids, limits.concurrency, (txid, verdict) => showChainCheck(target, txid, verdict, server));
  const recorded = check(pendingChecks(target));
  try {
    const histories = await readHistories(net.wssUrl, limits.timeoutMs, index.runs.map((r) => r.pool));
    renderSeen(seen, unrecorded(index, [...histories.values()].flat()), net.explorers);
    await Promise.all([recorded, check(pendingChecks(seen))]);
  } catch (e) {
    renderSeen(seen, { error: t('activity.seen.failed', { server, reason: (e as Error).message }) }, net.explorers);
    await recorded;
  }
}
