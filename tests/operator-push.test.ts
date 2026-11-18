// Operator push path (docs/decisions/0008-operator-push.md) on the CashScript mock network.
import { describe, expect, it } from 'vitest';
import { binToHex } from '@bitauth/libauth';
import type { Output } from 'cashscript';
import { leafFromAddress, type Leaf } from '../src/leaf.ts';
import { encodeState, receiptKey, type PoolState } from '../src/pool/encoding.ts';
import { unlockerFor, type PoolContracts } from '../src/pool/contracts.ts';
import { readPending, readPool } from '../src/pool/utxos.ts';
import { assembleActivate, type ActivatePlan } from '../src/tx/activate.ts';
import { buildPropose } from '../src/tx/propose.ts';
import { assemblePush, planArm, planPush, type PushPlan } from '../src/tx/push.ts';
import {
  FEE_RATE, OPERATORS, PUSH, SATS, advanceState, claim, deployPool, fund, stateFor, testKey, treeOf, type PoolFixture,
} from './helpers/pool-fixture.ts';

const VAULT_SATS = 50_000n;
const alice = testKey('alice');
const bob = testKey('bob');
const carol = testKey('carol');
const mallory = testKey('mallory');
const keeper = testKey('keeper');
const escape = (text: string): string => text.replace(/[().[\]+]/g, '\\$&');
/** Names the contract whose require failed, so a check in one contract cannot stand in for the other. */
const failingIn = (contract: 'ClaimPool' | 'RootGate', statement: string): RegExp =>
  new RegExp(`^${contract}\\.cash:\\d+ Require statement failed[\\s\\S]*Failing statement: require\\(${escape(statement)}`);

/** Epoch n: alice and bob above the push minimum, carol below it, two unkeyed leaves. */
function epoch(amounts: { alice: bigint; bob: bigint; carol: bigint }) {
  const leaves = [
    leafFromAddress(alice.address, amounts.alice),
    leafFromAddress(bob.address, amounts.bob),
    leafFromAddress(carol.address, amounts.carol),
    leafFromAddress(testKey('d').address, 10n),
    leafFromAddress(testKey('e').address, 7n),
  ];
  return { leaves, ...treeOf(leaves) };
}
const EPOCH_ONE = { alice: 100n, bob: 250n, carol: 20n };

async function freshPool(): Promise<{ f: PoolFixture; e: ReturnType<typeof epoch> }> {
  const e = epoch(EPOCH_ONE);
  return { f: await deployPool(stateFor(e.tree.root), undefined, undefined, PUSH, VAULT_SATS), e };
}

async function armPlan(f: PoolFixture, pool?: Awaited<ReturnType<typeof readPool>>): Promise<ActivatePlan> {
  return planArm({
    contracts: f.contracts,
    pool: pool ?? (await readPool(f.contracts)),
    pending: await readPending(f.contracts),
    funding: { utxos: [fund(f, keeper)], signer: keeper.signer, changeAddress: keeper.address },
    feeRate: FEE_RATE,
  });
}

const arm = async (f: PoolFixture) => assembleActivate(await armPlan(f), f.provider).send();

async function pushPlan(f: PoolFixture, e: ReturnType<typeof epoch>, index: number, contracts: PoolContracts = f.contracts): Promise<PushPlan> {
  return planPush({
    contracts,
    pool: await readPool(f.contracts),
    pending: await readPending(f.contracts),
    leaf: e.leaves[index] as Leaf,
    proof: e.proof(index),
    paymentSats: SATS,
    receiptSats: SATS,
    feeRate: FEE_RATE,
  });
}

const sendPush = (f: PoolFixture, plan: Pick<PushPlan, 'inputs' | 'outputs'>) => assemblePush(plan, f.provider).send();

const tokenBalance = async (f: PoolFixture, address: string): Promise<bigint> =>
  (await f.provider.getUtxos(address)).reduce(
    (s, u) => s + (u.token?.category === f.contracts.params.rewardCategory && !u.token.nft ? u.token.amount : 0n),
    0n,
  );

const claimedBy = async (f: PoolFixture, who: { lockingBytecode: Uint8Array }): Promise<bigint | undefined> => {
  const key = binToHex(receiptKey(who.lockingBytecode));
  return (await readPool(f.contracts)).receipts.find((r) => binToHex(r.receipt.key) === key)?.receipt.claimed;
};

async function proposeNext(f: PoolFixture, state: PoolState): Promise<void> {
  const funder = testKey('proposer');
  await buildPropose({
    contracts: f.contracts,
    pending: await readPending(f.contracts),
    proposal: state,
    operators: [OPERATORS[0]!.signer, OPERATORS[1]!.signer],
    funding: { utxos: [fund(f, funder)], signer: funder.signer, changeAddress: funder.address },
    feeRate: FEE_RATE,
  }).send();
}

const withCommitment = (o: Output, commitment: string): Output => ({ ...o, token: { ...o.token!, nft: { ...o.token!.nft!, commitment } } });

describe('arm (push window)', () => {
  it('opens pushes once the active root is pushDelay blocks old, leaving the state NFT unchanged', async () => {
    const { f } = await freshPool();
    const plan = await armPlan(f);
    expect(plan.inputs[1]?.sequence).toBe(PUSH.delay);
    await assembleActivate(plan, f.provider).send();
    const pending = await readPending(f.contracts);
    const pool = await readPool(f.contracts);
    expect(pending.armed).toBe(true);
    expect(binToHex(encodeState(pending.pending))).toBe(binToHex(encodeState(pool.decodedState)));
  });

  it('rejects arming before pushDelay blocks (sequence below the push delay)', async () => {
    const { f } = await freshPool();
    for (const sequence of [0, PUSH.delay - 1]) {
      const plan = await armPlan(f);
      plan.inputs[1] = { ...plan.inputs[1]!, sequence };
      await expect(assembleActivate(plan, f.provider).send()).rejects.toThrow(failingIn('RootGate', 'this.age >= pushDelay'));
    }
  });

  it('rejects arming while a newer root is pending', async () => {
    const { f } = await freshPool();
    const next = stateFor(new Uint8Array(32).fill(9), 2);
    await proposeNext(f, next);
    await expect(armPlan(f)).rejects.toThrow(/newer root is pending/);
    const pool = await readPool(f.contracts);
    const forced = await armPlan(f, { ...pool, decodedState: next });
    await expect(assembleActivate(forced, f.provider).send()).rejects.toThrow(failingIn('RootGate', 'tx.inputs[1].nftCommitment == state'));
  });

  it('rejects an arm that changes the state NFT', async () => {
    const { f } = await freshPool();
    const plan = await armPlan(f);
    plan.outputs[0] = withCommitment(plan.outputs[0]!, binToHex(encodeState(stateFor(new Uint8Array(32).fill(7), 9))));
    await expect(assembleActivate(plan, f.provider).send()).rejects.toThrow(failingIn('RootGate', 'tx.outputs[0].nftCommitment == state'));
  });
});

describe('push', () => {
  it('pays the full balance to the leaf, takes dust and fee from the vault within pushSats and returns the armed NFT', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    const vaultBefore = (await readPool(f.contracts)).rewards[0]!.satoshis;
    const plan = await pushPlan(f, e, 1);
    expect(plan.kind).toBe('first');
    expect(plan.inputs).toHaveLength(4);
    expect(plan.vaultSats).toBeLessThanOrEqual(BigInt(PUSH.sats));
    await sendPush(f, plan);
    expect(await tokenBalance(f, bob.address)).toBe(250n);
    expect(await claimedBy(f, bob)).toBe(250n);
    expect((await readPool(f.contracts)).rewards[0]!.satoshis).toBe(vaultBefore - plan.vaultSats);
    expect((await readPending(f.contracts)).armed).toBe(true);
  });

  it('rejects a push before arming, even with a forced plan', async () => {
    const { f, e } = await freshPool();
    await expect(pushPlan(f, e, 1)).rejects.toThrow(/not armed/);
    await arm(f);
    const plan = await pushPlan(f, e, 1);
    const unarmed = binToHex(encodeState((await readPool(f.contracts)).decodedState));
    plan.outputs[plan.outputs.length - 1] = withCommitment(plan.outputs.at(-1)!, unarmed);
    await expect(sendPush(f, plan)).rejects.toThrow(failingIn('RootGate', 'tx.outputs[last].nftCommitment == tx.inputs[3].nftCommitment'));
  });

  it('rejects a payment below pushMinimum', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    await expect(pushPlan(f, e, 2)).rejects.toThrow(/below the push minimum/);
    const lenient = { ...f.contracts, params: { ...f.contracts.params, push: { ...PUSH, minimum: '1' } } };
    const plan = await pushPlan(f, e, 2, lenient);
    await expect(sendPush(f, plan)).rejects.toThrow(failingIn('ClaimPool', 'payment >= pushMinimum'));
  });

  it('rejects a payment redirected to another locking bytecode', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    const plan = await pushPlan(f, e, 1);
    plan.outputs[2] = { ...plan.outputs[2]!, to: mallory.lockingBytecode };
    await expect(sendPush(f, plan)).rejects.toThrow(failingIn('ClaimPool', 'tx.outputs[2].lockingBytecode == lockingBytecode'));
  });

  it('rejects taking more than pushSats from the vault, extra inputs and change outputs', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    const greedy = await pushPlan(f, e, 1);
    greedy.outputs[1] = { ...greedy.outputs[1]!, amount: VAULT_SATS - BigInt(PUSH.sats) - 1n };
    greedy.outputs[2] = { ...greedy.outputs[2]!, amount: greedy.outputs[2]!.amount + 500n };
    await expect(sendPush(f, greedy)).rejects.toThrow(failingIn('ClaimPool', 'tx.outputs[1].value + pushSats >= tx.inputs[1].value'));
    const extraInput = await pushPlan(f, e, 1);
    extraInput.inputs.push({ utxo: fund(f, mallory), unlocker: mallory.signer.unlockP2PKH() });
    await expect(sendPush(f, extraInput)).rejects.toThrow(failingIn('ClaimPool', 'tx.inputs.length == 4'));
    const change = await pushPlan(f, e, 1);
    // Take 1,100 more sats from the vault (still within pushSats): 1,000 to a change output, the rest for its bytes.
    change.outputs[1] = { ...change.outputs[1]!, amount: change.outputs[1]!.amount - 1100n };
    change.outputs.push({ to: mallory.address, amount: 1000n });
    await expect(sendPush(f, change)).rejects.toThrow(failingIn('ClaimPool', 'tx.outputs.length == firstFree + 1'));
  });

  it('rejects moving the armed NFT out of the gate', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    const plan = await pushPlan(f, e, 1);
    plan.outputs[plan.outputs.length - 1] = { ...plan.outputs.at(-1)!, to: f.contracts.vault.tokenAddress };
    await expect(sendPush(f, plan)).rejects.toThrow(failingIn('RootGate', 'tx.outputs[last].lockingBytecode == tx.inputs[3].lockingBytecode'));
  });

  it('rejects a second push of the same balance', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    await sendPush(f, await pushPlan(f, e, 1));
    await expect(pushPlan(f, e, 1)).rejects.toThrow(/already fully claimed/);
    // Forced: tell the planner bob's receipt still says 0 claimed; the contract reads the real receipt.
    const pool = await readPool(f.contracts);
    const key = binToHex(receiptKey(bob.lockingBytecode));
    const stale = pool.receipts.map((r) => (binToHex(r.receipt.key) === key ? { ...r, receipt: { ...r.receipt, claimed: 0n } } : r));
    const plan = planPush({
      contracts: f.contracts,
      pool: { ...pool, receipts: stale },
      pending: await readPending(f.contracts),
      leaf: e.leaves[1] as Leaf,
      proof: e.proof(1),
      paymentSats: SATS,
      receiptSats: SATS,
      feeRate: FEE_RATE,
    });
    await expect(sendPush(f, plan)).rejects.toThrow(failingIn('ClaimPool', 'payment > 0'));
  });

  it('push then claim: the later claim pays only the increase', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    await sendPush(f, await pushPlan(f, e, 1));
    const e2 = epoch({ alice: 100n, bob: 400n, carol: 20n });
    await advanceState(f, stateFor(e2.tree.root, 2));
    const { plan } = await claim(f, e2.leaves[1] as Leaf, e2.proof(1), bob);
    expect(plan.kind).toBe('additional');
    expect(plan.payment).toBe(150n);
    expect(await tokenBalance(f, bob.address)).toBe(400n);
  });

  it('claim then push: the push pays only the remainder, after the window opens again for the new root', async () => {
    const { f, e } = await freshPool();
    await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    const e2 = epoch({ alice: 300n, bob: 250n, carol: 20n });
    await advanceState(f, stateFor(e2.tree.root, 2));
    await expect(pushPlan(f, e2, 0)).rejects.toThrow(/not armed/);
    await arm(f);
    const plan = await pushPlan(f, e2, 0);
    expect(plan.kind).toBe('additional');
    expect(plan.payment).toBe(200n);
    await sendPush(f, plan);
    expect(await tokenBalance(f, alice.address)).toBe(300n);
    expect(await claimedBy(f, alice)).toBe(300n);
  });

  it('closes the window when operators propose a new root', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    await proposeNext(f, stateFor(new Uint8Array(32).fill(4), 2));
    const pending = await readPending(f.contracts);
    expect(pending.armed).toBe(false);
    await expect(pushPlan(f, e, 1)).rejects.toThrow(/not armed/);
    const forced = planPush({
      contracts: f.contracts,
      pool: await readPool(f.contracts),
      pending: { ...pending, armed: true },
      leaf: e.leaves[1] as Leaf,
      proof: e.proof(1),
      paymentSats: SATS,
      receiptSats: SATS,
      feeRate: FEE_RATE,
    });
    await expect(sendPush(f, forced)).rejects.toThrow(failingIn('ClaimPool', 'tx.inputs[3].nftCommitment == state + 0x01'));
  });

  it('keeps ordinary claims working while pushes are armed, and the armed NFT cannot ride along in a claim', async () => {
    const { f, e } = await freshPool();
    await arm(f);
    const { plan } = await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    expect(plan.payment).toBe(100n);
    const pending = await readPending(f.contracts);
    const riding = await pushPlan(f, e, 1);
    // A claim layout (funding at input 3) with the armed NFT moved to input 4.
    riding.inputs.splice(3, 0, { utxo: fund(f, mallory), unlocker: mallory.signer.unlockP2PKH() });
    riding.inputs[4] = { utxo: pending.utxo, unlocker: unlockerFor(f.contracts.gate, 'witness')() };
    await expect(sendPush(f, riding)).rejects.toThrow(/ClaimPool|RootGate/);
  });
});

describe('version 1 pools', () => {
  it('deploy without push parameters uses the version 1 contracts, which still claim and cannot arm', async () => {
    const e = epoch(EPOCH_ONE);
    const f = await deployPool(stateFor(e.tree.root), undefined, undefined, null);
    expect(f.contracts.params.push).toBeUndefined();
    expect(f.contracts.pool.artifact.constructorInputs).toHaveLength(4);
    const { plan } = await claim(f, e.leaves[1] as Leaf, e.proof(1), bob);
    expect(plan.payment).toBe(250n);
    await expect(armPlan(f)).rejects.toThrow(/no push path/);
  });
});
