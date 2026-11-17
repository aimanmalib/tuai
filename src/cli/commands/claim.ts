import { binToHex } from '@bitauth/libauth';
import { hexToBinChecked } from '../../bytes.ts';
import { findLeaf, leafFromJson, readEpochFile } from '../../epoch/file.ts';
import { addressToLockingBytecode } from '../../leaf.ts';
import { readPool } from '../../pool/utxos.ts';
import { assembleClaim, planClaim } from '../../tx/claim.ts';
import { flag, requireFlag, type ParsedArgs } from '../args.ts';
import { broadcast } from '../broadcast.ts';
import { loadKey, payerRole, type Context } from '../context.ts';
import { contractsFor } from '../pool.ts';
import { plainUtxos, selectFunding } from '../wallet.ts';

/** Covers a first claim at the deepest supported tree plus the payment and receipt outputs. */
const CLAIM_FUNDING_SATS = 10_000n;

/**
 * `claim <address> --epoch <file> [--payer <role or key file>]`: pays the leaf's unclaimed amount to the leaf's own
 * address. Whoever funds the claim pays the fee and dust; the reward always goes to the address in the leaf.
 */
export async function claim(ctx: Context, a: ParsedArgs) {
  const address = a.positional[1];
  if (!address) throw new Error('usage: tuai claim <address> --epoch <file>');
  const file = readEpochFile(requireFlag(a, 'epoch'));
  const lockingBytecode = binToHex(addressToLockingBytecode(address, ctx.prefix));
  const entry = findLeaf(file, lockingBytecode);
  if (!entry) throw new Error(`${address} has no leaf in epoch ${file.epoch}`);
  const contracts = contractsFor(ctx);
  const pool = await readPool(contracts);
  const active = binToHex(pool.decodedState.root);
  if (active !== file.root || pool.decodedState.epoch !== file.epoch) {
    throw new Error(`epoch file root ${file.root} (epoch ${file.epoch}) is not the active root ${active} (epoch ${pool.decodedState.epoch})`);
  }
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
  const builder = assembleClaim(plan, ctx.provider);
  const tx = await broadcast(ctx, builder, {
    kind: `claim-${plan.kind}-epoch-${file.epoch}`,
    ownInputs: funding,
    ownLockingBytecode: payer.lockingBytecode,
    note: `leaf ${entry.index}`,
  });
  return { kind: plan.kind, leaf: entry.index, address: entry.address, paid: plan.payment.toString(), cumulative: entry.cumulative, tx };
}
