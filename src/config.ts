import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateRelay, type RelayConfig } from './relay/config.ts';
import { MAX_SHARDS } from './pool/shards.ts';
import { explorerProblems, type Explorer } from './explorers.ts';
import { validateThirdPartyWallet, type ThirdPartyWalletConfig } from './wallet-driver.ts';

export type NetworkName = 'mock' | 'chipnet' | 'mainnet';
export const NETWORKS: readonly NetworkName[] = ['mock', 'chipnet', 'mainnet'];

export interface NetworkConfig {
  addressPrefix: 'bitcoincash' | 'bchtest' | 'bchreg';
  activationDelayBlocks: number;
  /** Blocks the active root must stand before pushes can be armed (ADR 0008). */
  pushDelayBlocks: number;
  /** `hostname` for the CLI (TCP/TLS through CashScript); `wssUrl` for the claim page in a browser. */
  electrum?: { hostname: string; wssUrl?: string };
  rewardCategory?: string;
  /** Older single explorer, read when `explorers` is absent (src/explorers.ts). */
  explorerTxUrl?: string;
  /** Block explorers, primary first; the txid is appended to each `txUrl`. */
  explorers?: Explorer[];
  /**
   * Blocks the network's nodes require per unit of a block-count sequence lock (measured 10 on chipnet with
   * one-minute blocks, so a lock keeps its ten-minute meaning). Absent: 1.
   */
  sequenceBlockScale?: number;
}

export interface TuaiConfig {
  project: { name: string; subtitle: string; repoUrl: string; siteUrl: string };
  networks: Record<NetworkName, NetworkConfig>;
  production: { activationDelayBlocks: number; pushDelayBlocks: number };
  tree: { maxDepth: number };
  /** State NFT copies and reward token UTXOs a new pool is deployed with (ADR 0013); 1 = no sharding. */
  pool: { shards: number };
  operators: { threshold: number; total: number; publicKeys: string[] };
  fees: { satsPerByte: number; tokenOutputDustSats: number; receiptDustSats: number };
  /** Operator push (ADR 0008): smallest push payment in reward base units (decimal string) and vault BCH per push. */
  push: { minimumUnits: string; maxSatsPerPush: number };
  sponsorApi: {
    baseUrl: string;
    distroPath: string;
    includeFoldingUserTypes: number;
    minIntervalSeconds: number;
    timeoutSeconds: number;
    cacheDir: string;
    /** Link method given to leaves built from the API (0: address in the Folding@home name). */
    linkMethod: 0 | 1;
    /**
     * Demonstration epoch from real sponsor data (ADR 0015): all user types and one request per window. The
     * production query above (`includeFoldingUserTypes`) is not changed by it.
     */
    realEpoch: { includeFoldingUserTypes: number; amount: number; windows: Array<{ startDate: string; endDate: string }> };
  };
  rewards: { decimals: number };
  budget: { mainnetMaxSats: number; ledgerPath: string };
  /** The entry banner. `deckUrl` is the site path the slides (docs/deck.pdf) are served at; `note` shows the new-project line. */
  banner: { event: string; bounty: string; prizeAddress: string; deckUrl: string; repoUrl: string; firstCommit: string; note: boolean };
  cost: CostConfig;
  demo: DemoConfig;
  web: WebConfig;
  watch: WatchConfig;
  /** Signed compatibility links (docs/SPEC.md section 8): the domain every link message names. */
  link: { domain: string };
  /** Chipnet demo relayer (docs/decisions/0009-chipnet-relayer.md). */
  relay: RelayConfig;
  /** Driver for a claim signed by a third-party wallet on chipnet (docs/decisions/0016-third-party-wallet.md). */
  thirdPartyWallet: ThirdPartyWalletConfig;
}

/** Watcher report: the deployment it checks on chain, the public Folding@home summary, and where results go. */
export interface WatchConfig {
  network: NetworkName;
  deploymentDir: string;
  fahSummaryUrl: string;
  downloadTimeoutSeconds: number;
  /** Untracked: the downloaded summary and its hash record. */
  fahDir: string;
  /** Untracked: raw transactions, the replay epoch and per-leaf link results. */
  stateDir: string;
  /** Tracked: aggregates only, no addresses or names. */
  reportPath: string;
}

/** Claim page: which deployments it shows and where it reads chain state from. */
export interface WebConfig {
  networks: NetworkName[];
  defaultNetwork: NetworkName;
  electrumTimeoutSeconds: number;
  /** Transactions the activity page asks Electrum about at the same time when it checks each one on chain. */
  chainCheckConcurrency: number;
  /** Seconds between reads of the live numbers strip on the Home view (5 to 60). */
  statsRefreshSeconds: number;
  /** Seconds between reads of a connected wallet's balance chip (3 to 60). */
  walletBalanceRefreshSeconds: number;
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
  /** Leaf amount for an outside wallet's own address (a third-party wallet claim on chipnet), in whole tokens. */
  walletLeafWhole: number;
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
    if (!isPositiveInt(n.pushDelayBlocks) || n.pushDelayBlocks > 0xffff) {
      problems.push(`networks.${name}.pushDelayBlocks must be 1..65535 blocks`);
    }
    if (n.sequenceBlockScale !== undefined && !isPositiveInt(n.sequenceBlockScale)) {
      problems.push(`networks.${name}.sequenceBlockScale must be > 0`);
    }
    problems.push(...explorerProblems(name, n));
    if (n.rewardCategory && !/^[0-9a-f]{64}$/.test(n.rewardCategory)) {
      problems.push(`networks.${name}.rewardCategory must be 32 bytes of hex`);
    }
  }
  if (!isPositiveInt(c.pool?.shards) || c.pool.shards > MAX_SHARDS) problems.push(`pool.shards must be 1..${MAX_SHARDS}`);
  if (!isPositiveInt(c.production?.activationDelayBlocks)) problems.push('production.activationDelayBlocks must be > 0');
  if (!isPositiveInt(c.production?.pushDelayBlocks) || c.production.pushDelayBlocks > 0xffff) {
    problems.push('production.pushDelayBlocks must be 1..65535 blocks');
  }
  if (!/^[1-9]\d*$/.test(c.push?.minimumUnits ?? '')) problems.push('push.minimumUnits must be a positive integer string');
  if (!isPositiveInt(c.push?.maxSatsPerPush)) problems.push('push.maxSatsPerPush must be > 0');
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
  if (api) problems.push(...validateRealEpoch(api.realEpoch));
  if (!isPositiveInt(c.budget?.mainnetMaxSats)) problems.push('budget.mainnetMaxSats must be > 0');
  problems.push(...validateBanner(c));
  problems.push(...validateCost(c.cost));
  problems.push(...validateDemo(c.demo));
  problems.push(...validateWeb(c));
  if (typeof c.link?.domain !== 'string' || !/^[a-z0-9.-]{1,100}$/.test(c.link.domain)) {
    problems.push('link.domain must be a lowercase host name');
  }
  problems.push(...validateRelay(c.relay));
  problems.push(...validateThirdPartyWallet(c.thirdPartyWallet));
  return problems;
}

function validateRealEpoch(r: TuaiConfig['sponsorApi']['realEpoch'] | undefined): string[] {
  if (!r) return ['sponsorApi.realEpoch is required'];
  const problems: string[] = [];
  if (!isPositiveInt(r.includeFoldingUserTypes)) problems.push('sponsorApi.realEpoch.includeFoldingUserTypes must be > 0');
  if (!(typeof r.amount === 'number' && r.amount > 0)) problems.push('sponsorApi.realEpoch.amount must be > 0');
  const windows = Array.isArray(r.windows) ? r.windows : [];
  if (windows.length === 0) problems.push('sponsorApi.realEpoch.windows must list at least one window');
  for (const w of windows) {
    const start = Date.parse(w?.startDate ?? '');
    const end = Date.parse(w?.endDate ?? '');
    if (!(start < end)) problems.push(`sponsorApi.realEpoch window ${w?.startDate} to ${w?.endDate} must be two dates in order`);
  }
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
  if (!isPositiveInt(w.chainCheckConcurrency) || w.chainCheckConcurrency > 16) out.push('web.chainCheckConcurrency must be 1..16');
  if (!isPositiveInt(w.statsRefreshSeconds) || w.statsRefreshSeconds < 5 || w.statsRefreshSeconds > 60) out.push('web.statsRefreshSeconds must be 5..60');
  const wb = w.walletBalanceRefreshSeconds;
  if (!isPositiveInt(wb) || wb < 3 || wb > 60) out.push('web.walletBalanceRefreshSeconds must be 3..60');
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
  for (const k of ['keyAmountWhole', 'syntheticMaxWhole', 'topUpWhole', 'tokenSupplyWhole', 'otherPayerFundingSats', 'walletLeafWhole'] as const) {
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

function validateBanner(c: TuaiConfig): string[] {
  const b = c.banner;
  const problems: string[] = [];
  if (!b?.prizeAddress?.startsWith('bitcoincash:')) problems.push('banner.prizeAddress must be a mainnet address');
  if (typeof b?.deckUrl !== 'string' || !/^\/[a-z0-9/._-]+\.pdf$/.test(b.deckUrl) || b.deckUrl.includes('..')) {
    problems.push('banner.deckUrl must be a site path ending in .pdf');
  }
  if (b?.repoUrl !== c.project?.repoUrl) problems.push('banner.repoUrl must equal project.repoUrl');
  if (typeof b?.firstCommit !== 'string' || !/^[0-9a-f]{40}$/.test(b.firstCommit)) problems.push('banner.firstCommit must be a full commit id');
  if (typeof b?.note !== 'boolean') problems.push('banner.note must be true or false');
  return problems;
}
