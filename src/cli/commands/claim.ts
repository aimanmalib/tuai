import { binToHex } from '@bitauth/libauth';
import { hexToBinChecked } from '../../bytes.ts';
import type { SpendableUtxo } from 'cashscript';
import { findLeaf, leafFromJson, readEpochFile, type LeafJson } from '../../epoch/file.ts';
import { addressToLockingBytecode } from '../../leaf.ts';
import { readPool, type PoolUtxos } from '../../pool/utxos.ts';
import { assembleClaim, planClaim, type ClaimPlan } from '../../tx/claim.ts';
import { flag, requireFlag, type ParsedArgs } from '../args.ts';
import { broadcast } from '../broadcast.ts';
import { loadKey, payerRole, type Context, type ProjectKey } from '../context.ts';
import { contractsFor } from '../pool.ts';
import { plainUtxos, selectFunding } from '../wallet.ts';

/** Covers a first claim at the deepest supported tree plus the payment and receipt outputs. */
const CLAIM_FUNDING_SATS = 10_000n;

export interface PreparedClaim {
  entry: LeafJson;
  epoch: number;
  plan: ClaimPlan;
  funding: SpendableUtxo[];
  payer: ProjectKey;
}

/**
 * Finds the leaf for `address` in an epoch file and plans its claim against the pool. `adjustPool` lets the
 * double-claim demonstration hide a receipt; normal claims pass nothing.
 */
export async function prepareClaim(
  ctx: Context,
  a: ParsedArgs,
  address: string,
  adjustPool?: (pool: PoolUtxos, lockingBytecode: Uint8Array) => PoolUtxos,
): Promise<PreparedClaim> {
  const file = readEpochFile(requireFlag(a, 'epoch'));
  const lockingBytecode = addressToLockingBytecode(address, ctx.prefix);
  const entry = findLeaf(file, binToHex(lockingBytecode));
  if (!entry) throw new Error(`${address} has no leaf in epoch ${file.epoch}`);
  const contracts = contractsFor(ctx);
  const live = await readPool(contracts);
  const active = binToHex(live.decodedState.root);
  if (active !== file.root || live.decodedState.epoch !== file.epoch) {
    throw new Error(`epoch file root ${file.root} (epoch ${file.epoch}) is not the active root ${active} (epoch ${live.decodedState.epoch})`);
  }
  const pool = adjustPool ? adjustPool(live, lockingBytecode) : live;
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const funding = selectFunding(await plainUtxos(ctx, payer), CLAIM_FUNDING_SATS);
  const plan = planClaim({
    contracts,
    pool,
    leaf: leafFromJson(entry),
    proof: { index: entry.index, siblings: entry.proof.map((s) => hexToBinChecked(s, 32)) },
    funding: { utxos: funding, signer: payer.signer, changeAddress: payer.address },
    paymentSats: BigInt(ctx.config.fees.tokenOutputDustSats),
    receiptSats: BigInt(ctx.config.fees.receiptDustSats),
    feeRate: ctx.config.fees.satsPerByte,
  });
  return { entry, epoch: file.epoch, plan, funding, payer };
}

/**
 * `claim <address> --epoch <file> [--payer <role or key file>]`: pays the leaf's unclaimed amount to the leaf's own
 * address. Whoever funds the claim pays the fee and dust; the reward always goes to the address in the leaf.
 */
export async function claim(ctx: Context, a: ParsedArgs) {
  const address = a.positional[1];
  if (!address) throw new Error('usage: tuai claim <address> --epoch <file>');
  const { entry, epoch, plan, funding, payer } = await prepareClaim(ctx, a, address);
  const builder = assembleClaim(plan, ctx.provider);
  const tx = await broadcast(ctx, builder, {
    kind: `claim-${plan.kind}-epoch-${epoch}`,
    ownInputs: funding,
    ownLockingBytecode: payer.lockingBytecode,
    note: `leaf ${entry.index}`,
  });
  return { kind: plan.kind, leaf: entry.index, address: entry.address, paid: plan.payment.toString(), cumulative: entry.cumulative, tx };
}
