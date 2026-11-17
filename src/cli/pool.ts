import { binToHex } from '@bitauth/libauth';
import { poolContracts, type PoolContracts } from '../pool/contracts.ts';
import { readPending, readPool } from '../pool/utxos.ts';
import { blocksUntilActivation } from '../gate/maturity.ts';
import type { Context } from './context.ts';
import { requirePool } from './runs.ts';

export const contractsFor = (ctx: Context): PoolContracts => poolContracts(requirePool(ctx), ctx.provider);

export const stateJson = (s: { root: Uint8Array; epoch: number; inputsHash: Uint8Array }) => ({
  epoch: s.epoch,
  root: binToHex(s.root),
  inputsHash: binToHex(s.inputsHash),
});

/** Active root, pending root and how many blocks remain before the pending root can be activated. */
export async function poolStatus(ctx: Context, contracts: PoolContracts) {
  const pool = await readPool(contracts);
  const pending = await readPending(contracts);
  const height = await ctx.provider.getBlockHeight();
  const confirmed = ctx.confirmedHeight ? await ctx.confirmedHeight(pending.utxo.txid) : undefined;
  const blocksLeft = blocksUntilActivation(confirmed, contracts.params.activationDelay, height);
  return { pool, pending, height, confirmed, blocksLeft, tracked: ctx.confirmedHeight !== undefined };
}
