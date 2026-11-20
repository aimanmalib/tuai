// The small mainnet card on the home page, without the DOM: how many claims the published mainnet record holds and
// which one is the newest. Every number comes from the activity index the build writes from deployments/; nothing here
// is fixed in code.
import { explorerLinks, type Explorer, type ExplorerLink } from '../../src/explorers.ts';
import { isClaim } from './stats.ts';
import type { ActivityIndex, ActivityTx } from './activity.ts';

export interface MainnetClaim {
  txid: string;
  /** Block height in the record; null when it was recorded before it was mined. */
  height: number | null;
  utc: string;
  links: ExplorerLink[];
}

export interface MainnetSummary {
  /** Claim transactions the node accepted, across every mainnet run. */
  claims: number;
  /** Claim attempts the node refused. */
  refused: number;
  latest: MainnetClaim | null;
}

type Accepted = ActivityTx & { txid: string };

const accepted = (t: ActivityTx): t is Accepted => isClaim(t.step) && t.error === undefined && t.txid !== null;

/** Mined first by height, then by the time it was sent; unmined ones count as newest. */
function newer(a: Accepted, b: Accepted): boolean {
  const ha = a.height ?? Number.MAX_SAFE_INTEGER;
  const hb = b.height ?? Number.MAX_SAFE_INTEGER;
  return ha !== hb ? ha > hb : a.utc > b.utc;
}

/** Counts and picks the newest claim; links use the explorers configured for mainnet, primary first. */
export function mainnetSummary(index: ActivityIndex, explorers: readonly Explorer[]): MainnetSummary {
  const txs = index.runs.flatMap((r) => r.transactions);
  const done = txs.filter(accepted);
  const refused = txs.filter((t) => isClaim(t.step) && t.error !== undefined).length;
  const top = done.reduce<Accepted | null>((best, t) => (best === null || newer(t, best) ? t : best), null);
  const latest = top && { txid: top.txid, height: top.height, utc: top.utc, links: explorerLinks(explorers, top.txid) };
  return { claims: done.length, refused, latest };
}

/** The txid shortened for display: first and last characters, the full one stays in the link and its title. */
export const shortTxid = (txid: string, keep = 8): string => (txid.length <= keep * 2 + 1 ? txid : `${txid.slice(0, keep)}…${txid.slice(-keep)}`);
