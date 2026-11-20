// Reads what the live numbers strip needs for one network: the published record, the chain and the relayer.
// Epoch files never change once published, so they come from the shared cache; the activity index is read fresh.
import sizesReport from '../../reports/claim-sizes.json' with { type: 'json' };
import { getJson } from './fetch-json.ts';
import { readChain } from './electrum.ts';
import { chainViewFrom, type EpochFileView, type PoolRecord } from './model.ts';
import { relayStatus } from './relay.ts';
import { claimBytesAt, type Got, type StatsSources } from './stats.ts';
import type { ActivityIndex } from './activity.ts';

export interface StatsTarget {
  network: string;
  epochsPath: string;
  wssUrl: string;
  timeoutMs: number;
  /** The relayer status path when this network has a relayer. */
  relayPath: string | undefined;
  satsPerByte: number;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function fresh<T>(path: string, timeoutMs: number): Promise<T> {
  const r = await fetch(path, { cache: 'no-cache', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return (await r.json()) as T;
}

/** Every source read at once; each failure is kept as that source's reason. */
export async function loadStats(target: StatsTarget): Promise<StatsSources> {
  const base = `${target.epochsPath}/${target.network}`;
  const indexRead = fresh<ActivityIndex>(`${base}/transactions.json`, target.timeoutMs).then(
    (value): Got<ActivityIndex> => ({ ok: true, value }),
    (e): Got<ActivityIndex> => ({ ok: false, reason: reason(e) }),
  );
  const relayRead = target.relayPath === undefined ? Promise.resolve(undefined) : relayStatus(target.relayPath, target.timeoutMs);
  let record: PoolRecord | undefined;
  let chain: StatsSources['chain'];
  let active: number | undefined;
  try {
    record = await getJson<PoolRecord>(`${base}/pool.json`);
    const reads = await readChain(target.wssUrl, target.timeoutMs, record.contracts);
    const view = chainViewFrom(record, reads.tip, reads.pool, reads.gate, reads.vault);
    active = view.active.epoch;
    chain = { ok: true, value: { tip: reads.tip, pool: reads.pool, vault: reads.vault, receipts: view.receipts.length } };
  } catch (e) {
    chain = { ok: false, reason: reason(e) };
  }
  // Without the chain, the newest published epoch stands in for the active one.
  let epoch: StatsSources['epoch'];
  let depth = 0;
  try {
    const n = active ?? (await fresh<{ epochs: number[] }>(`${base}/index.json`, target.timeoutMs)).epochs.at(-1);
    if (n === undefined) throw new Error('no epoch published');
    const file = await getJson<EpochFileView>(`${base}/epoch-${n}.json`);
    depth = file.depth;
    epoch = { ok: true, value: { epoch: file.epoch, leaves: file.leaves.length } };
  } catch (e) {
    epoch = { ok: false, reason: reason(e) };
  }
  return {
    epoch,
    index: await indexRead,
    chain,
    poolAddress: record?.contracts.pool,
    rewardCategory: record?.rewardCategory,
    relay: await relayRead,
    estimate: { claimBytes: claimBytesAt(sizesReport.claims, depth), satsPerByte: target.satsPerByte },
  };
}
