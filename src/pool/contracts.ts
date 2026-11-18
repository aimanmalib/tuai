import { Contract, type NetworkProvider, type Unlocker } from 'cashscript';
import type { Artifact } from '@cashscript/utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hexToBin } from '@bitauth/libauth';
import { REPO_ROOT } from '../config.ts';
import { isHex } from '../bytes.ts';
import { categoryToVm } from './encoding.ts';

const loadArtifact = (name: string, dir = ''): Artifact =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, 'src/contracts/artifacts', dir, `${name}.json`), 'utf8')) as Artifact;

/** Current contracts (contracts/*.cash), with the operator push path (docs/decisions/0008-operator-push.md). */
export const CLAIM_POOL_ARTIFACT = loadArtifact('ClaimPool');
export const POOL_VAULT_ARTIFACT = loadArtifact('PoolVault');
export const ROOT_GATE_ARTIFACT = loadArtifact('RootGate');

/**
 * Version 1, without the push path: the contracts of pools deployed before ADR 0008, such as the recorded chipnet
 * pool. A pool record without push parameters uses these, so its addresses and transactions stay verifiable.
 */
export const V1_ARTIFACTS = {
  pool: loadArtifact('ClaimPool', 'v1'),
  vault: loadArtifact('PoolVault', 'v1'),
  gate: loadArtifact('RootGate', 'v1'),
} as const;

/** The gate contract is fixed at 2 of 3 operator keys. */
export const OPERATOR_KEYS = 3;
/** Largest relative timelock in blocks that a BIP68 sequence number can express. */
export const MAX_DELAY_BLOCKS = 0xffff;

/** Operator push path (ADR 0008). JSON-safe: pool records store it as is. */
export interface PushParams {
  /** Blocks the active root must stand, with no newer proposal, before anyone may arm pushes. */
  delay: number;
  /** Smallest payment a push may make, in reward token base units (decimal string). */
  minimum: string;
  /** Most satoshis one push may take from the vault's BCH for the payment dust, a new receipt's dust and the fee. */
  sats: number;
}

/** Push parameters for new pools on a network, from config/tuai.json. */
export const pushParamsFromConfig = (
  config: { push: { minimumUnits: string; maxSatsPerPush: number } },
  pushDelayBlocks: number,
): PushParams => ({ delay: pushDelayBlocks, minimum: config.push.minimumUnits, sats: config.push.maxSatsPerPush });

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
  /** Absent for version 1 pools (no push path). */
  push?: PushParams;
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
  const push = params.push;
  if (push) checkPush(push);
  const options = { provider, contractType: 'p2sh32' as const };
  const category = categoryToVm(params.poolCategory);
  const vault = new Contract(push ? POOL_VAULT_ARTIFACT : V1_ARTIFACTS.vault, [category], options);
  const keys = params.operatorKeys.map((k) => hexToBin(k));
  const delay = BigInt(params.activationDelay);
  const gate = push
    ? new Contract(ROOT_GATE_ARTIFACT, [...keys, delay, BigInt(push.delay), category], options)
    : new Contract(V1_ARTIFACTS.gate, [...keys, delay, category], options);
  const poolArgs = [category, categoryToVm(params.rewardCategory), hexToBin(vault.lockingBytecode), BigInt(params.maxDepth)];
  const pool = push
    ? new Contract(CLAIM_POOL_ARTIFACT, [...poolArgs, BigInt(push.minimum), BigInt(push.sats)], options)
    : new Contract(V1_ARTIFACTS.pool, poolArgs, options);
  return { params, pool, vault, gate };
}

function checkPush(push: PushParams): void {
  if (!Number.isInteger(push.delay) || push.delay < 1 || push.delay > MAX_DELAY_BLOCKS) {
    throw new RangeError(`push delay must be 1..${MAX_DELAY_BLOCKS} blocks`);
  }
  if (!/^[1-9]\d*$/.test(push.minimum)) throw new RangeError('push minimum must be a positive integer string');
  if (!Number.isSafeInteger(push.sats) || push.sats < 0) throw new RangeError('push satoshis must be a non-negative integer');
}

/** Looks up a contract function's unlocker by name; fails loudly when the artifact has no such function. */
export function unlockerFor(contract: Contract, name: string): (...args: unknown[]) => Unlocker {
  const fn = (contract.unlock as Record<string, ((...args: unknown[]) => Unlocker) | undefined>)[name];
  if (!fn) throw new Error(`contract ${contract.name} has no function ${name}`);
  return fn;
}
