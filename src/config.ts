import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type NetworkName = 'mock' | 'chipnet' | 'mainnet';
export const NETWORKS: readonly NetworkName[] = ['mock', 'chipnet', 'mainnet'];

export interface NetworkConfig {
  addressPrefix: 'bitcoincash' | 'bchtest' | 'bchreg';
  activationDelayBlocks: number;
  /** `hostname` for the CLI (TCP/TLS through CashScript); `wssUrl` for the claim page in a browser. */
  electrum?: { hostname: string; wssUrl?: string };
  rewardCategory?: string;
  /** Block explorer page for a transaction; the txid is appended. */
  explorerTxUrl?: string;
  /**
   * Blocks the network's nodes require per unit of a block-count sequence lock (measured 10 on chipnet with
   * one-minute blocks, so a lock keeps its ten-minute meaning). Absent: 1.
   */
  sequenceBlockScale?: number;
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
    /** Link method given to leaves built from the API (0: address in the Folding@home name). */
    linkMethod: 0 | 1;
  };
  rewards: { decimals: number };
  budget: { mainnetMaxSats: number; ledgerPath: string };
  banner: { event: string; bounty: string; prizeAddress: string };
  cost: CostConfig;
  demo: DemoConfig;
  web: WebConfig;
}

/** Claim page: which deployments it shows and where it reads chain state from. */
export interface WebConfig {
  networks: NetworkName[];
  defaultNetwork: NetworkName;
  electrumTimeoutSeconds: number;
  /** URL path the epoch files are served under: `<epochsPath>/<network>/epoch-<n>.json`. */
  epochsPath: string;
  /** Repository folder the served files are copied from. */
  deploymentsDir: string;
  defaultLocale: 'en' | 'ms';
  localeStorageKey: string;
}

/** The public demonstration tree (chipnet): demo key positions, amounts in whole tokens, and its funding. */
export interface DemoConfig {
  /** Mixed into synthetic leaf hashes; change it to lay out a fresh demonstration. */
  label: string;
  leafCount: number;
  /** Leaf index of each project demo key (demo-1 .. demo-N). */
  keyIndices: number[];
  keyAmountWhole: number;
  syntheticMaxWhole: number;
  /** Added to every demo key in the second epoch, for top-up claims. */
  topUpWhole: number;
  tokenSupplyWhole: number;
  /** BCH sent to a second project key so it can pay for someone else's claim. */
  otherPayerFundingSats: number;
}

/** Inputs of the push-versus-pull cost comparison (docs/COST.md). */
export interface CostConfig {
  /** Recipient counts compared per epoch. */
  recipientCounts: number[];
  epochsPerYear: number;
  /** Standard relay limit on one transaction; larger push distributions are split. */
  maxStandardTxBytes: number;
  /** Fungible amount per push output in base units, as a decimal string (sets the output's amount encoding). */
  pushTokenAmountPerRecipient: string;
  /** Token category of the sponsor's live push distributions. */
  sponsorCategory: string;
  indexerGraphqlUrl: string;
  priceUrl: string;
  reportPath: string;
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
    if (n.sequenceBlockScale !== undefined && !isPositiveInt(n.sequenceBlockScale)) {
      problems.push(`networks.${name}.sequenceBlockScale must be > 0`);
    }
    if (n.explorerTxUrl !== undefined && !/^https:\/\/.+\/$/.test(n.explorerTxUrl)) {
      problems.push(`networks.${name}.explorerTxUrl must be an https URL ending in /`);
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
  if (api && api.linkMethod !== 0 && api.linkMethod !== 1) problems.push('sponsorApi.linkMethod must be 0 or 1');
  if (!Number.isInteger(c.rewards?.decimals) || c.rewards.decimals < 0 || c.rewards.decimals > 18) {
    problems.push('rewards.decimals must be 0..18');
  }
  if (api && !isPositiveInt(api.timeoutSeconds)) problems.push('sponsorApi.timeoutSeconds must be > 0');
  if (!isPositiveInt(c.budget?.mainnetMaxSats)) problems.push('budget.mainnetMaxSats must be > 0');
  if (!c.banner?.prizeAddress?.startsWith('bitcoincash:')) problems.push('banner.prizeAddress must be a mainnet address');
  problems.push(...validateCost(c.cost));
  problems.push(...validateDemo(c.demo));
  problems.push(...validateWeb(c));
  return problems;
}

function validateWeb(c: TuaiConfig): string[] {
  const w = c.web;
  if (!w) return ['web is missing'];
  const out: string[] = [];
  if (!Array.isArray(w.networks) || w.networks.length === 0 || !w.networks.includes(w.defaultNetwork)) {
    out.push('web.networks must list web.defaultNetwork');
  }
  for (const n of w.networks ?? []) {
    if (!/^wss:\/\//.test(c.networks?.[n]?.electrum?.wssUrl ?? '')) out.push(`networks.${n}.electrum.wssUrl must be a wss URL`);
  }
  if (!isPositiveInt(w.electrumTimeoutSeconds)) out.push('web.electrumTimeoutSeconds must be > 0');
  if (!/^\/[a-z0-9-]+$/.test(w.epochsPath ?? '')) out.push('web.epochsPath must be one absolute path segment');
  if (w.defaultLocale !== 'en' && w.defaultLocale !== 'ms') out.push('web.defaultLocale must be en or ms');
  return out;
}

function validateCost(k: CostConfig | undefined): string[] {
  if (!k) return ['cost is missing'];
  const problems: string[] = [];
  if (!Array.isArray(k.recipientCounts) || k.recipientCounts.length === 0 || !k.recipientCounts.every(isPositiveInt)) {
    problems.push('cost.recipientCounts must be positive integers');
  }
  if (!isPositiveInt(k.epochsPerYear)) problems.push('cost.epochsPerYear must be > 0');
  if (!isPositiveInt(k.maxStandardTxBytes)) problems.push('cost.maxStandardTxBytes must be > 0');
  if (!/^[1-9][0-9]*$/.test(k.pushTokenAmountPerRecipient ?? '')) problems.push('cost.pushTokenAmountPerRecipient must be a positive integer string');
  if (!/^[0-9a-f]{64}$/.test(k.sponsorCategory ?? '')) problems.push('cost.sponsorCategory must be 32 bytes of hex');
  if (!/^https:\/\//.test(k.indexerGraphqlUrl ?? '') || !/^https:\/\//.test(k.priceUrl ?? '')) {
    problems.push('cost URLs must be https');
  }
  return problems;
}

function validateDemo(d: DemoConfig | undefined): string[] {
  if (!d) return ['demo is missing'];
  const problems: string[] = [];
  if (!d.label) problems.push('demo.label must be set');
  if (!isPositiveInt(d.leafCount)) problems.push('demo.leafCount must be > 0');
  if (!Array.isArray(d.keyIndices) || d.keyIndices.some((i) => !Number.isInteger(i) || i < 0 || i >= d.leafCount)) {
    problems.push('demo.keyIndices must be leaf indices below demo.leafCount');
  }
  for (const k of ['keyAmountWhole', 'syntheticMaxWhole', 'topUpWhole', 'tokenSupplyWhole', 'otherPayerFundingSats'] as const) {
    if (!isPositiveInt(d[k])) problems.push(`demo.${k} must be > 0`);
  }
  return problems;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): TuaiConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as TuaiConfig;
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`Invalid config at ${path}: ${problems.join('; ')}`);
  return config;
}
