import { binToHex } from '@bitauth/libauth';
import { addressToLockingBytecode, LinkMethod } from '../leaf.ts';
import { LegacyBtcAddressError, legacyBtcToLockingBytecode } from '../leaf-legacy.ts';
import type { Allocation } from './cumulative.ts';

/** One recipient as returned by the FoldingCash distribution endpoint (only the fields used here). */
export interface DistroUser {
  amount: number;
  /** Set for users who linked a CashTokens address. */
  cashTokensAddress?: string | null;
  /** Set for users whose name carries a legacy BTC address (returned when all user types are requested). */
  bitcoinAddress?: string | null;
  pointsGained?: number;
}

export interface DistroResponse {
  success?: boolean;
  distro: DistroUser[] | null;
  distroCount?: number | null;
  startDateTime?: string;
  endDateTime?: string;
  totalDistro?: number;
}

/** A list split elsewhere: addresses (or locking bytecode in hex) with amounts in base units. */
export interface AllocationsFile {
  allocations: Array<{ address?: string; lockingBytecode?: string; amount: string | number; method?: LinkMethod }>;
}

export type InputKind = 'distro' | 'allocations';

/** The distribution endpoint returns amounts with eight decimals; base units follow the sponsor's own script. */
export const DISTRO_DECIMALS = 8;
export const distroAmountToUnits = (amount: number): bigint => {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`bad distribution amount: ${amount}`);
  return BigInt(Math.round(amount * 10 ** DISTRO_DECIMALS));
};

export function inputKind(json: unknown): InputKind {
  if (json && typeof json === 'object' && Array.isArray((json as AllocationsFile).allocations)) return 'allocations';
  if (json && typeof json === 'object' && 'distro' in json) return 'distro';
  throw new Error('input is neither a distribution response nor an allocations file');
}

/** One refused distribution entry: its position in the response and why. */
export interface RejectedEntry {
  index: number;
  address: string | null;
  reason: string;
}

/** Thrown when any entry cannot become a leaf. Lists every refused entry instead of stopping at the first. */
export class DistroEntriesError extends Error {
  constructor(readonly rejected: RejectedEntry[]) {
    super(`${rejected.length} distribution entr${rejected.length === 1 ? 'y' : 'ies'} refused: ` +
      rejected.map((r) => `#${r.index} ${r.address ?? '(no address)'} ${r.reason}`).join('; '));
    this.name = 'DistroEntriesError';
  }
}

/**
 * A CashTokens address gets `method` (link method 0 by default). A legacy BTC address gets method 2 and the
 * P2PKH script with the same hash160. An entry with neither, or with an address that is not P2PKH, is refused.
 */
export function distroToAllocations(response: DistroResponse, method: LinkMethod): Allocation[] {
  if (response.success === false) throw new Error('the distribution response reports failure');
  const rejected: RejectedEntry[] = [];
  const out: Allocation[] = [];
  (response.distro ?? []).forEach((user, index) => {
    try {
      out.push({ ...entryScript(user, method), amount: distroAmountToUnits(user.amount) });
    } catch (e) {
      const address = user.cashTokensAddress ?? user.bitcoinAddress ?? null;
      rejected.push({ index, address, reason: e instanceof LegacyBtcAddressError ? e.reason : (e as Error).message });
    }
  });
  if (rejected.length > 0) throw new DistroEntriesError(rejected);
  return out;
}

function entryScript(user: DistroUser, method: LinkMethod): { lockingBytecode: string; method: LinkMethod } {
  if (user.cashTokensAddress) {
    return { lockingBytecode: binToHex(addressToLockingBytecode(user.cashTokensAddress, 'bitcoincash')), method };
  }
  if (user.bitcoinAddress) {
    return { lockingBytecode: legacyBtcToLockingBytecode(user.bitcoinAddress), method: LinkMethod.legacyBtcName };
  }
  throw new Error('no CashTokens or legacy BTC address');
}

export function allocationsFileToAllocations(file: AllocationsFile, method: LinkMethod): Allocation[] {
  return file.allocations.map((a) => {
    const lockingBytecode = a.lockingBytecode ?? (a.address ? binToHex(addressToLockingBytecode(a.address)) : undefined);
    if (!lockingBytecode) throw new Error('an allocation has neither an address nor locking bytecode');
    const amount = BigInt(a.amount);
    return { lockingBytecode, method: a.method ?? method, amount };
  });
}

export function toAllocations(json: unknown, method: LinkMethod): Allocation[] {
  return inputKind(json) === 'distro'
    ? distroToAllocations(json as DistroResponse, method)
    : allocationsFileToAllocations(json as AllocationsFile, method);
}
