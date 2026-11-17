import { binToHex } from '@bitauth/libauth';
import { addressToLockingBytecode, type LinkMethod } from '../leaf.ts';
import type { Allocation } from './cumulative.ts';

/** One recipient as returned by the FoldingCash distribution endpoint (only the fields used here). */
export interface DistroUser {
  amount: number;
  cashTokensAddress: string | null;
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

export function distroToAllocations(response: DistroResponse, method: LinkMethod): Allocation[] {
  if (response.success === false) throw new Error('the distribution response reports failure');
  return (response.distro ?? []).map((user) => {
    if (!user.cashTokensAddress) throw new Error('a distribution entry has no CashTokens address');
    return {
      lockingBytecode: binToHex(addressToLockingBytecode(user.cashTokensAddress, 'bitcoincash')),
      method,
      amount: distroAmountToUnits(user.amount),
    };
  });
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
