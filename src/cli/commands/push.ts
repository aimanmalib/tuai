// Operator push path from the command line (docs/decisions/0008-operator-push.md).
import { blocksUntilActivation } from '../../gate/maturity.ts';
import { leafFromJson } from '../../epoch/file.ts';
import { readPending, readPool } from '../../pool/utxos.ts';
import { assembleActivate } from '../../tx/activate.ts';
import { assemblePush, planArm, planPush, pushParamsOf } from '../../tx/push.ts';
import { flag, has, type ParsedArgs } from '../args.ts';
import { broadcast } from '../broadcast.ts';
import { loadKey, payerRole, type Context } from '../context.ts';
import { contractsFor, stateJson } from '../pool.ts';
import { plainUtxos, selectFunding } from '../wallet.ts';
import { activeLeaf, proofOf } from './claim.ts';
import { NotYetError } from './root.ts';

/** Enough BCH for an arm transaction (the same size as an activation) at the configured fee rate. */
const ARM_FUNDING_SATS = 10_000n;

/**
 * `arm [--force]`: opens operator pushes for the active root once the pending-root NFT that activation recreated is
 * `pushDelay` blocks old. Anyone may send it; `--force` sends it early so the network's refusal is recorded.
 */
export async function arm(ctx: Context, a: ParsedArgs) {
  const contracts = contractsFor(ctx);
  const push = pushParamsOf(contracts);
  const pool = await readPool(contracts);
  const pending = await readPending(contracts);
  const height = await ctx.provider.getBlockHeight();
  const confirmed = ctx.confirmedHeight ? await ctx.confirmedHeight(pending.utxo.txid) : undefined;
  const scale = ctx.config.networks[ctx.network].sequenceBlockScale ?? 1;
  const blocksLeft = blocksUntilActivation(confirmed, push.delay * scale, height);
  const tracked = ctx.confirmedHeight !== undefined;
  if (tracked && blocksLeft !== 0 && !has(a, 'force')) throw new NotYetError(blocksLeft, 'arming pushes');
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const funding = selectFunding(await plainUtxos(ctx, payer), ARM_FUNDING_SATS);
  const plan = planArm({
    contracts,
    pool,
    pending,
    funding: { utxos: funding, signer: payer.signer, changeAddress: payer.address },
    feeRate: ctx.config.fees.satsPerByte,
  });
  const seen = tracked ? `pending mined at ${confirmed ?? 'unconfirmed'}, tip ${height}` : '';
  const forced = tracked && blocksLeft !== 0 ? `forced ${blocksLeft ?? 'unconfirmed'} block(s) early` : '';
  const note = [forced, seen].filter(Boolean).join('; ');
  const tx = await broadcast(ctx, assembleActivate(plan, ctx.provider), {
    kind: `arm-epoch-${pool.decodedState.epoch}`,
    ownInputs: funding,
    ownLockingBytecode: payer.lockingBytecode,
    ...(note ? { note } : {}),
  });
  return { armed: stateJson(pool.decodedState), pushDelay: push.delay, tx };
}

/**
 * `push <address> --epoch <file> [--force]`: pays the leaf's unclaimed balance to the leaf's own locking bytecode.
 * No wallet input: the vault's BCH pays the dust and fee. A balance below `pushMinimum` is refused before sending;
 * `--force` builds it anyway and sends it without the local script check, so the network's refusal is recorded.
 */
export async function push(ctx: Context, a: ParsedArgs) {
  const address = a.positional[1];
  if (!address) throw new Error('usage: tuai push <address> --epoch <file>');
  const { entry, epoch, contracts, live } = await activeLeaf(ctx, a, address);
  const params = pushParamsOf(contracts);
  const force = has(a, 'force');
  // A forced plan uses a minimum of 1 so it can be built; the contract still holds the deployed minimum.
  const planned = force ? { ...contracts, params: { ...contracts.params, push: { ...params, minimum: '1' } } } : contracts;
  const plan = planPush({
    contracts: planned,
    pool: live,
    pending: await readPending(contracts),
    leaf: leafFromJson(entry),
    proof: proofOf(entry),
    paymentSats: BigInt(ctx.config.fees.tokenOutputDustSats),
    receiptSats: BigInt(ctx.config.fees.receiptDustSats),
    feeRate: ctx.config.fees.satsPerByte,
  });
  const below = plan.payment < BigInt(params.minimum);
  const tx = await broadcast(ctx, assemblePush(plan, ctx.provider), {
    kind: `push-${plan.kind}-epoch-${epoch}`,
    ownInputs: [],
    ownLockingBytecode: new Uint8Array(),
    note: `leaf ${entry.index}, ${plan.vaultSats} sats from the vault${below ? `, below the minimum ${params.minimum}` : ''}`,
    localCheck: !force,
  });
  return { kind: plan.kind, leaf: entry.index, address: entry.address, paid: plan.payment.toString(), vaultSats: plan.vaultSats.toString(), tx };
}
