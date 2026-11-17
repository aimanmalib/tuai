import {
  SignatureAlgorithm, SignatureTemplate, TransactionBuilder, type NetworkProvider, type Output, type SpendableUtxo, type Unlocker,
} from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { encodeState, type PoolState } from '../pool/encoding.ts';
import { DUST_SATS } from './fee.ts';
import { unlockerFor, type PoolContracts } from '../pool/contracts.ts';
import type { PendingUtxo } from '../pool/utxos.ts';

export interface ProposeOptions {
  contracts: PoolContracts;
  pending: PendingUtxo;
  /** The root, epoch and inputs hash to propose. */
  proposal: PoolState;
  /** Two distinct operator keys. Their order does not matter; the builder orders them as the gate expects. */
  operators: readonly SignatureTemplate[];
  funding: { utxos: SpendableUtxo[]; signer: SignatureTemplate; changeAddress: string };
  feeRate: number;
}

/**
 * Orders two operator keys as the gate's key list, which OP_CHECKMULTISIG requires, and signs with ECDSA:
 * CashScript passes a zero dummy element, which selects ECDSA mode for multisig (Schnorr multisig needs a bitfield).
 */
export function orderOperators(keys: readonly string[], operators: readonly SignatureTemplate[]): [SignatureTemplate, SignatureTemplate] {
  const positions = operators.map((o) => keys.indexOf(binToHex(o.publicKey)));
  if (operators.length !== 2 || positions.some((p) => p < 0) || positions[0] === positions[1]) {
    throw new Error('a proposal needs two distinct operator keys of this gate');
  }
  const [a, b] = operators
    .map((o, i) => ({ p: positions[i] as number, s: new SignatureTemplate(o.privateKey, undefined, SignatureAlgorithm.ECDSA) }))
    .sort((x, y) => x.p - y.p);
  if (!a || !b) throw new Error('unreachable');
  return [a.s, b.s];
}

/** DER signatures vary by a byte or two between signings; this covers both operator signatures. */
const SIGNATURE_SLACK_BYTES = 4n;

/** A proposal before it is assembled; tests alter it to prove the gate rejects tampered transactions. */
export interface ProposePlan {
  inputs: Array<{ utxo: SpendableUtxo; unlocker: Unlocker }>;
  outputs: Output[];
  changeAddress: string;
  feeRate: number;
}

/** Replaces the pending root. Activation becomes possible `activationDelay` blocks after this transaction confirms. */
export function planPropose(o: ProposeOptions): ProposePlan {
  if (o.proposal.epoch < o.pending.pending.epoch) throw new Error('the proposed epoch is below the pending epoch');
  const { gate, params } = o.contracts;
  const [first, second] = orderOperators(params.operatorKeys, o.operators);
  const pending = o.pending.utxo;
  const payer = o.funding.signer.unlockP2PKH();
  return {
    inputs: [{ utxo: pending, unlocker: unlockerFor(gate, 'propose')(first, second) }, ...o.funding.utxos.map((utxo) => ({ utxo, unlocker: payer }))],
    outputs: [
      {
        to: gate.tokenAddress,
        amount: pending.satoshis,
        token: { category: params.poolCategory, amount: 0n, nft: { capability: 'mutable', commitment: binToHex(encodeState(o.proposal)) } },
      },
    ],
    changeAddress: o.funding.changeAddress,
    feeRate: o.feeRate,
  };
}

/**
 * CashScript sizes change for 65-byte signatures; ECDSA multisig signatures are longer, so the change is sized
 * from a fully signed draft instead.
 */
export function assemblePropose(plan: ProposePlan, provider: NetworkProvider): TransactionBuilder {
  const spent = plan.inputs.reduce((sum, i) => sum + i.utxo.satoshis, 0n);
  const kept = plan.outputs.reduce((sum, out) => sum + out.amount, 0n);
  const build = (change: bigint): TransactionBuilder => {
    const builder = new TransactionBuilder({ provider });
    for (const input of plan.inputs) builder.addInput(input.utxo, input.unlocker);
    return builder.addOutputs(plan.outputs).addOutput({ to: plan.changeAddress, amount: change });
  };
  const size = build(spent - kept).getTransactionSize() + SIGNATURE_SLACK_BYTES;
  const fee = BigInt(Math.ceil(Number(size) * plan.feeRate));
  const change = spent - kept - fee;
  if (change < DUST_SATS) throw new Error(`funding does not cover the fee of ${fee} sats`);
  return build(change);
}

export const buildPropose = (o: ProposeOptions): TransactionBuilder => assemblePropose(planPropose(o), o.contracts.gate.provider);
