import { MAX_UINT63, hexToBinChecked } from '../bytes.ts';
import { MAX_LOCKING_BYTECODE, type Leaf, type LinkMethod } from '../leaf.ts';

/**
 * Per-recipient running totals carried from one epoch to the next.
 *
 * - `cumulative` is everything ever allocated; it never decreases, so a later root always covers earlier ones.
 * - `highWater` is the largest credit (work points) seen for the recipient. New work is measured above it, so a
 *   credit that dips and recovers is not paid twice.
 */
export interface Balance {
  method: LinkMethod;
  cumulative: bigint;
  highWater: bigint;
}

/** Keyed by locking bytecode in lowercase hex: one leaf, one receipt, one payout script per recipient. */
export type Balances = Map<string, Balance>;

export interface CreditInput {
  lockingBytecode: string;
  method: LinkMethod;
  /** Total credit reported by the source at the end of the period (not the change). */
  credit: bigint;
}

export interface Allocation {
  lockingBytecode: string;
  method: LinkMethod;
  amount: bigint;
}

export interface EpochResult {
  balances: Balances;
  /** Amount added for each recipient in this epoch (only recipients with a non-zero share). */
  shares: Map<string, bigint>;
  /** Part of the budget not allocated because nobody did new work. */
  undistributed: bigint;
}

function checkKey(key: string): void {
  const bytes = hexToBinChecked(key);
  if (bytes.length === 0 || bytes.length > MAX_LOCKING_BYTECODE) throw new Error(`bad locking bytecode key: ${key}`);
}

function checkMethod(prev: Balance | undefined, method: LinkMethod, key: string): void {
  if (prev && prev.method !== method) throw new Error(`recipient ${key} changed link method; issue a new leaf instead`);
}

/** Work done since the high-water mark. A dip below the mark counts as zero, not as negative work. */
export const newWork = (highWater: bigint, credit: bigint): bigint => (credit > highWater ? credit - highWater : 0n);

/**
 * Splits `budget` in proportion to `weights` with integer floors, then hands out the remainder one unit at a time
 * to the largest fractional parts (ties: lower key first). The shares always sum to exactly `budget` when any
 * weight is positive.
 */
export function splitBudget(weights: ReadonlyMap<string, bigint>, budget: bigint): Map<string, bigint> {
  if (budget < 0n) throw new RangeError('budget must not be negative');
  let total = 0n;
  for (const [key, w] of weights) {
    if (w < 0n) throw new RangeError(`negative weight for ${key}`);
    total += w;
  }
  const shares = new Map<string, bigint>();
  if (total === 0n) return shares;
  const remainders: { key: string; rest: bigint }[] = [];
  let given = 0n;
  for (const [key, w] of weights) {
    if (w === 0n) continue;
    const product = budget * w;
    const share = product / total;
    shares.set(key, share);
    given += share;
    remainders.push({ key, rest: product % total });
  }
  remainders.sort((a, b) => (a.rest === b.rest ? (a.key < b.key ? -1 : 1) : a.rest > b.rest ? -1 : 1));
  let left = budget - given;
  for (const { key } of remainders) {
    if (left === 0n) break;
    shares.set(key, (shares.get(key) ?? 0n) + 1n);
    left -= 1n;
  }
  for (const [key, s] of shares) if (s === 0n) shares.delete(key);
  return shares;
}

function addShares(prev: Balances, shares: Map<string, bigint>, next: Balances): void {
  for (const [key, share] of shares) {
    const b = next.get(key) as Balance;
    const cumulative = b.cumulative + share;
    if (cumulative > MAX_UINT63) throw new RangeError(`cumulative amount overflows for ${key}`);
    next.set(key, { ...b, cumulative });
  }
  for (const [key, b] of next) {
    const before = prev.get(key);
    if (before && b.cumulative < before.cumulative) throw new Error(`cumulative amount decreased for ${key}`);
  }
}

/**
 * Advances balances by one epoch from end-of-period credits: each recipient's new work above its high-water mark
 * earns a proportional share of `budget`. Recipients missing from `credits` keep their totals.
 */
export function advanceEpoch(prev: Balances, credits: readonly CreditInput[], budget: bigint): EpochResult {
  const next: Balances = new Map([...prev].map(([k, b]) => [k, { ...b }]));
  const work = new Map<string, bigint>();
  for (const { lockingBytecode: key, method, credit } of credits) {
    checkKey(key);
    if (credit < 0n) throw new RangeError(`negative credit for ${key}`);
    if (work.has(key)) throw new Error(`duplicate recipient ${key}`);
    const before = next.get(key);
    checkMethod(before, method, key);
    const highWater = before?.highWater ?? 0n;
    work.set(key, newWork(highWater, credit));
    next.set(key, {
      method,
      cumulative: before?.cumulative ?? 0n,
      highWater: credit > highWater ? credit : highWater,
    });
  }
  const shares = splitBudget(work, budget);
  addShares(prev, shares, next);
  const given = [...shares.values()].reduce((a, b) => a + b, 0n);
  return { balances: next, shares, undistributed: budget - given };
}

/** Adds amounts that were already split by the source (for example a per-user distribution list). */
export function addAllocations(prev: Balances, allocations: readonly Allocation[]): EpochResult {
  const next: Balances = new Map([...prev].map(([k, b]) => [k, { ...b }]));
  const shares = new Map<string, bigint>();
  for (const { lockingBytecode: key, method, amount } of allocations) {
    checkKey(key);
    if (amount < 0n) throw new RangeError(`negative amount for ${key}`);
    const before = next.get(key);
    checkMethod(before, method, key);
    if (!before) next.set(key, { method, cumulative: 0n, highWater: 0n });
    if (amount > 0n) shares.set(key, (shares.get(key) ?? 0n) + amount);
  }
  addShares(prev, shares, next);
  return { balances: next, shares, undistributed: 0n };
}

/** Leaves in a fixed order (locking bytecode hex, ascending), skipping recipients that have earned nothing. */
export function balancesToLeaves(balances: Balances): Leaf[] {
  return [...balances.entries()]
    .filter(([, b]) => b.cumulative > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, b]) => ({ method: b.method, cumulative: b.cumulative, lockingBytecode: hexToBinChecked(key) }));
}
