import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type NetworkName = 'mock' | 'chipnet' | 'mainnet';
export const NETWORKS: readonly NetworkName[] = ['mock', 'chipnet', 'mainnet'];

export interface NetworkConfig {
  addressPrefix: 'bitcoincash' | 'bchtest' | 'bchreg';
  activationDelayBlocks: number;
  electrum?: { hostname: string };
  rewardCategory?: string;
}

export interface TuaiConfig {
  project: { name: string; subtitle: string; repoUrl: string; siteUrl: string };
  networks: Record<NetworkName, NetworkConfig>;
  production: { activationDelayBlocks: number };
  tree: { maxDepth: number };
  operators: { threshold: number; total: number; publicKeys: string[] };
  fees: { satsPerByte: number; tokenOutputDustSats: number; receiptDustSats: number };
  sponsorApi: {
    baseUrl: string;
    distroPath: string;
    includeFoldingUserTypes: number;
    minIntervalSeconds: number;
    timeoutSeconds: number;
    cacheDir: string;
  };
  budget: { mainnetMaxSats: number; ledgerPath: string };
  banner: { event: string; bounty: string; prizeAddress: string };
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, 'config/tuai.json');

const isPositiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/** Returns a list of problems; an empty list means the config is usable. */
export function validateConfig(c: TuaiConfig): string[] {
  const problems: string[] = [];
  for (const name of NETWORKS) {
    const n = c.networks?.[name];
    if (!n) {
      problems.push(`networks.${name} is missing`);
      continue;
    }
    if (!['bitcoincash', 'bchtest', 'bchreg'].includes(n.addressPrefix)) {
      problems.push(`networks.${name}.addressPrefix is not a CashAddr prefix`);
    }
    if (!isPositiveInt(n.activationDelayBlocks) || n.activationDelayBlocks > 0xffff) {
      problems.push(`networks.${name}.activationDelayBlocks must be 1..65535 blocks`);
    }
    if (n.rewardCategory && !/^[0-9a-f]{64}$/.test(n.rewardCategory)) {
      problems.push(`networks.${name}.rewardCategory must be 32 bytes of hex`);
    }
  }
  if (!isPositiveInt(c.production?.activationDelayBlocks)) problems.push('production.activationDelayBlocks must be > 0');
  if (!isPositiveInt(c.tree?.maxDepth) || c.tree.maxDepth > 32) problems.push('tree.maxDepth must be 1..32');
  const o = c.operators;
  if (!o || !isPositiveInt(o.threshold) || !isPositiveInt(o.total) || o.threshold > o.total) {
    problems.push('operators.threshold must be 1..operators.total');
  } else if (o.publicKeys.length !== 0 && o.publicKeys.length !== o.total) {
    problems.push('operators.publicKeys must be empty or have operators.total entries');
  } else if (o.publicKeys.some((k) => !/^0[23][0-9a-f]{64}$/.test(k))) {
    problems.push('operators.publicKeys must be compressed public keys in hex');
  }
  if (!isPositiveInt(c.fees?.satsPerByte)) problems.push('fees.satsPerByte must be > 0');
  if (!isPositiveInt(c.fees?.tokenOutputDustSats) || !isPositiveInt(c.fees?.receiptDustSats)) {
    problems.push('fees dust values must be > 0');
  }
  const api = c.sponsorApi;
  if (!api || !/^https:\/\//.test(api.baseUrl)) problems.push('sponsorApi.baseUrl must be https');
  if (api && (!isPositiveInt(api.minIntervalSeconds) || api.minIntervalSeconds < 60)) {
    problems.push('sponsorApi.minIntervalSeconds must be at least 60');
  }
  if (api && !isPositiveInt(api.timeoutSeconds)) problems.push('sponsorApi.timeoutSeconds must be > 0');
  if (!isPositiveInt(c.budget?.mainnetMaxSats)) problems.push('budget.mainnetMaxSats must be > 0');
  if (!c.banner?.prizeAddress?.startsWith('bitcoincash:')) problems.push('banner.prizeAddress must be a mainnet address');
  return problems;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): TuaiConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as TuaiConfig;
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`Invalid config at ${path}: ${problems.join('; ')}`);
  return config;
}
