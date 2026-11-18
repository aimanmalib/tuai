import { binToHex } from '@bitauth/libauth';
import { poolContracts, type PoolContracts } from '../pool/contracts.ts';
import { readPending, readPool } from '../pool/utxos.ts';
import { blocksUntilActivation, secondsUntilActivation } from '../gate/maturity.ts';
import type { Context } from './context.ts';
import { requirePool } from './runs.ts';

export const contractsFor = (ctx: Context): PoolContracts => poolContracts(requirePool(ctx), ctx.provider);

export const stateJson = (s: { root: Uint8Array; epoch: number; inputsHash: Uint8Array }) => ({
  epoch: s.epoch,
  root: binToHex(s.root),
  inputsHash: binToHex(s.inputsHash),
});

/**
 * Active root, pending root and what remains before the pending root can be activated: blocks, or seconds of
 * median time past on networks whose nodes read sequence locks in time units (`sequenceSecondsPerBlock`).
 */
export async function poolStatus(ctx: Context, contracts: PoolContracts) {
  const pool = await readPool(contracts);
  const pending = await readPending(contracts);
  const height = await ctx.provider.getBlockHeight();
  const confirmed = ctx.confirmedHeight ? await ctx.confirmedHeight(pending.utxo.txid) : undefined;
  const delay = contracts.params.activationDelay;
  const perBlock = ctx.config.networks[ctx.network].sequenceSecondsPerBlock;
  let blocksLeft = blocksUntilActivation(confirmed, delay, height);
  let secondsLeft: number | undefined;
  if (perBlock && ctx.medianTime && confirmed !== undefined) {
    secondsLeft = secondsUntilActivation(await ctx.medianTime(confirmed - 1), delay, await ctx.medianTime(height), perBlock);
    // Not ready by time: report at least one more block, since the median time only moves when blocks arrive.
    if (secondsLeft !== undefined && secondsLeft > 0) blocksLeft = Math.max(1, blocksLeft ?? 1);
  }
  return { pool, pending, height, confirmed, blocksLeft, secondsLeft, tracked: ctx.confirmedHeight !== undefined };
}
