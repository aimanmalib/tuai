import { describe, expect, it } from 'vitest';
import { binToHex, binsAreEqual } from '@bitauth/libauth';
import type { Output } from 'cashscript';
import { randomUtxo } from 'cashscript';
import { sha256 } from '../src/bytes.ts';
import { hashLeaf, leafFromAddress, type Leaf } from '../src/leaf.ts';
import { HEAD_KEY, END_KEY, encodeReceipt, keyToBigInt, receiptKey } from '../src/pool/encoding.ts';
import { readPool, receiptOf } from '../src/pool/utxos.ts';
import { unlockerFor } from '../src/pool/contracts.ts';
import type { ClaimPlan } from '../src/tx/claim.ts';
import {
  REWARD_SUPPLY, claim, claimPlan, fund, deployPool, replaceState, sendPlan, stateFor, syntheticProof, testKey, treeOf,
  type PoolFixture,
} from './helpers/pool-fixture.ts';

const POOL_REJECTS = /Require statement failed at input 0 in contract ClaimPool/;
const alice = testKey('alice');
const bob = testKey('bob');
const carol = testKey('carol');
const mallory = testKey('mallory');
const leafOf = (k: { address: string }, amount: bigint): Leaf => leafFromAddress(k.address, amount);

/** Epoch 1 tree with three claimants and a few unkeyed leaves. */
function epochOne() {
  const leaves = [leafOf(alice, 100n), leafOf(bob, 250n), leafOf(carol, 75n), leafOf(testKey('d'), 10n), leafOf(testKey('e'), 5n)];
  return { leaves, ...treeOf(leaves) };
}

async function freshPool(): Promise<{ f: PoolFixture; e: ReturnType<typeof epochOne> }> {
  const e = epochOne();
  return { f: await deployPool(stateFor(e.tree.root)), e };
}

const tokenBalance = async (f: PoolFixture, address: string, category: string): Promise<bigint> =>
  (await f.provider.getUtxos(address)).reduce((s, u) => s + (u.token?.category === category && !u.token.nft ? u.token.amount : 0n), 0n);

const setOutput = (plan: ClaimPlan, i: number, change: (o: Output) => Output): void => {
  plan.outputs[i] = change(plan.outputs[i] as Output);
};

const commitmentOf = (o: Output): string => o.token?.nft?.commitment ?? '';

describe('deploy', () => {
  it('creates the minting state NFT, the receipt list head and the reward vault', async () => {
    const { f, e } = await freshPool();
    const pool = await readPool(f.contracts);
    expect(binsAreEqual(pool.decodedState.root, e.tree.root)).toBe(true);
    expect(pool.state.token?.category).toBe(f.contracts.params.poolCategory);
    expect(pool.receipts).toHaveLength(1);
    expect(binsAreEqual(pool.receipts[0]?.receipt.key as Uint8Array, HEAD_KEY)).toBe(true);
    expect(binsAreEqual(pool.receipts[0]?.receipt.next as Uint8Array, END_KEY)).toBe(true);
    expect(pool.rewards.map((u) => u.token?.amount)).toEqual([REWARD_SUPPLY]);
  });
});

describe('honest claims', () => {
  it('pays exactly the cumulative amount on a first claim and inserts a receipt', async () => {
    const { f, e } = await freshPool();
    const { plan } = await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    expect(plan.kind).toBe('first');
    expect(await tokenBalance(f, alice.address, f.contracts.params.rewardCategory)).toBe(100n);
    const pool = await readPool(f.contracts);
    expect(pool.receipts).toHaveLength(2);
    const mine = pool.receipts.find((r) => binsAreEqual(r.receipt.key, receiptKey(alice.lockingBytecode)));
    expect(mine?.receipt.claimed).toBe(100n);
    expect(pool.rewards[0]?.token?.amount).toBe(REWARD_SUPPLY - 100n);
  });

  it('lets anyone fund a claim while the payment still goes to the leaf', async () => {
    const { f, e } = await freshPool();
    await claim(f, e.leaves[1] as Leaf, e.proof(1), mallory);
    expect(await tokenBalance(f, bob.address, f.contracts.params.rewardCategory)).toBe(250n);
    expect(await tokenBalance(f, mallory.address, f.contracts.params.rewardCategory)).toBe(0n);
  });

  it('keeps the receipt list sorted across several first claims', async () => {
    const { f, e } = await freshPool();
    for (const i of [0, 1, 2, 3, 4]) await claim(f, e.leaves[i] as Leaf, e.proof(i), carol);
    const pool = await readPool(f.contracts);
    expect(pool.receipts).toHaveLength(6);
    // Walk the list from the head: every node points at the next larger key and the walk ends at END_KEY.
    const byKey = new Map(pool.receipts.map((r) => [binToHex(r.receipt.key), r.receipt]));
    let node = byKey.get(binToHex(HEAD_KEY));
    let visited = 0;
    while (node && !binsAreEqual(node.next, END_KEY)) {
      expect(keyToBigInt(node.next) > keyToBigInt(node.key)).toBe(true);
      node = byKey.get(binToHex(node.next));
      visited += 1;
    }
    expect(visited).toBe(5);
  });

  it('pays only the difference on an additional claim in the next epoch', async () => {
    const { f, e } = await freshPool();
    await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    const next = [leafOf(alice, 160n), leafOf(bob, 300n)];
    const t2 = treeOf(next);
    const pool = await replaceState(f, stateFor(t2.tree.root, 2));
    const plan = claimPlan(f, pool, next[0] as Leaf, t2.proof(0), alice);
    expect(plan.kind).toBe('additional');
    expect(plan.payment).toBe(60n);
    await sendPlan(f, plan);
    expect(await tokenBalance(f, alice.address, f.contracts.params.rewardCategory)).toBe(160n);
    const mine = (await f.provider.getUtxos(f.contracts.vault.tokenAddress)).find(
      (u) => u.token?.nft?.commitment.startsWith(binToHex(receiptKey(alice.lockingBytecode))),
    );
    expect(mine && receiptOf(mine).claimed).toBe(160n);
  });
});

describe('rejected claims', () => {
  it('rejects a second claim of the same amount', async () => {
    const { f, e } = await freshPool();
    await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    await expect(claim(f, e.leaves[0] as Leaf, e.proof(0), alice)).rejects.toThrow(/nothing to claim/);
    // Built by hand: re-insert alice after the head, whose next is now alice's own key.
    const pool = await readPool(f.contracts);
    const head = pool.receipts.find((r) => binsAreEqual(r.receipt.key, HEAD_KEY));
    const fresh = { ...pool, receipts: head ? [{ ...head, receipt: { ...head.receipt, next: END_KEY } }] : [] };
    const plan = claimPlan(f, fresh, e.leaves[0] as Leaf, e.proof(0), alice);
    plan.inputs[2] = { utxo: head?.utxo ?? plan.inputs[2]!.utxo, unlocker: plan.inputs[2]!.unlocker };
    const key = binToHex(receiptKey(alice.lockingBytecode));
    setOutput(plan, 3, (o) => ({ ...o, token: { ...o.token!, nft: { capability: 'none', commitment: binToHex(HEAD_KEY) + key + '00'.repeat(8) } } }));
    setOutput(plan, 4, (o) => ({ ...o, token: { ...o.token!, nft: { capability: 'none', commitment: key + key + commitmentOf(o).slice(128) } } }));
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects an additional claim that pays when nothing is due', async () => {
    const { f, e } = await freshPool();
    await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    // The claimant pretends its receipt says 99 claimed; the receipt actually spent says 100.
    const pool = await readPool(f.contracts);
    const stale = pool.receipts.map((r) =>
      binsAreEqual(r.receipt.key, receiptKey(alice.lockingBytecode)) ? { ...r, receipt: { ...r.receipt, claimed: 99n } } : r,
    );
    const plan = claimPlan(f, { ...pool, receipts: stale }, e.leaves[0] as Leaf, e.proof(0), alice);
    expect(plan.kind).toBe('additional');
    expect(plan.payment).toBe(1n);
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects a payment sent to another locking bytecode', async () => {
    const { f, e } = await freshPool();
    const plan = claimPlan(f, await readPool(f.contracts), e.leaves[0] as Leaf, e.proof(0), mallory);
    setOutput(plan, 2, (o) => ({ ...o, to: mallory.lockingBytecode }));
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects paying more or less than is due', async () => {
    const { f, e } = await freshPool();
    for (const delta of [1n, -1n]) {
      const plan = claimPlan(f, await readPool(f.contracts), e.leaves[0] as Leaf, e.proof(0), alice);
      setOutput(plan, 2, (o) => ({ ...o, token: { ...o.token!, amount: o.token!.amount + delta } }));
      setOutput(plan, 1, (o) => ({ ...o, token: { ...o.token!, amount: o.token!.amount - delta } }));
      await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
    }
  });

  it('rejects a forged proof, a wrong index, an aliased index, an inflated amount and a foreign root', async () => {
    const { f, e } = await freshPool();
    const pool = await readPool(f.contracts);
    const good = e.proof(1);
    const flipped = good.siblings.map((s, i) => (i === 1 ? Uint8Array.from(s, (b, j) => (j === 0 ? b ^ 1 : b)) : s));
    const other = treeOf([leafOf(bob, 250n), leafOf(alice, 1n)]);
    const cases: Array<[Leaf, { index: number; siblings: Uint8Array[] }]> = [
      [e.leaves[1] as Leaf, { index: 1, siblings: flipped }],
      [e.leaves[1] as Leaf, { index: 3, siblings: good.siblings }],
      [e.leaves[1] as Leaf, { index: 1 + 2 ** good.siblings.length, siblings: good.siblings }],
      [leafOf(bob, 251n), good],
      [e.leaves[1] as Leaf, other.proof(0)],
    ];
    for (const [leaf, proof] of cases) {
      const plan = claimPlan(f, pool, leaf, proof, bob);
      await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
    }
  });

  it('rejects reward tokens of another category', async () => {
    const { f, e } = await freshPool();
    const fake = binToHex(sha256(Uint8Array.of(9)));
    const fakeUtxo = f.provider.addUtxo(f.contracts.vault.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: fake, amount: 10_000n } }));
    const pool = await readPool(f.contracts);
    const plan = claimPlan(f, { ...pool, rewards: [fakeUtxo] }, e.leaves[0] as Leaf, e.proof(0), alice);
    setOutput(plan, 1, (o) => ({ ...o, token: { category: fake, amount: 10_000n - 100n } }));
    setOutput(plan, 2, (o) => ({ ...o, token: { category: fake, amount: 100n } }));
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects a burned receipt and a receipt sent out of the vault', async () => {
    const { f, e } = await freshPool();
    const pool = await readPool(f.contracts);
    const burned = claimPlan(f, pool, e.leaves[0] as Leaf, e.proof(0), alice);
    burned.outputs.splice(4, 1);
    await expect(sendPlan(f, burned)).rejects.toThrow(POOL_REJECTS);
    const taken = claimPlan(f, pool, e.leaves[0] as Leaf, e.proof(0), alice);
    setOutput(taken, 4, (o) => ({ ...o, to: alice.address }));
    await expect(sendPlan(f, taken)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects inserting a receipt after the wrong predecessor', async () => {
    const { f, e } = await freshPool();
    for (const i of [0, 1, 2]) await claim(f, e.leaves[i] as Leaf, e.proof(i), alice);
    const pool = await readPool(f.contracts);
    const leaf = e.leaves[3] as Leaf;
    const key = receiptKey(leaf.lockingBytecode);
    const wrong = pool.receipts.find((r) => {
      const k = keyToBigInt(key);
      return !(keyToBigInt(r.receipt.key) < k && k < keyToBigInt(r.receipt.next));
    });
    if (!wrong) throw new Error('fixture needs a non-adjacent receipt');
    const plan = claimPlan(f, pool, leaf, e.proof(3), alice);
    plan.inputs[2] = { utxo: wrong.utxo, unlocker: plan.inputs[2]!.unlocker };
    const w = wrong.receipt;
    setOutput(plan, 3, (o) => ({ ...o, amount: wrong.utxo.satoshis, token: { ...o.token!, nft: { capability: 'none', commitment: binToHex(encodeReceipt({ ...w, next: key })) } } }));
    setOutput(plan, 4, (o) => ({ ...o, token: { ...o.token!, nft: { capability: 'none', commitment: binToHex(encodeReceipt({ key, next: w.next, claimed: leaf.cumulative })) } } }));
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects a changed or moved state NFT', async () => {
    const { f, e } = await freshPool();
    const pool = await readPool(f.contracts);
    const changed = claimPlan(f, pool, e.leaves[0] as Leaf, e.proof(0), alice);
    setOutput(changed, 0, (o) => ({ ...o, token: { ...o.token!, nft: { capability: 'minting', commitment: '00'.repeat(68) } } }));
    await expect(sendPlan(f, changed)).rejects.toThrow(POOL_REJECTS);
    const moved = claimPlan(f, pool, e.leaves[0] as Leaf, e.proof(0), alice);
    setOutput(moved, 0, (o) => ({ ...o, to: mallory.address }));
    await expect(sendPlan(f, moved)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects minting an extra pool NFT to the claimant', async () => {
    const { f, e } = await freshPool();
    const plan = claimPlan(f, await readPool(f.contracts), e.leaves[0] as Leaf, e.proof(0), mallory);
    plan.outputs.push({ to: mallory.address, amount: 1000n, token: { category: f.contracts.params.poolCategory, amount: 0n, nft: { capability: 'minting', commitment: '' } } });
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects spending another vault UTXO inside a claim', async () => {
    const { f, e } = await freshPool();
    await claim(f, e.leaves[0] as Leaf, e.proof(0), alice);
    const pool = await readPool(f.contracts);
    const plan = claimPlan(f, pool, e.leaves[1] as Leaf, e.proof(1), mallory);
    const spent = new Set(plan.inputs.map((i) => `${i.utxo.txid}:${i.utxo.vout}`));
    const victim = pool.receipts.find((r) => !spent.has(`${r.utxo.txid}:${r.utxo.vout}`));
    if (!victim) throw new Error('fixture needs a second receipt');
    plan.inputs.push({ utxo: victim.utxo, unlocker: plan.inputs[1]!.unlocker });
    await expect(sendPlan(f, plan)).rejects.toThrow(POOL_REJECTS);
  });

  it('rejects moving vault tokens without the state NFT', async () => {
    const { f } = await freshPool();
    const pool = await readPool(f.contracts);
    const { TransactionBuilder } = await import('cashscript');
    const reward = pool.rewards[0]!;
    const tx = new TransactionBuilder({ provider: f.provider })
      .addInput(reward, unlockerFor(f.contracts.vault, 'spend')())
      .addInput(fund(f, mallory), mallory.signer.unlockP2PKH())
      .addOutput({ to: mallory.address, amount: 2000n, token: reward.token! });
    await expect(tx.send()).rejects.toThrow(/Require statement failed at input 0 in contract PoolVault/);
  });
});

describe('proof depth', () => {
  it.each([9, 16, 24])('accepts a claim with a proof of depth %i', async (depth) => {
    const leaf = leafOf(alice, 1234n);
    const { proof, root } = syntheticProof(leaf, depth, 2 ** depth - 1);
    const f = await deployPool(stateFor(root));
    await claim(f, leaf, proof, alice);
    expect(await tokenBalance(f, alice.address, f.contracts.params.rewardCategory)).toBe(1234n);
  });

  it('rejects a proof deeper than maxDepth (25)', async () => {
    const leaf = leafOf(alice, 1234n);
    const { proof, root } = syntheticProof(leaf, 25, 7);
    const f = await deployPool(stateFor(root));
    expect(binToHex(hashLeaf(leaf))).toHaveLength(64);
    await expect(claim(f, leaf, proof, alice)).rejects.toThrow(POOL_REJECTS);
  });
});
