import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Mainnet spending ledger: every broadcast adds what left the project wallet (fees plus value locked elsewhere). */
export interface Ledger {
  total_sats: number;
  entries: Array<{ txid: string; sats: number; utc: string; kind: string }>;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spent: number,
    readonly next: number,
    readonly limit: number,
  ) {
    super(`mainnet budget exceeded: ${spent} + ${next} sats is above the limit of ${limit} sats`);
  }
}

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return { total_sats: 0, entries: [] };
  const ledger = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  const sum = ledger.entries.reduce((s, e) => s + e.sats, 0);
  if (sum !== ledger.total_sats) throw new Error(`ledger ${path} is inconsistent: entries sum to ${sum}, total says ${ledger.total_sats}`);
  return ledger;
}

/** Refuses a spend that would take the ledger above the limit. Called before every mainnet broadcast. */
export function checkBudget(ledger: Ledger, sats: number, limit: number): void {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new RangeError(`bad spend: ${sats}`);
  if (ledger.total_sats + sats > limit) throw new BudgetExceededError(ledger.total_sats, sats, limit);
}

export function recordSpend(path: string, entry: Ledger['entries'][number]): Ledger {
  const ledger = readLedger(path);
  const next = { total_sats: ledger.total_sats + entry.sats, entries: [...ledger.entries, entry] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 1)}\n`);
  return next;
}
