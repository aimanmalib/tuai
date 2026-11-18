// Operator push (docs/decisions/0008-operator-push.md): arm the push window, then push a leaf's unclaimed balance.
import { TransactionBuilder, type NetworkProvider, type Output, type SignatureTemplate, type SpendableUtxo } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { encodeState, ARM_FLAG } from '../pool/encoding.ts';
import { unlockerFor, type PoolContracts, type PushParams } from '../pool/contracts.ts';
import type { PendingUtxo, PoolUtxos } from '../pool/utxos.ts';
import { blockSequence } from '../gate/maturity.ts';
import { DUST_SATS } from './fee.ts';
import type { ActivatePlan } from './activate.ts';
import { planClaimCore, type ClaimCoreOptions, type ClaimInput } from './claim.ts';

export const pushParamsOf = (contracts: PoolContracts): PushParams => {
  const push = contracts.params.push;
  if (!push) throw new Error('this pool has no push path (version 1 contracts, deployed before ADR 0008)');
  return push;
};

export interface ArmOptions {
  contracts: PoolContracts;
  pool: Pick<PoolUtxos, 'state' | 'decodedState'>;
  pending: PendingUtxo;
  /** Anyone may fund the arm transaction; no key is involved. */
  funding: { utxos: SpendableUtxo[]; signer: SignatureTemplate; changeAddress: string };
  feeRate: number;
}

/**
 * Opens operator pushes for the active root. Valid once the pending NFT, which activation recreated, is `push.delay`
 * blocks old and still equals the active state. Same layout as an activation; the state NFT stays unchanged.
 */
export function planArm(o: ArmOptions): ActivatePlan {
  const push = pushParamsOf(o.contracts);
  const { pool, gate } = o.contracts;
  if (o.pending.armed) throw new Error('pushes are already armed for the active root');
  const active = binToHex(encodeState(o.pool.decodedState));
  const pending = o.pending.utxo;
  if (pending.token?.nft?.commitment !== active) throw new Error('a newer root is pending; pushes open only after it is active');
  const state = o.pool.state;
  if (!state.token?.nft) throw new Error('pool state UTXO has no NFT');
  const payer = o.funding.signer.unlockP2PKH();
  return {
    inputs: [
      { utxo: state, unlocker: unlockerFor(pool, 'activate')() },
      { utxo: pending, unlocker: unlockerFor(gate, 'arm')(), sequence: blockSequence(push.delay) },
      ...o.funding.utxos.map((utxo) => ({ utxo, unlocker: payer })),
    ],
    outputs: [
      { to: pool.tokenAddress, amount: state.satoshis, token: state.token },
      { to: gate.tokenAddress, amount: pending.satoshis, token: { ...pending.token, nft: { ...pending.token.nft, commitment: active + ARM_FLAG } } },
    ],
    changeAddress: o.funding.changeAddress,
    feeRate: o.feeRate,
  };
}

export interface PushOptions extends ClaimCoreOptions {
  pending: PendingUtxo;
  feeRate: number;
}

/** A push before it is assembled; tests alter it to prove the contracts reject tampered transactions. */
export interface PushPlan {
  kind: 'first' | 'additional';
  payment: bigint;
  inputs: ClaimInput[];
  outputs: Output[];
  /** Satoshis the push takes from the vault's reward UTXO (output 1): payment dust, new receipt dust and fee. */
  vaultSats: bigint;
  fee: bigint;
}

/**
 * Pushes a leaf's unclaimed balance to its locking bytecode. Nobody adds inputs: the vault's BCH pays the payment
 * dust, a new receipt's dust and the fee, up to `push.sats`. The payment must be at least `push.minimum`.
 */
export function planPush(o: PushOptions): PushPlan {
  const push = pushParamsOf(o.contracts);
  if (!o.pending.armed) throw new Error('pushes are not armed for the active root; run arm once the push delay has passed');
  const core = planClaimCore(o);
  if (core.payment < BigInt(push.minimum)) throw new Error(`payment ${core.payment} is below the push minimum ${push.minimum}`);
  const pending = o.pending.utxo;
  const pendingToken = pending.token;
  if (!pendingToken?.nft) throw new Error('pending-root UTXO has no NFT');
  const gatePush = unlockerFor(o.contracts.gate, 'push')();
  const inputs = [...core.inputs, { utxo: pending, unlocker: gatePush }];
  const outputsWith = (vaultSats: bigint): Output[] => {
    const outputs = core.outputs.map((out) => ({ ...out }));
    const reward = outputs[1] as Output;
    outputs[1] = { ...reward, amount: core.reward.satoshis - vaultSats };
    return [...outputs, { to: o.contracts.gate.tokenAddress, amount: pending.satoshis, token: pendingToken }];
  };
  const dust = core.kind === 'first' ? o.paymentSats + o.receiptSats : o.paymentSats;
  const draft = assemblePush({ inputs, outputs: outputsWith(dust) }, o.contracts.pool.provider);
  const fee = BigInt(Math.ceil(Number(draft.getTransactionSize()) * o.feeRate));
  const vaultSats = dust + fee;
  if (vaultSats > BigInt(push.sats)) throw new Error(`push needs ${vaultSats} sats from the vault, more than the limit of ${push.sats}`);
  if (core.reward.satoshis - vaultSats < DUST_SATS) throw new Error('the vault reward UTXO does not hold enough BCH for this push');
  return { kind: core.kind, payment: core.payment, inputs, outputs: outputsWith(vaultSats), vaultSats, fee };
}

export function assemblePush(plan: Pick<PushPlan, 'inputs' | 'outputs'>, provider: NetworkProvider, allowBurn = false): TransactionBuilder {
  const builder = new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: allowBurn });
  for (const input of plan.inputs) builder.addInput(input.utxo, input.unlocker);
  return builder.addOutputs(plan.outputs);
}

export const buildPush = (o: PushOptions): TransactionBuilder => assemblePush(planPush(o), o.contracts.pool.provider);
