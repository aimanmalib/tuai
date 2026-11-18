import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolParams } from '../pool/contracts.ts';
import type { Context } from './context.ts';

export interface TxRecord {
  kind: string;
  txid: string | null;
  bytes: number;
  feeSats: number;
  /** Value that left the project wallet: fee plus value locked in outputs the wallet does not own. */
  spentSats: number;
  utc: string;
  /** Present when the network refused the transaction (recorded on purpose, for example an early activation). */
  error?: string;
  note?: string;
}

/** Operating log per deployment (network, or network plus run name) under state/runs: pool parameters, reward category and every broadcast. */
export interface RunLog {
  network: string;
  rewardCategory?: string;
  pool?: PoolParams & { deployTxid: string };
  txs: TxRecord[];
}

export const runLogPath = (ctx: Context): string => resolve(ctx.stateDir, 'runs', `${ctx.deployment}.json`);

export function readRunLog(ctx: Context): RunLog {
  const path = runLogPath(ctx);
  if (!existsSync(path)) return { network: ctx.network, txs: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as RunLog;
}

export function writeRunLog(ctx: Context, log: RunLog): void {
  mkdirSync(resolve(ctx.stateDir, 'runs'), { recursive: true });
  writeFileSync(runLogPath(ctx), `${JSON.stringify(log, null, 1)}\n`);
}

export function updateRunLog(ctx: Context, change: (log: RunLog) => void): RunLog {
  const log = readRunLog(ctx);
  change(log);
  writeRunLog(ctx, log);
  return log;
}

export function requirePool(ctx: Context): PoolParams & { deployTxid: string } {
  const pool = readRunLog(ctx).pool;
  if (!pool) throw new Error(`no pool deployed on ${ctx.deployment} yet; run tuai deploy first`);
  return pool;
}
