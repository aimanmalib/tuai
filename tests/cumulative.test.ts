import { describe, expect, it } from 'vitest';
import {
  addAllocations,
  advanceEpoch,
  balancesToLeaves,
  newWork,
  splitBudget,
  type Balances,
  type CreditInput,
} from '../src/epoch/cumulative.ts';
import { LinkMethod } from '../src/leaf.ts';

const key = (n: number) => '76a914' + n.toString(16).padStart(2, '0').repeat(20) + '88ac';
const credit = (n: number, value: bigint): CreditInput => ({ lockingBytecode: key(n), method: LinkMethod.fahName, credit: value });
const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

describe('splitBudget', () => {
  it('splits proportionally and sums to the budget exactly', () => {
    const shares = splitBudget(new Map([['a', 1n], ['b', 1n], ['c', 1n]]), 100n);
    expect(sum(shares)).toBe(100n);
    expect([...shares.values()].sort()).toEqual([33n, 33n, 34n]);
    expect(shares.get('a')).toBe(34n);
  });

  it('gives the remainder to the largest fractional parts', () => {
    const shares = splitBudget(new Map([['a', 7n], ['b', 2n], ['c', 1n]]), 9n);
    // exact: 6.3, 1.8, 0.9 -> floors 6, 1, 0; the remaining 2 go to c (0.9) and then b (0.8)
    expect(Object.fromEntries(shares)).toEqual({ a: 6n, b: 2n, c: 1n });
  });

  it('is exact for many recipients and large budgets', () => {
    const weights = new Map(Array.from({ length: 997 }, (_, i) => [`k${i}`, BigInt((i * 7919) % 1013) + 1n] as const));
    for (const budget of [1n, 999n, 10n ** 15n + 7n]) expect(sum(splitBudget(weights, budget))).toBe(budget);
  });

  it('returns nothing when no weight is positive and rejects negatives', () => {
    expect(splitBudget(new Map([['a', 0n]]), 50n).size).toBe(0);
    expect(() => splitBudget(new Map([['a', -1n]]), 50n)).toThrow(RangeError);
    expect(() => splitBudget(new Map([['a', 1n]]), -1n)).toThrow(RangeError);
  });
});

describe('advanceEpoch', () => {
  it('pays the full budget across recipients with new work', () => {
    const r = advanceEpoch(new Map(), [credit(1, 300n), credit(2, 100n)], 1000n);
    expect(r.balances.get(key(1))?.cumulative).toBe(750n);
    expect(r.balances.get(key(2))?.cumulative).toBe(250n);
    expect(r.undistributed).toBe(0n);
  });

  it('keeps cumulative amounts non-decreasing, including for absent recipients', () => {
    let balances: Balances = new Map();
    const history: Balances[] = [];
    const periods = [
      [credit(1, 10n), credit(2, 10n)],
      [credit(1, 15n)],
      [credit(2, 30n), credit(3, 5n)],
      [credit(1, 12n), credit(2, 30n)],
    ];
    for (const p of periods) {
      balances = advanceEpoch(balances, p, 600n).balances;
      history.push(balances);
    }
    for (let e = 1; e < history.length; e += 1) {
      for (const [k, b] of history[e - 1] as Balances) {
        expect((history[e] as Balances).get(k)?.cumulative ?? -1n).toBeGreaterThanOrEqual(b.cumulative);
      }
    }
  });

  it('does not count a credit dip twice (high-water mark)', () => {
    expect(newWork(100n, 80n)).toBe(0n);
    expect(newWork(100n, 120n)).toBe(20n);
    let b: Balances = advanceEpoch(new Map(), [credit(1, 100n), credit(2, 100n)], 0n).balances; // baseline
    b = advanceEpoch(b, [credit(1, 80n), credit(2, 100n)], 0n).balances; // recipient 1 dips
    expect(b.get(key(1))?.highWater).toBe(100n);
    const r = advanceEpoch(b, [credit(1, 120n), credit(2, 120n)], 1000n);
    // Both did 20 points of real work above their previous best, so they split evenly.
    expect(r.shares.get(key(1))).toBe(500n);
    expect(r.shares.get(key(2))).toBe(500n);
  });

  it('reports the budget as undistributed when nobody did new work', () => {
    const b = advanceEpoch(new Map(), [credit(1, 50n)], 100n).balances;
    const r = advanceEpoch(b, [credit(1, 50n)], 100n);
    expect(r.undistributed).toBe(100n);
    expect(r.balances.get(key(1))?.cumulative).toBe(100n);
  });

  it('rejects duplicates, negative credit, malformed keys and method changes', () => {
    expect(() => advanceEpoch(new Map(), [credit(1, 1n), credit(1, 2n)], 10n)).toThrow(/duplicate/);
    expect(() => advanceEpoch(new Map(), [credit(1, -1n)], 10n)).toThrow(RangeError);
    expect(() => advanceEpoch(new Map(), [{ ...credit(1, 1n), lockingBytecode: 'XYZ' }], 10n)).toThrow(/hex/);
    const b = advanceEpoch(new Map(), [credit(1, 1n)], 10n).balances;
    expect(() =>
      advanceEpoch(b, [{ ...credit(1, 2n), method: LinkMethod.compatibilityMapping }], 10n),
    ).toThrow(/link method/);
  });

  it('does not mutate the previous balances', () => {
    const b = advanceEpoch(new Map(), [credit(1, 10n)], 10n).balances;
    advanceEpoch(b, [credit(1, 20n)], 10n);
    expect(b.get(key(1))).toEqual({ method: 0, cumulative: 10n, highWater: 10n });
  });
});

describe('addAllocations and leaves', () => {
  it('adds pre-split amounts and refuses negatives', () => {
    const r = addAllocations(new Map(), [
      { lockingBytecode: key(1), method: LinkMethod.fahName, amount: 5n },
      { lockingBytecode: key(1), method: LinkMethod.fahName, amount: 7n },
      { lockingBytecode: key(2), method: LinkMethod.compatibilityMapping, amount: 0n },
    ]);
    expect(r.balances.get(key(1))?.cumulative).toBe(12n);
    expect(r.balances.get(key(2))?.cumulative).toBe(0n);
    expect(() => addAllocations(r.balances, [{ lockingBytecode: key(1), method: 0, amount: -1n }])).toThrow(RangeError);
  });

  it('refuses a cumulative amount above 2^63 - 1', () => {
    const b = addAllocations(new Map(), [{ lockingBytecode: key(1), method: 0, amount: (1n << 63n) - 1n }]).balances;
    expect(() => addAllocations(b, [{ lockingBytecode: key(1), method: 0, amount: 1n }])).toThrow(/overflows/);
  });

  it('orders leaves by locking bytecode and skips zero balances', () => {
    const r = advanceEpoch(new Map(), [credit(3, 1n), credit(1, 1n), credit(2, 0n)], 10n);
    const leaves = balancesToLeaves(r.balances);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.cumulative)).toEqual([5n, 5n]);
    expect(Buffer.from(leaves[0]?.lockingBytecode ?? []).toString('hex')).toBe(key(1));
  });
});
