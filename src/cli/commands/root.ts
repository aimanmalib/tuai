import { hexToBinChecked } from '../../bytes.ts';
import { readEpochFile } from '../../epoch/file.ts';
import { buildActivate } from '../../tx/activate.ts';
import { buildPropose } from '../../tx/propose.ts';
import { flag, has, requireFlag, type ParsedArgs } from '../args.ts';
import { broadcast } from '../broadcast.ts';
import { loadKey, payerRole, type Context } from '../context.ts';
import { contractsFor, poolStatus, stateJson } from '../pool.ts';
import { readPending } from '../../pool/utxos.ts';
import { plainUtxos, selectFunding } from '../wallet.ts';

/** Enough BCH for one operator transaction at the configured fee rate, with room to spare. */
const OPERATOR_FUNDING_SATS = 10_000n;

/** `propose --epoch <file> [--operators 1,3]`: two operators sign the epoch's root, epoch and inputs hash. */
export async function propose(ctx: Context, a: ParsedArgs) {
  const file = readEpochFile(requireFlag(a, 'epoch'));
  if (file.network !== ctx.network) throw new Error(`epoch file is for ${file.network}, not ${ctx.network}`);
  const which = (flag(a, 'operators') ?? '1,2').split(',').map((s) => s.trim());
  const operators = which.map((n) => loadKey(ctx, `operator-${n}`));
  const contracts = contractsFor(ctx);
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const funding = selectFunding(await plainUtxos(ctx, payer), OPERATOR_FUNDING_SATS);
  const proposal = { root: hexToBinChecked(file.root, 32), epoch: file.epoch, inputsHash: hexToBinChecked(file.inputsHash, 32) };
  const builder = buildPropose({
    contracts,
    pending: await readPending(contracts),
    proposal,
    operators: operators.map((o) => o.signer),
    funding: { utxos: funding, signer: payer.signer, changeAddress: payer.address },
    feeRate: ctx.config.fees.satsPerByte,
  });
  const tx = await broadcast(ctx, builder, {
    kind: `propose-epoch-${file.epoch}`,
    ownInputs: funding,
    ownLockingBytecode: payer.lockingBytecode,
    note: `operators ${which.join(',')}`,
  });
  return { proposed: stateJson(proposal), activationDelay: contracts.params.activationDelay, tx };
}

export class NotYetError extends Error {
  constructor(readonly blocksLeft: number | undefined) {
    super(
      blocksLeft === undefined
        ? 'the pending root is not confirmed yet; activation is possible once it has aged the activation delay'
        : `the pending root can be activated in ${blocksLeft} more block(s)`,
    );
  }
}

/** `activate [--force]`: anyone moves the pending root into the pool once it is old enough. */
export async function activate(ctx: Context, a: ParsedArgs) {
  const contracts = contractsFor(ctx);
  const s = await poolStatus(ctx, contracts);
  const tracked = s.tracked;
  if (tracked && s.blocksLeft !== 0 && !has(a, 'force')) throw new NotYetError(s.blocksLeft);
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const funding = selectFunding(await plainUtxos(ctx, payer), OPERATOR_FUNDING_SATS);
  const builder = buildActivate({
    contracts,
    pool: s.pool,
    pending: s.pending,
    funding: { utxos: funding, signer: payer.signer, changeAddress: payer.address },
    feeRate: ctx.config.fees.satsPerByte,
  });
  const early = s.blocksLeft !== 0 && tracked;
  const tx = await broadcast(ctx, builder, {
    kind: `activate-epoch-${s.pending.pending.epoch}`,
    ownInputs: funding,
    ownLockingBytecode: payer.lockingBytecode,
    ...(early ? { note: `forced ${s.blocksLeft ?? 'unconfirmed'} block(s) early` } : {}),
  });
  return { activated: stateJson(s.pending.pending), tx };
}
