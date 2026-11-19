import { TransactionBuilder, type Output, type SignatureTemplate, type SpendableUtxo, type Unlocker, type NetworkProvider } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { concat, uint64le } from '../bytes.ts';
import { assertLeaf, type Leaf } from '../leaf.ts';
import type { MerkleProof } from '../merkle/proof.ts';
import { encodeReceipt, findReceipt, receiptKey, type Receipt } from '../pool/encoding.ts';
import { unlockerFor, type PoolContracts } from '../pool/contracts.ts';
import { shardsOf, type PoolUtxos, type ReceiptUtxo } from '../pool/utxos.ts';
import { pickShard } from '../pool/shards.ts';

export interface ClaimOptions {
  contracts: PoolContracts;
  pool: PoolUtxos;
  leaf: Leaf;
  proof: MerkleProof;
  /** Anyone may fund a claim; the payment still goes to the leaf's locking bytecode. */
  funding: { utxos: SpendableUtxo[]; signer: SignatureTemplate | ((utxo: SpendableUtxo) => Unlocker); changeAddress: string };
  /** Satoshis carried by the payment output and by a newly inserted receipt (paid by the claimant). */
  paymentSats: bigint;
  receiptSats: bigint;
  feeRate: number;
}

export interface ClaimInput {
  utxo: SpendableUtxo;
  unlocker: Unlocker;
}

/** A claim before it is assembled; tests alter it to prove the contract rejects tampered transactions. */
export interface ClaimPlan {
  kind: 'first' | 'additional';
  payment: bigint;
  receipt: ReceiptUtxo;
  inputs: ClaimInput[];
  outputs: Output[];
  changeAddress: string;
  feeRate: number;
}

const receiptToken = (category: string, receipt: Receipt) => ({
  category,
  amount: 0n,
  nft: { capability: 'none' as const, commitment: binToHex(encodeReceipt(receipt)) },
});

/** What a claim and an operator push share: inputs 0..2 and outputs 0..(3 or 4). */
export interface ClaimCore {
  kind: 'first' | 'additional';
  payment: bigint;
  receipt: ReceiptUtxo;
  /** The reward token UTXO the payment comes from (input 1). */
  reward: SpendableUtxo;
  inputs: ClaimInput[];
  outputs: Output[];
}

export type ClaimCoreOptions = Pick<ClaimOptions, 'contracts' | 'pool' | 'leaf' | 'proof' | 'paymentSats' | 'receiptSats'>;

/** Builds the pool part of a claim paying `leaf.cumulative - claimed` reward tokens to the leaf's own locking bytecode. */
export function planClaimCore(o: ClaimCoreOptions): ClaimCore {
  assertLeaf(o.leaf);
  const { pool, vault, params } = o.contracts;
  const key = receiptKey(o.leaf.lockingBytecode);
  const match = findReceipt(o.pool.receipts, (r) => r.receipt, key);
  if (!match) throw new Error('no receipt to spend for this claim: the receipt list is inconsistent');
  const claimed = match.kind === 'own' ? match.receipt.claimed : 0n;
  const payment = o.leaf.cumulative - claimed;
  if (payment <= 0n) throw new Error('nothing to claim: this leaf is already fully claimed');
  const { state, reward } = pickShard(shardsOf(o.pool), o.pool.rewards, key, payment);
  if (!reward?.token) throw new Error('no reward UTXO holds more than the payment');
  if (!state.token) throw new Error('pool state UTXO has no token');

  const claim = unlockerFor(pool, 'claim')(
    Uint8Array.of(o.leaf.method),
    uint64le(o.leaf.cumulative),
    o.leaf.lockingBytecode,
    BigInt(o.proof.index),
    concat(...o.proof.siblings),
  );
  const spend = unlockerFor(vault, 'spend')();
  const inputs: ClaimInput[] = [
    { utxo: state, unlocker: claim },
    { utxo: reward, unlocker: spend },
    { utxo: match.item.utxo, unlocker: spend },
  ];
  const prev = match.receipt;
  const kept = match.item.utxo.satoshis;
  const outputs: Output[] = [
    { to: pool.tokenAddress, amount: state.satoshis, token: state.token },
    { to: vault.tokenAddress, amount: reward.satoshis, token: { category: params.rewardCategory, amount: reward.token.amount - payment } },
    { to: o.leaf.lockingBytecode, amount: o.paymentSats, token: { category: params.rewardCategory, amount: payment } },
  ];
  if (match.kind === 'own') {
    outputs.push({ to: vault.tokenAddress, amount: kept, token: receiptToken(params.poolCategory, { ...prev, claimed: o.leaf.cumulative }) });
  } else {
    outputs.push(
      { to: vault.tokenAddress, amount: kept, token: receiptToken(params.poolCategory, { ...prev, next: key }) },
      {
        to: vault.tokenAddress,
        amount: o.receiptSats,
        token: receiptToken(params.poolCategory, { key, next: prev.next, claimed: o.leaf.cumulative }),
      },
    );
  }
  return { kind: match.kind === 'own' ? 'additional' : 'first', payment, receipt: match.item, reward, inputs, outputs };
}

/**
 * Plans a claim funded by anyone; the payment still goes to the leaf's locking bytecode. `signer` is a key, or one
 * unlocker per funding coin (a wallet's placeholder, signed later by the wallet).
 */
export function planClaim(o: ClaimOptions): ClaimPlan {
  const core = planClaimCore(o);
  const s = o.funding.signer;
  const unlock = typeof s === 'function' ? s : ((p2pkh: Unlocker) => () => p2pkh)(s.unlockP2PKH());
  return {
    kind: core.kind,
    payment: core.payment,
    receipt: core.receipt,
    inputs: [...core.inputs, ...o.funding.utxos.map((utxo) => ({ utxo, unlocker: unlock(utxo) }))],
    outputs: core.outputs,
    changeAddress: o.funding.changeAddress,
    feeRate: o.feeRate,
  };
}

/** Turns a plan into a transaction builder; claimant change (no tokens) is added last. */
export function assembleClaim(plan: ClaimPlan, provider: NetworkProvider, allowBurn = false): TransactionBuilder {
  const builder = new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: allowBurn });
  for (const input of plan.inputs) builder.addInput(input.utxo, input.unlocker);
  return builder.addOutputs(plan.outputs).addBchChangeOutputIfNeeded({ to: plan.changeAddress, feeRate: plan.feeRate });
}

export const buildClaim = (o: ClaimOptions): TransactionBuilder => assembleClaim(planClaim(o), o.contracts.pool.provider);
