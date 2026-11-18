// The activity view: the published transaction record of one network, then what the pool contracts' history adds to it.
import { t } from './i18n.ts';
import { getJson } from './fetch-json.ts';
import { readHistories } from './electrum.ts';
import { unrecorded, type ActivityIndex } from './activity.ts';
import { renderActivity, renderSeen } from './activity-view.ts';

export interface ActivityNetwork {
  key: string;
  name: string;
  wssUrl: string;
  explorerTxUrl: string | undefined;
}

/** Loads and renders the record, then reads the chain; each call replaces what the previous one drew. */
export async function showActivity(
  target: HTMLElement,
  status: HTMLElement,
  epochsPath: string,
  net: ActivityNetwork,
  timeoutMs: number,
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
  const seen = renderActivity(target, index, net.name, decimals);
  if (index.runs.length === 0) return;
  try {
    const histories = await readHistories(net.wssUrl, timeoutMs, index.runs.map((r) => r.pool));
    renderSeen(seen, unrecorded(index, [...histories.values()].flat()), net.explorerTxUrl);
  } catch (e) {
    const server = new URL(net.wssUrl).hostname;
    renderSeen(seen, { error: t('activity.seen.failed', { server, reason: (e as Error).message }) }, net.explorerTxUrl);
  }
}
