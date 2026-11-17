import { TransactionBuilder, type Output, type SignatureTemplate, type SpendableUtxo, type Unlocker } from 'cashscript';
import { binsAreEqual } from '@bitauth/libauth';
import { encodeState } from '../pool/encoding.ts';
import { unlockerFor, type PoolContracts } from '../pool/contracts.ts';
import type { PendingUtxo, PoolUtxos } from '../pool/utxos.ts';
import { blockSequence } from '../gate/maturity.ts';

export interface ActivateOptions {
  contracts: PoolContracts;
  pool: PoolUtxos;
  pending: PendingUtxo;
  /** Anyone may fund an activation; no operator key is involved. */
  funding: { utxos: SpendableUtxo[]; signer: SignatureTemplate; changeAddress: string };
  feeRate: number;
}

export interface ActivateInput {
  utxo: SpendableUtxo;
  unlocker: Unlocker;
  sequence?: number;
}

/** An activation before it is assembled; tests alter it to prove the contracts reject tampered transactions. */
export interface ActivatePlan {
  inputs: ActivateInput[];
  outputs: Output[];
  changeAddress: string;
  feeRate: number;
}

/** Copies the pending root into the pool state. Valid once the pending UTXO is `activationDelay` blocks old. */
export function planActivate(o: ActivateOptions): ActivatePlan {
  const { pool, gate, params } = o.contracts;
  const active = o.pool.decodedState;
  const next = o.pending.pending;
  if (next.epoch <= active.epoch) throw new Error(`nothing to activate: pending epoch ${next.epoch}, active epoch ${active.epoch}`);
  if (binsAreEqual(encodeState(next), encodeState(active))) throw new Error('the pending root is already active');
  const state = o.pool.state;
  const pending = o.pending.utxo;
  if (!state.token?.nft || !pending.token?.nft) throw new Error('pool state or pending UTXO has no NFT');
  const payer = o.funding.signer.unlockP2PKH();
  return {
    inputs: [
      { utxo: state, unlocker: unlockerFor(pool, 'activate')() },
      { utxo: pending, unlocker: unlockerFor(gate, 'activate')(), sequence: blockSequence(params.activationDelay) },
      ...o.funding.utxos.map((utxo) => ({ utxo, unlocker: payer })),
    ],
    outputs: [
      { to: pool.tokenAddress, amount: state.satoshis, token: { ...state.token, nft: { ...state.token.nft, commitment: pending.token.nft.commitment } } },
      { to: gate.tokenAddress, amount: pending.satoshis, token: pending.token },
    ],
    changeAddress: o.funding.changeAddress,
    feeRate: o.feeRate,
  };
}

export function assembleActivate(plan: ActivatePlan, provider: PoolContracts['pool']['provider']): TransactionBuilder {
  const builder = new TransactionBuilder({ provider });
  for (const input of plan.inputs) {
    builder.addInput(input.utxo, input.unlocker, input.sequence === undefined ? undefined : { sequence: input.sequence });
  }
  return builder.addOutputs(plan.outputs).addBchChangeOutputIfNeeded({ to: plan.changeAddress, feeRate: plan.feeRate });
}

export const buildActivate = (o: ActivateOptions): TransactionBuilder => assembleActivate(planActivate(o), o.contracts.pool.provider);
