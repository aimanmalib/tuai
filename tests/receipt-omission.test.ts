// Leaving out a receipt does not pay twice. A claimant who already holds a receipt tries to be paid again as if the
// receipt were not there: by naming a predecessor whose `next` is now the claimant's own key, by bringing a fake
// predecessor, by burning or moving the own receipt, or by waiting for a new root. Every attempt runs on the
// CashScript VM through the mock network, so the contracts (not the transaction builder) decide.
import { describe, expect, it } from 'vitest';
import { binToHex, binsAreEqual } from '@bitauth/libauth';
import { randomUtxo, type Output } from 'cashscript';
import { sha256 } from '../src/bytes.ts';
import { leafFromAddress, type Leaf } from '../src/leaf.ts';
import { HEAD_KEY, END_KEY, encodeReceipt, receiptKey } from '../src/pool/encoding.ts';
import { unlockerFor } from '../src/pool/contracts.ts';
import { withoutOwnReceipt } from '../src/pool/hide-receipt.ts';
import { readPending, readPool, type PoolUtxos } from '../src/pool/utxos.ts';
import { buildPropose } from '../src/tx/propose.ts';
import { assembleActivate, planActivate } from '../src/tx/activate.ts';
import type { ClaimPlan } from '../src/tx/claim.ts';
import {
  FEE_RATE, OPERATORS, advanceState, claim, claimPlan, deployPool, fund, sendPlan, stateFor, testKey, treeOf,
  type PoolFixture, type TestKey,
} from './helpers/pool-fixture.ts';

const POOL_REJECTS = /Require statement failed at input 0 in contract ClaimPool/;
const alice = testKey('omission alice');
const bob = testKey('omission bob');
const carol = testKey('omission carol');
const mallory = testKey('omission mallory');
const leafOf = (k: { address: string }, amount: bigint): Leaf => leafFromAddress(k.address, amount);

const tokens = async (f: PoolFixture, k: TestKey): Promise<bigint> =>
  (await f.provider.getUtxos(k.address)).reduce(
    (s, u) => s + (u.token?.category === f.contracts.params.rewardCategory && !u.token.nft ? u.token.amount : 0n),
    0n,
  );

/** Every receipt in the vault as outpoint and commitment, sorted, so two snapshots compare as plain strings. */
const receiptSnapshot = (pool: PoolUtxos): string[] =>
  pool.receipts.map((r) => `${r.utxo.txid}:${r.utxo.vout}:${r.utxo.token?.nft?.commitment}`).sort();

const nft = (commitment: Uint8Array | string): { capability: 'none'; commitment: string } => ({
  capability: 'none',
  commitment: typeof commitment === 'string' ? commitment : binToHex(commitment),
});

const setOutput = (plan: ClaimPlan, i: number, change: (o: Output) => Output): void => {
  plan.outputs[i] = change(plan.outputs[i] as Output);
};

/** Alice, Bob and Carol have each made their first claim in epoch 1. */
async function claimedPool() {
  const leaves = [leafOf(alice, 100n), leafOf(bob, 250n), leafOf(carol, 75n)];
  const t = treeOf(leaves);
  const f = await deployPool(stateFor(t.tree.root));
  for (const i of [0, 1, 2]) await claim(f, leaves[i] as Leaf, t.proof(i), mallory);
  return { f, leaves, proof: t.proof };
}

describe('leaving out a receipt', () => {
  it('refuses a second first claim through the predecessor whose next is the own key, and through every other receipt', async () => {
    const { f, leaves, proof } = await claimedPool();
    const before = receiptSnapshot(await readPool(f.contracts));
    const key = receiptKey(alice.lockingBytecode);
    // The way a client would try it: plan as if alice had no receipt. The predecessor's real commitment points at alice.
    const hidden = claimPlan(f, withoutOwnReceipt(await readPool(f.contracts), alice.lockingBytecode), leaves[0] as Leaf, proof(0), mallory);
    expect(hidden.kind).toBe('first');
    await expect(sendPlan(f, hidden)).rejects.toThrow(POOL_REJECTS);
    // Any receipt in the vault as the predecessor, outputs rewritten to match it: none has P.key < key < P.next.
    const pool = await readPool(f.contracts);
    for (const p of pool.receipts) {
      const plan = claimPlan(f, withoutOwnReceipt(pool, alice.lockingBytecode), leaves[0] as Leaf, proof(0), mallory);
      plan.inputs[2] = { utxo: p.utxo, unlocker: plan.inputs[2]!.unlocker };
      setOutput(plan, 3, (o) => ({ ...o, amount: p.utxo.satoshis, token: { ...o.token!, nft: nft(encodeReceipt({ ...p.receipt, next: key })) } }));
      setOutput(plan, 4, (o) => ({ ...o, token: { ...o.token!, nft: nft(encodeReceipt({ key, next: p.receipt.next, claimed: 100n })) } }));
      await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
    }
    expect(await tokens(f, alice)).toBe(100n);
    expect(receiptSnapshot(await readPool(f.contracts))).toEqual(before);
  });

  it('refuses a predecessor that is not a receipt of this pool, in the vault or in a wallet', async () => {
    const { f, leaves, proof } = await claimedPool();
    const key = receiptKey(alice.lockingBytecode);
    // Same commitment as the list head, under a category anyone can create.
    const fakeCategory = binToHex(sha256(new TextEncoder().encode('omission fake receipts')));
    const fakeHead = { category: fakeCategory, amount: 0n, nft: nft(encodeReceipt({ key: HEAD_KEY, next: END_KEY, claimed: 0n })) };
    const inVault = f.provider.addUtxo(f.contracts.vault.tokenAddress, randomUtxo({ satoshis: 1000n, token: fakeHead }));
    const inWallet = f.provider.addUtxo(mallory.address, randomUtxo({ satoshis: 1000n, token: fakeHead }));
    const pool = await readPool(f.contracts);
    for (const [utxo, signed] of [[inVault, false], [inWallet, true]] as const) {
      const plan = claimPlan(f, withoutOwnReceipt(pool, alice.lockingBytecode), leaves[0] as Leaf, proof(0), mallory);
      plan.inputs[2] = { utxo, unlocker: signed ? mallory.signer.unlockP2PKH() : plan.inputs[2]!.unlocker };
      setOutput(plan, 3, (o) => ({ ...o, amount: utxo.satoshis, token: { ...o.token!, nft: nft(binToHex(HEAD_KEY) + binToHex(key) + '00'.repeat(8)) } }));
      setOutput(plan, 4, (o) => ({ ...o, token: { ...o.token!, nft: nft(encodeReceipt({ key, next: END_KEY, claimed: 100n })) } }));
      await expect(sendPlan(f, plan, true)).rejects.toThrow(POOL_REJECTS);
    }
    expect(await tokens(f, alice)).toBe(100n);
  });

  it('does not let the own receipt be burned, moved out, reset or carried off in an activation', async () => {
    const { f } = await claimedPool();
    const next = [leafOf(alice, 160n), leafOf(bob, 250n), leafOf(carol, 75n)];
    const t2 = treeOf(next);
    const key = binToHex(receiptKey(alice.lockingBytecode));
    const funder = testKey('omission activator');
    await buildPropose({
      contracts: f.contracts,
      pending: await readPending(f.contracts),
      proposal: stateFor(t2.tree.root, 2),
      operators: [(OPERATORS[0] as TestKey).signer, (OPERATORS[1] as TestKey).signer],
      funding: { utxos: [fund(f, funder)], signer: funder.signer, changeAddress: funder.address },
      feeRate: FEE_RATE,
    }).send();
    // An activation that also spends alice's receipt and sends it to her wallet.
    const before = await readPool(f.contracts);
    const own = before.receipts.find((r) => binToHex(r.receipt.key) === key)!;
    const activation = planActivate({
      contracts: f.contracts,
      pool: before,
      pending: await readPending(f.contracts),
      funding: { utxos: [fund(f, funder)], signer: funder.signer, changeAddress: funder.address },
      feeRate: FEE_RATE,
    });
    activation.inputs.push({ utxo: own.utxo, unlocker: unlockerFor(f.contracts.vault, 'spend')() });
    activation.outputs.push({ to: alice.address, amount: own.utxo.satoshis, token: own.utxo.token! });
    await expect(assembleActivate(activation, f.provider).send()).rejects.toThrow(/Require statement failed/);
    const pool = await advanceState(f, stateFor(t2.tree.root, 2));
    const due = () => claimPlan(f, pool, next[0] as Leaf, t2.proof(0), mallory);
    expect(due().kind).toBe('additional');
    const burned = due();
    burned.outputs.splice(3, 1);
    const moved = due();
    setOutput(moved, 3, (o) => ({ ...o, to: alice.address }));
    const reset = due();
    setOutput(reset, 3, (o) => ({ ...o, token: { ...o.token!, nft: nft(key + commitmentNext(o) + '00'.repeat(8)) } }));
    for (const plan of [burned, moved, reset]) await expect(sendPlan(f, plan, true)).rejects.toThrow(POOL_REJECTS);
    // The receipt is still in the vault at 100, so the honest claim pays the 60 still due and nothing more.
    await sendPlan(f, due());
    expect(await tokens(f, alice)).toBe(160n);
  });

  it('activating a new root changes no receipt; only a claim writes the claimed amount', async () => {
    const { f } = await claimedPool();
    const before = receiptSnapshot(await readPool(f.contracts));
    // The new root lists alice lower than she has claimed, bob unchanged and carol higher.
    const next = [leafOf(alice, 90n), leafOf(bob, 250n), leafOf(carol, 80n)];
    const t2 = treeOf(next);
    const pool = await advanceState(f, stateFor(t2.tree.root, 2));
    expect(receiptSnapshot(pool)).toEqual(before);
    const lower = claimPlan(f, withoutOwnReceipt(pool, alice.lockingBytecode), next[0] as Leaf, t2.proof(0), mallory);
    await expect(sendPlan(f, lower)).rejects.toThrow(POOL_REJECTS);
    await expect(claim(f, next[1] as Leaf, t2.proof(1), mallory)).rejects.toThrow(/nothing to claim/);
    await claim(f, next[2] as Leaf, t2.proof(2), mallory);
    expect([await tokens(f, alice), await tokens(f, bob), await tokens(f, carol)]).toEqual([100n, 250n, 80n]);
    const after = await readPool(f.contracts);
    const carolReceipt = after.receipts.find((r) => binsAreEqual(r.receipt.key, receiptKey(carol.lockingBytecode)));
    expect(carolReceipt?.receipt.claimed).toBe(80n);
    expect(after.receipts).toHaveLength(4);
  });
});

/** The `next` field (hex) of a receipt output's commitment. */
const commitmentNext = (o: Output): string => (o.token?.nft?.commitment ?? '').slice(64, 128);
