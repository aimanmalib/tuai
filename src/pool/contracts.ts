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
export const ROOT_GATE_ARTIFACT = loadArtifact('RootGate');

/** The gate contract is fixed at 2 of 3 operator keys. */
export const OPERATOR_KEYS = 3;
/** Largest relative timelock in blocks that a BIP68 sequence number can express. */
export const MAX_DELAY_BLOCKS = 0xffff;

export interface PoolParams {
  /** Pool token category (txid order): state NFT, receipts and, later, the pending-root NFT. */
  poolCategory: string;
  /** Reward token category (txid order). */
  rewardCategory: string;
  maxDepth: number;
  /** The three operator public keys (33-byte compressed, hex), in the order the gate checks signatures. */
  operatorKeys: readonly string[];
  /** Blocks a proposed root waits before anyone may activate it. */
  activationDelay: number;
}

export interface PoolContracts {
  params: PoolParams;
  pool: Contract;
  vault: Contract;
  gate: Contract;
}

export function poolContracts(params: PoolParams, provider: NetworkProvider): PoolContracts {
  for (const c of [params.poolCategory, params.rewardCategory]) {
    if (!isHex(c, 32)) throw new Error(`token category must be 32 bytes of lowercase hex: ${c}`);
  }
  if (!Number.isInteger(params.maxDepth) || params.maxDepth < 0 || params.maxDepth > 64) throw new RangeError('maxDepth out of range');
  if (params.operatorKeys.length !== OPERATOR_KEYS || params.operatorKeys.some((k) => !isHex(k, 33) || !/^0[23]/.test(k))) {
    throw new Error(`the root gate needs ${OPERATOR_KEYS} compressed operator public keys`);
  }
  if (!Number.isInteger(params.activationDelay) || params.activationDelay < 1 || params.activationDelay > MAX_DELAY_BLOCKS) {
    throw new RangeError(`activationDelay must be 1..${MAX_DELAY_BLOCKS} blocks`);
  }
  const options = { provider, contractType: 'p2sh32' as const };
  const category = categoryToVm(params.poolCategory);
  const vault = new Contract(POOL_VAULT_ARTIFACT, [category], options);
  const gate = new Contract(
    ROOT_GATE_ARTIFACT,
    [...params.operatorKeys.map((k) => hexToBin(k)), BigInt(params.activationDelay), category],
    options,
  );
  const pool = new Contract(
    CLAIM_POOL_ARTIFACT,
    [category, categoryToVm(params.rewardCategory), hexToBin(vault.lockingBytecode), BigInt(params.maxDepth)],
    options,
  );
  return { params, pool, vault, gate };
}

/** Looks up a contract function's unlocker by name; fails loudly when the artifact has no such function. */
export function unlockerFor(contract: Contract, name: string): (...args: unknown[]) => Unlocker {
  const fn = (contract.unlock as Record<string, ((...args: unknown[]) => Unlocker) | undefined>)[name];
  if (!fn) throw new Error(`contract ${contract.name} has no function ${name}`);
  return fn;
}
