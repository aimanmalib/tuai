import { binToHex } from '@bitauth/libauth';
import { poolBalance, shardsOf } from '../../pool/utxos.ts';
import { flag, type ParsedArgs } from '../args.ts';
import { readLedger } from '../budget.ts';
import { ledgerPath } from '../broadcast.ts';
import { loadKey, payerRole, type Context } from '../context.ts';
import { contractsFor, poolStatus, stateJson } from '../pool.ts';
import { readRunLog } from '../runs.ts';
import { balanceOf, plainUtxos } from '../wallet.ts';

/** `status`: payer balance, and when a pool exists its active root, pending root, timelock and balance. */
export async function status(ctx: Context, a: ParsedArgs) {
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const payerSats = balanceOf(await plainUtxos(ctx, payer));
  const log = readRunLog(ctx);
  const base = { network: ctx.network, payer: { address: payer.address, sats: payerSats.toString() }, transactions: log.txs.length };
  if (!log.pool) return { ...base, pool: null };
  const contracts = contractsFor(ctx);
  const s = await poolStatus(ctx, contracts);
  return {
    ...base,
    pool: {
      category: contracts.params.poolCategory,
      rewardCategory: contracts.params.rewardCategory,
      active: stateJson(s.pool.decodedState),
      // ADR 0013: state NFT copies, and how many still hold an older epoch than the newest one (each needs an activation).
      shards: {
        total: shardsOf(s.pool).length,
        behind: shardsOf(s.pool).filter((x) => x.state.epoch < s.pool.decodedState.epoch).length,
      },
      pending: { ...stateJson(s.pending.pending), confirmedHeight: s.confirmed ?? null, blocksLeft: s.blocksLeft ?? null },
      height: s.height,
      activationDelay: contracts.params.activationDelay,
      balance: poolBalance(s.pool.rewards).toString(),
      receipts: s.pool.receipts.filter((r) => binToHex(r.receipt.key) !== '00'.repeat(32)).length,
    },
  };
}

/** `budget`: mainnet spending against the configured limit. */
export function budget(ctx: Context) {
  const ledger = readLedger(ledgerPath(ctx));
  const limit = ctx.config.budget.mainnetMaxSats;
  return { spent: ledger.total_sats, limit, remaining: limit - ledger.total_sats, entries: ledger.entries.length };
}
