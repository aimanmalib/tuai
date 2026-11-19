// Opt-in file for `tuai relay` auto-claims: which leaf holders asked to be claimed for, and from what amount.
// Data, not code: { "network": "chipnet", "optIns": [ { "address": "bchtest:...", "minAmount": "50" } ] }.
// minAmount is in reward token units, as a decimal string (token amounts can exceed 2^53).
import { readFileSync } from 'node:fs';
import { RELAY_NETWORK } from './config.ts';
import type { OptIn } from './service.ts';

export function parseOptIns(raw: unknown): OptIn[] {
  const f = raw as { network?: unknown; optIns?: unknown } | null;
  if (!f || typeof f !== 'object') throw new Error('the opt-in file must be a JSON object');
  if (f.network !== RELAY_NETWORK) throw new Error(`the opt-in file is for ${String(f.network)}, not ${RELAY_NETWORK}`);
  if (!Array.isArray(f.optIns)) throw new Error('the opt-in file has no optIns list');
  const seen = new Set<string>();
  return f.optIns.map((o: { address?: unknown; minAmount?: unknown }, i) => {
    if (typeof o?.address !== 'string' || o.address.length === 0) throw new Error(`optIns[${i}].address is missing`);
    if (typeof o.minAmount !== 'string' || !/^[1-9][0-9]{0,19}$/.test(o.minAmount)) {
      throw new Error(`optIns[${i}].minAmount must be a positive whole number as a string`);
    }
    const key = o.address.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`optIns[${i}].address is listed twice`);
    seen.add(key);
    return { address: o.address.trim(), minAmount: BigInt(o.minAmount) };
  });
}

export const readOptIns = (path: string): OptIn[] => parseOptIns(JSON.parse(readFileSync(path, 'utf8')));
