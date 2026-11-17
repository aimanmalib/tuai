import { binToHex } from '@bitauth/libauth';
import type { SpendableUtxo, TransactionBuilder } from 'cashscript';
import { addressToLockingBytecode } from '../leaf.ts';
import { checkBudget, readLedger, recordSpend } from './budget.ts';
import type { Context } from './context.ts';
import { updateRunLog, type TxRecord } from './runs.ts';
import { resolve } from 'node:path';

export interface BroadcastOptions {
  kind: string;
  /** Inputs that belong to the project wallet. */
  ownInputs: readonly SpendableUtxo[];
  /** Locking bytecode of project wallet outputs (change), which do not count as spent. */
  ownLockingBytecode: Uint8Array;
  note?: string;
}

const outpoint = (u: { txid: string; vout: number }): string => `${u.txid}:${u.vout}`;

/** Measures a built transaction: size, fee, and what it takes from the project wallet. */
export async function measure(builder: TransactionBuilder, o: BroadcastOptions): Promise<{ hex: string; bytes: number; feeSats: number; spentSats: number }> {
  const hex = await builder.build();
  const own = new Set(o.ownInputs.map(outpoint));
  const ownHex = binToHex(o.ownLockingBytecode);
  const inSats = builder.inputs.reduce((s, i) => s + i.satoshis, 0n);
  const outSats = builder.outputs.reduce((s, out) => s + out.amount, 0n);
  const ownIn = builder.inputs.filter((i) => own.has(outpoint(i))).reduce((s, i) => s + i.satoshis, 0n);
  const ownOut = builder.outputs
    .filter((out) => binToHex(typeof out.to === 'string' ? addressToLockingBytecode(out.to) : out.to) === ownHex)
    .reduce((s, out) => s + out.amount, 0n);
  const spent = ownIn - ownOut;
  return { hex, bytes: hex.length / 2, feeSats: Number(inSats - outSats), spentSats: Number(spent > 0n ? spent : 0n) };
}

export const ledgerPath = (ctx: Context): string => resolve(ctx.repoRoot, ctx.config.budget.ledgerPath);

/**
 * The only way commands send transactions. On mainnet the budget is checked before sending and the ledger is
 * updated after; every attempt, including a refused one, is written to the run log.
 */
export async function broadcast(ctx: Context, builder: TransactionBuilder, o: BroadcastOptions): Promise<TxRecord> {
  const m = await measure(builder, o);
  if (ctx.network === 'mainnet') checkBudget(readLedger(ledgerPath(ctx)), m.spentSats, ctx.config.budget.mainnetMaxSats);
  const utc = ctx.now().toISOString();
  const base = { kind: o.kind, bytes: m.bytes, feeSats: m.feeSats, spentSats: m.spentSats, utc, ...(o.note ? { note: o.note } : {}) };
  let txid: string;
  try {
    // Local evaluation first: script failures are reported with CashScript's names before anything is sent.
    builder.debug();
    txid = await ctx.provider.sendRawTransaction(m.hex);
  } catch (e) {
    const record: TxRecord = { ...base, txid: null, error: (e as Error).message.slice(0, 500) };
    updateRunLog(ctx, (log) => log.txs.push(record));
    throw e;
  }
  const record: TxRecord = { ...base, txid };
  updateRunLog(ctx, (log) => log.txs.push(record));
  if (ctx.network === 'mainnet') recordSpend(ledgerPath(ctx), { txid, sats: m.spentSats, utc, kind: o.kind });
  return record;
}
