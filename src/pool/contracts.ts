import { Contract, type NetworkProvider, type Unlocker } from 'cashscript';
import type { Artifact } from '@cashscript/utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hexToBin } from '@bitauth/libauth';
import { REPO_ROOT } from '../config.ts';
import { isHex } from '../bytes.ts';
import { categoryToVm } from './encoding.ts';

const loadArtifact = (name: string): Artifact =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'src/contracts/artifacts', `${name}.json`), 'utf8')) as Artifact;

export const CLAIM_POOL_ARTIFACT = loadArtifact('ClaimPool');
export const POOL_VAULT_ARTIFACT = loadArtifact('PoolVault');

export interface PoolParams {
  /** Pool token category (txid order): state NFT, receipts and, later, the pending-root NFT. */
  poolCategory: string;
  /** Reward token category (txid order). */
  rewardCategory: string;
  maxDepth: number;
}

export interface PoolContracts {
  params: PoolParams;
  pool: Contract;
  vault: Contract;
}

export function poolContracts(params: PoolParams, provider: NetworkProvider): PoolContracts {
  for (const c of [params.poolCategory, params.rewardCategory]) {
    if (!isHex(c, 32)) throw new Error(`token category must be 32 bytes of lowercase hex: ${c}`);
  }
  if (!Number.isInteger(params.maxDepth) || params.maxDepth < 0 || params.maxDepth > 64) throw new RangeError('maxDepth out of range');
  const vault = new Contract(POOL_VAULT_ARTIFACT, [categoryToVm(params.poolCategory)], { provider, contractType: 'p2sh32' });
  const pool = new Contract(
    CLAIM_POOL_ARTIFACT,
    [categoryToVm(params.poolCategory), categoryToVm(params.rewardCategory), hexToBin(vault.lockingBytecode), BigInt(params.maxDepth)],
    { provider, contractType: 'p2sh32' },
  );
  return { params, pool, vault };
}

/** Looks up a contract function's unlocker by name; fails loudly when the artifact has no such function. */
export function unlockerFor(contract: Contract, name: string): (...args: unknown[]) => Unlocker {
  const fn = (contract.unlock as Record<string, ((...args: unknown[]) => Unlocker) | undefined>)[name];
  if (!fn) throw new Error(`contract ${contract.name} has no function ${name}`);
  return fn;
}
