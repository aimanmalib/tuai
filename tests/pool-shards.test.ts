// Sharded pool (ADR 0013): several state NFT and reward token pairs let claims from one snapshot confirm together.
import { describe, expect, it } from 'vitest';
import { leafFromAddress, type Leaf } from '../src/leaf.ts';
import { receiptKey } from '../src/pool/encoding.ts';
import { MAX_SHARDS, shardSlot, splitAmount } from '../src/pool/shards.ts';
import { poolBalance, readPending, readPool, shardsOf } from '../src/pool/utxos.ts';
import { assembleClaim, type ClaimPlan } from '../src/tx/claim.ts';
import { buildActivate } from '../src/tx/activate.ts';
import { buildPropose } from '../src/tx/propose.ts';
import {
  FEE_RATE,
  OPERATORS,
  PUSH,
  REWARD_SUPPLY,
  SATS,
  advanceState,
  claim,
  claimPlan,
  deployPool,
  fund,
  newProvider,
  sendPlan,
  stateFor,
  testKey,
  treeOf,
  type PoolFixture,
  type TestKey,
} from './helpers/pool-fixture.ts';

const SHARDS = 4;
const keys = Array.from({ length: 16 }, (_, i) => testKey(`shard claimant ${i}`));
const leavesAt = (amount: bigint): Leaf[] => keys.map((k) => leafFromAddress(k.address, amount));
const slotOf = (k: TestKey) => shardSlot(receiptKey(leafFromAddress(k.address, 1n).lockingBytecode), SHARDS);
// Two claimants whose receipt keys fall on different shards.
const a = keys[0] as TestKey;
const b = keys.find((k) => slotOf(k) !== slotOf(a)) as TestKey;
const ia = keys.indexOf(a);
const ib = keys.indexOf(b);

const outpoints = (plan: ClaimPlan) => plan.inputs.map((i) => `${i.utxo.txid}:${i.utxo.vout}`);

/** Epoch 1 first claims for a and b, then an epoch 2 top-up; returns two additional claims built from one snapshot. */
async function twoClaimsFromOneSnapshot(shards: number): Promise<{ f: PoolFixture; plans: [ClaimPlan, ClaimPlan] }> {
  const one = treeOf(leavesAt(100n));
  const two = treeOf(leavesAt(250n));
  const f = await deployPool(stateFor(one.tree.root), newProvider(), undefined, PUSH, SATS, shards);
  await claim(f, leavesAt(100n)[ia] as Leaf, one.proof(ia), a);
  await claim(f, leavesAt(100n)[ib] as Leaf, one.proof(ib), b);
  const snapshot = await advanceState(f, stateFor(two.tree.root, 2));
  const plans: [ClaimPlan, ClaimPlan] = [
    claimPlan(f, snapshot, leavesAt(250n)[ia] as Leaf, two.proof(ia), a),
    claimPlan(f, snapshot, leavesAt(250n)[ib] as Leaf, two.proof(ib), b),
  ];
  return { f, plans };
}

describe('sharded pool deploy', () => {
  it('creates one state NFT and one reward UTXO per shard, with the full supply', async () => {
    const f = await deployPool(stateFor(treeOf(leavesAt(1n)).tree.root), newProvider(), undefined, PUSH, SATS, SHARDS);
    const pool = await readPool(f.contracts);
    expect(shardsOf(pool)).toHaveLength(SHARDS);
    expect(pool.rewards).toHaveLength(SHARDS);
    expect(poolBalance(pool.rewards)).toBe(REWARD_SUPPLY);
    expect(pool.receipts).toHaveLength(1);
    expect((await readPending(f.contracts)).pending.epoch).toBe(1);
  });

  it('splits amounts evenly and refuses splits that leave a shard empty', () => {
    expect(splitAmount(10n, 3)).toEqual([4n, 3n, 3n]);
    expect(splitAmount(7n, 1)).toEqual([7n]);
    expect(() => splitAmount(2n, 3)).toThrow(/cannot split/);
    expect(() => splitAmount(10n, 0)).toThrow(RangeError);
    expect(MAX_SHARDS).toBeGreaterThanOrEqual(SHARDS);
  });

  it('spreads receipt keys over every shard', () => {
    const slots = new Set(keys.map(slotOf));
    expect(slots.size).toBe(SHARDS);
  });
});

describe('concurrent claims', () => {
  it('two claims built from one snapshot of a sharded pool spend different UTXOs and both confirm', async () => {
    const { f, plans } = await twoClaimsFromOneSnapshot(SHARDS);
    const [first, second] = plans.map(outpoints) as [string[], string[]];
    expect(first.filter((o) => second.includes(o))).toEqual([]);
    await sendPlan(f, plans[0]);
    await sendPlan(f, plans[1]);
    const after = await readPool(f.contracts);
    expect(poolBalance(after.rewards)).toBe(REWARD_SUPPLY - 500n);
    expect(after.receipts.filter((r) => r.receipt.claimed === 250n)).toHaveLength(2);
  });

  it('with one shard the second claim from the same snapshot conflicts', async () => {
    const { f, plans } = await twoClaimsFromOneSnapshot(1);
    const [first, second] = plans.map(outpoints) as [string[], string[]];
    expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
    await sendPlan(f, plans[0]);
    await expect(sendPlan(f, plans[1])).rejects.toThrow();
  });

  it('a claim is the same size on a sharded pool', async () => {
    const { proof, tree } = treeOf(leavesAt(100n));
    const sizes: number[] = [];
    for (const shards of [1, SHARDS]) {
      const f = await deployPool(stateFor(tree.root), newProvider(), 'shard size', PUSH, SATS, shards);
      const plan = claimPlan(f, await readPool(f.contracts), leavesAt(100n)[ia] as Leaf, proof(ia), a);
      sizes.push(assembleClaim(plan, f.provider).build().length / 2);
    }
    expect(sizes[1]).toBe(sizes[0]);
  });
});

describe('sharded activation', () => {
  it('activates one stale shard per transaction; claims use the shards already on the new root', async () => {
    const shards = 3;
    const one = treeOf(leavesAt(100n));
    const two = treeOf(leavesAt(250n));
    const f = await deployPool(stateFor(one.tree.root), newProvider(), undefined, PUSH, SATS, shards);
    const funder = testKey('shard activator');
    const funding = () => ({ utxos: [fund(f, funder)], signer: funder.signer, changeAddress: funder.address });
    await buildPropose({
      contracts: f.contracts,
      pending: await readPending(f.contracts),
      proposal: stateFor(two.tree.root, 2),
      operators: [(OPERATORS[0] as TestKey).signer, (OPERATORS[1] as TestKey).signer],
      funding: funding(),
      feeRate: FEE_RATE,
    }).send();
    const activate = async () =>
      buildActivate({ contracts: f.contracts, pool: await readPool(f.contracts), pending: await readPending(f.contracts), funding: funding(), feeRate: FEE_RATE }).send();

    await activate();
    const partial = await readPool(f.contracts);
    expect(partial.decodedState.epoch).toBe(2);
    expect(shardsOf(partial).map((s) => s.state.epoch).sort()).toEqual([1, 1, 2]);
    // Every claim against the epoch 2 root picks the activated shard, whatever its key.
    await claim(f, leavesAt(250n)[ia] as Leaf, two.proof(ia), a);
    await claim(f, leavesAt(250n)[ib] as Leaf, two.proof(ib), b);

    await activate();
    await activate();
    expect(shardsOf(await readPool(f.contracts)).every((s) => s.state.epoch === 2)).toBe(true);
    await expect(activate()).rejects.toThrow(/nothing to activate/);
  });
});
