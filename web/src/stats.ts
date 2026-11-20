// The live numbers strip on the Home view, worked out without the DOM. Every number comes from a published file, the
// chain or the relayer; a source that fails leaves its own tile empty with the reason and the others stand.
import type { ActivityIndex } from './activity.ts';
import type { ElectrumUtxo } from './model.ts';

/** A read that either worked or failed with a short reason. */
export type Got<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The parts of the relayer status (relay.ts) the strip reads. */
export interface RelayView {
  enabled: boolean;
  reason?: string;
  claimsLeft?: number;
}

export interface ChainHoldings {
  tip: number;
  pool: readonly ElectrumUtxo[];
  vault: readonly ElectrumUtxo[];
  /** Claim receipts the vault holds: one per address that has claimed at least once. */
  receipts: number;
}

export interface StatsSources {
  /** Active epoch number and its leaf count. */
  epoch: Got<{ epoch: number; leaves: number }>;
  /** The network's activity index (`transactions.json`). */
  index: Got<ActivityIndex>;
  chain: Got<ChainHoldings>;
  /** The pool contract address of the deployment shown; picks the matching run of the index. */
  poolAddress: string | undefined;
  rewardCategory: string | undefined;
  /** Relayer status, or undefined when the network has no relayer. */
  relay: RelayView | undefined;
  /** Fallback for the cost tile when nothing has been recorded: measured claim bytes times the configured fee rate. */
  estimate: { claimBytes: number; satsPerByte: number };
}

export type Tile<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface Stats {
  leaves: Tile<{ epoch: number; leaves: number }>;
  claims: Tile<{ recorded: number; refused: number; claimedOnChain: number | null }>;
  held: Tile<{ sats: number; tokens: bigint }>;
  cost: Tile<{ sats: number; source: 'recorded' | 'estimated'; count: number }>;
  /** Claims the relayer can still pay for; a reason when it is off or cannot be reached; undefined without a relayer. */
  relay: Tile<{ claimsLeft: number }> | undefined;
  tip: number | null;
}

const isClaim = (step: string) => step.includes('claim');

/** The run of the index that recorded the pool shown, or the first run when the pool is unknown. */
function runOf(index: ActivityIndex, pool: string | undefined) {
  return index.runs.find((r) => r.pool === pool) ?? (pool === undefined ? index.runs[0] : undefined);
}

function claimStats(index: ActivityIndex, pool: string | undefined) {
  const run = runOf(index, pool);
  const txs = run?.transactions ?? [];
  const done = txs.filter((t) => isClaim(t.step) && t.error === undefined && t.txid !== null);
  const refused = txs.filter((t) => isClaim(t.step) && t.error !== undefined).length;
  return { done, refused };
}

function sumSats(utxos: readonly ElectrumUtxo[]): number {
  return utxos.reduce((s, u) => s + u.value, 0);
}

function sumTokens(utxos: readonly ElectrumUtxo[], category: string | undefined): bigint {
  let total = 0n;
  for (const u of utxos) {
    const t = u.token_data;
    if (t && (category === undefined || t.category === category) && t.nft === undefined) total += BigInt(t.amount);
  }
  return total;
}

function relayTile(relay: RelayView | undefined): Stats['relay'] {
  if (relay === undefined) return undefined;
  if (relay.enabled && typeof relay.claimsLeft === 'number') return { ok: true, value: { claimsLeft: relay.claimsLeft } };
  return { ok: false, reason: relay.reason ?? 'unreachable' };
}

/** Works out every tile from what was read; nothing here throws. */
export function computeStats(s: StatsSources): Stats {
  const claims = s.index.ok ? claimStats(s.index.value, s.poolAddress) : undefined;
  const chain = s.chain.ok ? s.chain.value : undefined;
  let cost: Stats['cost'];
  if (claims && claims.done.length > 0) {
    const fees = claims.done.reduce((sum, t) => sum + t.feeSats, 0);
    cost = { ok: true, value: { sats: Math.round(fees / claims.done.length), source: 'recorded', count: claims.done.length } };
  } else if (s.estimate.claimBytes > 0 && s.estimate.satsPerByte > 0) {
    cost = { ok: true, value: { sats: Math.ceil(s.estimate.claimBytes * s.estimate.satsPerByte), source: 'estimated', count: 0 } };
  } else {
    cost = { ok: false, reason: s.index.ok ? 'no claims recorded' : s.index.reason };
  }
  return {
    leaves: s.epoch.ok ? { ok: true, value: s.epoch.value } : { ok: false, reason: s.epoch.reason },
    claims: claims
      ? { ok: true, value: { recorded: claims.done.length, refused: claims.refused, claimedOnChain: chain ? chain.receipts : null } }
      : { ok: false, reason: s.index.ok ? '' : s.index.reason },
    held: chain
      ? { ok: true, value: { sats: sumSats(chain.pool) + sumSats(chain.vault), tokens: sumTokens(chain.vault, s.rewardCategory) } }
      : { ok: false, reason: s.chain.ok ? '' : s.chain.reason },
    cost,
    relay: relayTile(s.relay),
    tip: chain ? chain.tip : null,
  };
}

/** Refresh interval in milliseconds, kept inside the 5 to 60 seconds the config check allows. */
export const refreshMs = (seconds: number): number => Math.min(60, Math.max(5, Math.round(seconds))) * 1000;

/** First-claim bytes measured at the given proof depth, or the next deeper one, or the deepest measured; 0 without any. */
export function claimBytesAt(claims: readonly { depth: number; firstClaimBytes: number }[], depth: number): number {
  const sorted = [...claims].sort((a, b) => a.depth - b.depth);
  return (sorted.find((c) => c.depth >= depth) ?? sorted.at(-1))?.firstClaimBytes ?? 0;
}
