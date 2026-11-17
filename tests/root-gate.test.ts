import { describe, expect, it } from 'vitest';
import { binToHex, binsAreEqual } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type Output, type SpendableUtxo } from 'cashscript';
import { leafFromAddress, type Leaf } from '../src/leaf.ts';
import { encodeState, type PoolState } from '../src/pool/encoding.ts';
import { poolContracts, unlockerFor } from '../src/pool/contracts.ts';
import { readPending, readPool } from '../src/pool/utxos.ts';
import { assemblePropose, orderOperators, planPropose, type ProposePlan } from '../src/tx/propose.ts';
import { assembleActivate, planActivate, type ActivatePlan } from '../src/tx/activate.ts';
import { blockSequence, blocksUntilActivation } from '../src/gate/maturity.ts';
import { DELAY, FEE_RATE, OPERATORS, claimPlan, deployPool, fund, sendPlan, stateFor, testKey, treeOf, type PoolFixture, type TestKey } from './helpers/pool-fixture.ts';

const [opA, opB, opC] = OPERATORS as [TestKey, TestKey, TestKey];
const mallory = testKey('mallory');
const keeper = testKey('keeper');
const alice = testKey('alice');
const failing = (statement: string): RegExp => new RegExp(`Failing statement: require\\(${statement.replace(/[().[\]+]/g, '\\$&')}`);

const epochOne = (): { leaves: Leaf[]; tree: ReturnType<typeof treeOf> } => {
  const leaves = [leafFromAddress(alice.address, 100n), leafFromAddress(testKey('bob').address, 40n)];
  return { leaves, tree: treeOf(leaves) };
};

async function freshGate(): Promise<PoolFixture> {
  return deployPool(stateFor(epochOne().tree.tree.root, 1));
}

async function proposePlan(f: PoolFixture, proposal: PoolState, operators: TestKey[] = [opA, opB]): Promise<ProposePlan> {
  return planPropose({
    contracts: f.contracts,
    pending: await readPending(f.contracts),
    proposal,
    operators: operators.map((k) => k.signer),
    funding: { utxos: [fund(f, opA)], signer: opA.signer, changeAddress: opA.address },
    feeRate: FEE_RATE,
  });
}

const propose = async (f: PoolFixture, proposal: PoolState, operators?: TestKey[]) =>
  assemblePropose(await proposePlan(f, proposal, operators), f.provider).send();

async function activatePlan(f: PoolFixture): Promise<ActivatePlan> {
  return planActivate({
    contracts: f.contracts,
    pool: await readPool(f.contracts),
    pending: await readPending(f.contracts),
    funding: { utxos: [fund(f, keeper)], signer: keeper.signer, changeAddress: keeper.address },
    feeRate: FEE_RATE,
  });
}

const sendActivate = (f: PoolFixture, plan: ActivatePlan) => assembleActivate(plan, f.provider).send();

const nextState = (epoch: number, label = `epoch ${epoch}`): PoolState => {
  const root = new Uint8Array(32).fill(epoch);
  return { root, epoch, inputsHash: new TextEncoder().encode(label.padEnd(32, '.')).slice(0, 32) };
};

const withCommitment = (o: Output, commitment: string): Output => ({ ...o, token: { ...o.token!, nft: { ...o.token!.nft!, commitment } } });

describe('propose (2 of 3 operators)', () => {
  it('accepts every pair of distinct operators, in either order', async () => {
    const f = await freshGate();
    const pairs: TestKey[][] = [[opA, opB], [opC, opA], [opB, opC]];
    for (const [i, pair] of pairs.entries()) {
      await propose(f, nextState(2 + i), pair);
      expect((await readPending(f.contracts)).pending.epoch).toBe(2 + i);
    }
  });

  it('rejects a single operator signature, even when it is passed twice', async () => {
    const f = await freshGate();
    const plan = await proposePlan(f, nextState(2));
    const [a] = orderOperators(f.contracts.params.operatorKeys, [opA.signer, opB.signer]);
    plan.inputs[0] = { utxo: plan.inputs[0]!.utxo, unlocker: unlockerFor(f.contracts.gate, 'propose')(a, a) };
    await expect(assemblePropose(plan, f.provider).send()).rejects.toThrow(failing('checkMultiSig'));
    expect(() => orderOperators(f.contracts.params.operatorKeys, [opA.signer, opA.signer])).toThrow(/two distinct/);
  });

  it('rejects a key that is not an operator', async () => {
    const f = await freshGate();
    expect(() => orderOperators(f.contracts.params.operatorKeys, [opA.signer, mallory.signer])).toThrow(/two distinct/);
    const plan = await proposePlan(f, nextState(2));
    const [a] = orderOperators(f.contracts.params.operatorKeys, [opA.signer, opB.signer]);
    const [m] = orderOperators([binToHex(mallory.signer.publicKey), opC.publicKey, opB.publicKey], [mallory.signer, opC.signer]);
    plan.inputs[0] = { utxo: plan.inputs[0]!.utxo, unlocker: unlockerFor(f.contracts.gate, 'propose')(a, m) };
    await expect(assemblePropose(plan, f.provider).send()).rejects.toThrow(failing('checkMultiSig'));
  });

  it('rejects an epoch below the pending epoch', async () => {
    const f = await freshGate();
    await propose(f, nextState(3));
    await expect(proposePlan(f, nextState(2))).rejects.toThrow(/below the pending epoch/);
    const plan = await proposePlan(f, nextState(3));
    plan.outputs[0] = withCommitment(plan.outputs[0]!, binToHex(encodeState(nextState(2))));
    await expect(assemblePropose(plan, f.provider).send()).rejects.toThrow(failing('int(proposed.slice(32, 36)) >= int(pending.slice(32, 36))'));
  });

  it('rejects moving the pending NFT out of the gate or making it immutable', async () => {
    const f = await freshGate();
    const moved = await proposePlan(f, nextState(2));
    moved.outputs[0] = { ...moved.outputs[0]!, to: mallory.lockingBytecode };
    await expect(assemblePropose(moved, f.provider).send()).rejects.toThrow(/RootGate/);
    const frozen = await proposePlan(f, nextState(2));
    frozen.outputs[0] = { ...frozen.outputs[0]!, token: { ...frozen.outputs[0]!.token!, nft: { ...frozen.outputs[0]!.token!.nft!, capability: 'none' } } };
    await expect(assemblePropose(frozen, f.provider).send()).rejects.toThrow(failing('tx.outputs[0].tokenCategory == poolCategory + 0x01'));
  });
});

describe('activate (anyone, after the delay)', () => {
  it('lets a third party activate and copies root, epoch and inputs hash exactly', async () => {
    const f = await freshGate();
    const proposal = nextState(2, 'manifest sha256 of epoch two');
    await propose(f, proposal);
    const plan = await activatePlan(f);
    expect(plan.inputs[1]?.sequence).toBe(DELAY);
    await sendActivate(f, plan);
    const pool = await readPool(f.contracts);
    expect(binsAreEqual(encodeState(pool.decodedState), encodeState(proposal))).toBe(true);
    expect((await readPending(f.contracts)).pending.epoch).toBe(2);
  });

  it('rejects an activation whose input is younger than the delay (sequence below the delay)', async () => {
    const f = await freshGate();
    await propose(f, nextState(2));
    for (const sequence of [0, DELAY - 1]) {
      const plan = await activatePlan(f);
      plan.inputs[1] = { ...plan.inputs[1]!, sequence };
      await expect(sendActivate(f, plan)).rejects.toThrow(failing('this.age >= delay'));
    }
  });

  it('rejects activating an epoch that is not above the active epoch', async () => {
    const f = await freshGate();
    await propose(f, nextState(1, 'same epoch, other root'));
    await expect(activatePlan(f)).rejects.toThrow(/nothing to activate/);
    const pending = await readPending(f.contracts);
    const forced = await activatePlanFor(f, { ...pending, pending: nextState(9) });
    await expect(sendActivate(f, forced)).rejects.toThrow(failing('int(pending.slice(32, 36)) > int(tx.inputs[0].nftCommitment.slice(32, 36))'));
  });

  it('rejects a changed or moved state NFT and a burned or moved pending NFT', async () => {
    const f = await freshGate();
    await propose(f, nextState(2));
    const changed = await activatePlan(f);
    changed.outputs[0] = withCommitment(changed.outputs[0]!, binToHex(encodeState(nextState(5))));
    await expect(sendActivate(f, changed)).rejects.toThrow(failing('tx.outputs[0].nftCommitment == pending'));
    const movedState = await activatePlan(f);
    movedState.outputs[0] = { ...movedState.outputs[0]!, to: f.contracts.gate.tokenAddress };
    await expect(sendActivate(f, movedState)).rejects.toThrow(failing('tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode'));
    const movedPending = await activatePlan(f);
    movedPending.outputs[1] = { ...movedPending.outputs[1]!, to: f.contracts.pool.tokenAddress };
    await expect(sendActivate(f, movedPending)).rejects.toThrow(failing('tx.outputs[1].lockingBytecode == tx.inputs[1].lockingBytecode'));
    const burned = await activatePlan(f);
    burned.outputs.splice(1, 1);
    await expect(assembleActivate(burned, f.provider).send()).rejects.toThrow(/RootGate|ClaimPool|burn/i);
  });

  it('rejects spending a vault UTXO inside an activation', async () => {
    const f = await freshGate();
    await propose(f, nextState(2));
    const plan = await activatePlan(f);
    const reward = (await readPool(f.contracts)).rewards[0]!;
    plan.inputs.push({ utxo: reward, unlocker: unlockerFor(f.contracts.vault, 'spend')() });
    plan.outputs.push({ to: mallory.lockingBytecode, amount: reward.satoshis, token: reward.token! });
    await expect(sendActivate(f, plan)).rejects.toThrow(failing('tx.inputs[i].tokenCategory == 0x'));
  });

  it('rejects a look-alike pending NFT of another category sent to the gate', async () => {
    const f = await freshGate();
    const fake = f.provider.addUtxo(f.contracts.gate.tokenAddress, {
      ...randomUtxo({ satoshis: 1000n }),
      token: { category: binToHex(new Uint8Array(32).fill(7)), amount: 0n, nft: { capability: 'mutable', commitment: binToHex(encodeState(nextState(2))) } },
    });
    const pending = await readPending(f.contracts);
    const plan = await activatePlanFor(f, { utxo: fake, pending: nextState(2) });
    plan.outputs[1] = { ...plan.outputs[1]!, token: fake.token! };
    expect(pending.pending.epoch).toBe(1);
    await expect(sendActivate(f, plan)).rejects.toThrow(failing('tx.inputs[1].tokenCategory == poolCategory + 0x01'));
  });

  it('rejects a claim against a root that is only pending', async () => {
    const f = await freshGate();
    const leaves = [leafFromAddress(alice.address, 500n), leafFromAddress(testKey('bob').address, 1n)];
    const t = treeOf(leaves);
    await propose(f, stateFor(t.tree.root, 2));
    const plan = claimPlan(f, await readPool(f.contracts), leaves[0] as Leaf, t.proof(0), alice);
    await expect(sendPlan(f, plan)).rejects.toThrow(failing('hash == state.slice(0, 32)'));
  });
});

/** Plans an activation for a given pending UTXO; `pending.pending` only feeds the builder's own epoch check. */
async function activatePlanFor(f: PoolFixture, pending: { utxo: SpendableUtxo; pending: PoolState }): Promise<ActivatePlan> {
  const pool = await readPool(f.contracts);
  return planActivate({
    contracts: f.contracts,
    pool,
    pending,
    funding: { utxos: [fund(f, keeper)], signer: keeper.signer, changeAddress: keeper.address },
    feeRate: FEE_RATE,
  });
}

describe('activation timelock', () => {
  it('counts blocks until activation from the confirmation height', () => {
    expect(blockSequence(DELAY)).toBe(DELAY);
    expect(() => blockSequence(0x10000)).toThrow(RangeError);
    expect(blocksUntilActivation(undefined, 3, 100)).toBeUndefined();
    // Confirmed at 100 with a delay of 3: the first block that may include the activation is 103.
    expect(blocksUntilActivation(100, 3, 100)).toBe(2);
    expect(blocksUntilActivation(100, 3, 101)).toBe(1);
    expect(blocksUntilActivation(100, 3, 102)).toBe(0);
    expect(blocksUntilActivation(100, 3, 500)).toBe(0);
  });

  it('restarts the delay when operators propose again: the pending NFT moves to a new UTXO', async () => {
    const f = await freshGate();
    const heights = new Map<string, number>();
    const first = await propose(f, nextState(2));
    heights.set(first.txid, 100);
    const firstPending = (await readPending(f.contracts)).utxo;
    expect(blocksUntilActivation(heights.get(firstPending.txid), DELAY, 102)).toBe(0);
    const again = await propose(f, nextState(2, 'corrected inputs'));
    heights.set(again.txid, 102);
    const secondPending = (await readPending(f.contracts)).utxo;
    expect(secondPending.txid).toBe(again.txid);
    expect(blocksUntilActivation(heights.get(secondPending.txid), DELAY, 102)).toBe(2);
    expect(blocksUntilActivation(heights.get(secondPending.txid), DELAY, 104)).toBe(0);
  });
});

describe('gate parameters', () => {
  it('requires exactly three compressed operator keys and a delay a sequence number can hold', () => {
    const base = {
      poolCategory: '11'.repeat(32), rewardCategory: '22'.repeat(32), maxDepth: 24, operatorKeys: OPERATORS.map((k) => k.publicKey), activationDelay: 3,
    };
    const provider = new MockNetworkProvider();
    expect(poolContracts(base, provider).gate.bytesize).toBeGreaterThan(0);
    expect(() => poolContracts({ ...base, operatorKeys: base.operatorKeys.slice(0, 2) }, provider)).toThrow(/three|3 compressed/);
    expect(() => poolContracts({ ...base, activationDelay: 0 }, provider)).toThrow(RangeError);
    expect(() => poolContracts({ ...base, activationDelay: 0x10000 }, provider)).toThrow(RangeError);
  });
});
