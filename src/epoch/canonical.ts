import { binToHex } from '@bitauth/libauth';
import { sha256 } from '../bytes.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): Json => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonical JSON has no form for non-finite numbers');
    if (typeof v === 'bigint') throw new Error('encode bigint values as strings before hashing');
    return v as Json;
  };
  return JSON.stringify(sort(value));
}

export const sha256Hex = (data: Uint8Array | string): string =>
  binToHex(sha256(typeof data === 'string' ? new TextEncoder().encode(data) : data));

/** The inputs hash committed on chain next to the root. */
export const manifestHash = (manifest: unknown): string => sha256Hex(canonicalJson(manifest));
