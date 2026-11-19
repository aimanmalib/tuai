import { TransactionBuilder, type Output, type SignatureTemplate, type SpendableUtxo, type Unlocker } from 'cashscript';
import { unlockerFor, type PoolContracts } from '../pool/contracts.ts';
import { shardsOf, type PendingUtxo, type PoolUtxos } from '../pool/utxos.ts';
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

/**
 * Copies the pending root into one pool state NFT. Valid once the pending UTXO is `activationDelay` blocks old.
 * A sharded pool (ADR 0013) activates its stale shards one transaction at a time, oldest epoch first; each
 * activation recreates the pending UTXO, so the next one waits the delay again.
 */
export function planActivate(o: ActivateOptions): ActivatePlan {
  const { pool, gate, params } = o.contracts;
  const next = o.pending.pending;
  const stale = shardsOf(o.pool).filter((s) => s.state.epoch < next.epoch);
  const target = stale.reduce<(typeof stale)[number] | undefined>((a, s) => (!a || s.state.epoch < a.state.epoch ? s : a), undefined);
  if (!target) throw new Error(`nothing to activate: pending epoch ${next.epoch}, active epoch ${o.pool.decodedState.epoch}`);
  const state = target.utxo;
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
