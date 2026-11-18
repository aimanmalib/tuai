import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectrumNetworkProvider, MockNetworkProvider, SignatureTemplate, type NetworkProvider } from 'cashscript';
import { binToHex, encodeCashAddress, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { NETWORKS, REPO_ROOT, loadConfig, type NetworkName, type TuaiConfig } from '../config.ts';
import type { CashAddressPrefix } from '../leaf.ts';

export interface ProjectKey {
  role: string;
  signer: SignatureTemplate;
  publicKey: string;
  lockingBytecode: Uint8Array;
  /** Token-aware CashAddr on this network, so the key can receive reward tokens. */
  address: string;
}

/** Everything a command needs; tests inject a shared mock provider, fixed time and temporary folders. */
export interface Context {
  config: TuaiConfig;
  network: NetworkName;
  /**
   * Name of the operating record: `<network>` by default, `<network>-<run>` with `--run <run>`. It names the run log
   * (`state/runs/<name>.json`) and the public folder (`deployments/<name>/`), so a second pool on one network keeps its
   * own record.
   */
  deployment: string;
  prefix: CashAddressPrefix;
  repoRoot: string;
  stateDir: string;
  provider: NetworkProvider;
  now: () => Date;
  fetch?: typeof fetch;
  /**
   * Height at which a transaction confirmed (undefined while unconfirmed). Absent on the mock network, which does
   * not track confirmations; the timelock is then left to the contracts alone.
   */
  confirmedHeight?: (txid: string) => Promise<number | undefined>;
  out: (line: string) => void;
}

export interface ContextOverrides {
  config?: TuaiConfig;
  /** Run name from `--run`; see `Context.deployment`. */
  run?: string;
  repoRoot?: string;
  stateDir?: string;
  provider?: NetworkProvider;
  now?: () => Date;
  fetch?: typeof fetch;
  confirmedHeight?: (txid: string) => Promise<number | undefined>;
  out?: (line: string) => void;
}

export function parseNetwork(value: string | undefined): NetworkName {
  const n = (value ?? 'chipnet') as NetworkName;
  if (!NETWORKS.includes(n)) throw new Error(`unknown network ${value}; use one of ${NETWORKS.join(', ')}`);
  return n;
}

function electrumHeight(provider: ElectrumNetworkProvider): (txid: string) => Promise<number | undefined> {
  return async (txid) => {
    const tx = (await provider.performRequest('blockchain.transaction.get', txid, true)) as { confirmations?: number };
    if (!tx.confirmations) return undefined;
    return (await provider.getBlockHeight()) - tx.confirmations + 1;
  };
}

export function deploymentName(network: NetworkName, run: string | undefined): string {
  if (run === undefined) return network;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(run)) throw new Error(`--run must be 1 to 32 lowercase letters, digits or hyphens: ${run}`);
  return `${network}-${run}`;
}

export function makeContext(network: NetworkName, o: ContextOverrides = {}): Context {
  const config = o.config ?? loadConfig();
  const repoRoot = o.repoRoot ?? REPO_ROOT;
  let provider = o.provider;
  let confirmedHeight = o.confirmedHeight;
  if (!provider) {
    if (network === 'mock') {
      provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    } else {
      const electrum = new ElectrumNetworkProvider(network, { hostname: config.networks[network].electrum?.hostname ?? '' });
      provider = electrum;
      confirmedHeight = o.confirmedHeight ?? electrumHeight(electrum);
    }
  }
  return {
    config,
    network,
    deployment: deploymentName(network, o.run),
    prefix: config.networks[network].addressPrefix,
    repoRoot,
    stateDir: o.stateDir ?? resolve(repoRoot, 'state'),
    provider,
    now: o.now ?? (() => new Date()),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(confirmedHeight ? { confirmedHeight } : {}),
    out: o.out ?? ((line) => process.stdout.write(`${line}\n`)),
  };
}

export function p2pkhBytecode(publicKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(25);
  out.set([0x76, 0xa9, 0x14]);
  out.set(hash160(publicKey), 3);
  out.set([0x88, 0xac], 23);
  return out;
}

/** Loads a project key from `state/keys/<role>.json`. The private key stays inside the signer and is never printed. */
export function loadKey(ctx: Context, roleOrPath: string): ProjectKey {
  const path = roleOrPath.endsWith('.json') ? resolve(roleOrPath) : resolve(ctx.stateDir, 'keys', `${roleOrPath}.json`);
  if (!existsSync(path)) throw new Error(`no key file for ${roleOrPath}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { privateKey?: string; role?: string };
  if (!raw.privateKey || !/^[0-9a-f]{64}$/.test(raw.privateKey)) throw new Error(`key file for ${roleOrPath} has no usable key`);
  const privateKey = hexToBin(raw.privateKey);
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(`key file for ${roleOrPath} is invalid`);
  const lockingBytecode = p2pkhBytecode(publicKey);
  const address = encodeCashAddress({ prefix: ctx.prefix, type: 'p2pkhWithTokens', payload: hash160(publicKey) });
  if (typeof address === 'string') throw new Error(address);
  return { role: raw.role ?? roleOrPath, signer: new SignatureTemplate(privateKey), publicKey: binToHex(publicKey), lockingBytecode, address: address.address };
}

export const payerRole = (network: NetworkName): string => `payer-${network}`;

/** Operator public keys: from config when set, otherwise from the project's three operator key files. */
export function operatorKeys(ctx: Context): string[] {
  const fromConfig = ctx.config.operators.publicKeys;
  if (fromConfig.length > 0) return [...fromConfig];
  return Array.from({ length: ctx.config.operators.total }, (_, i) => loadKey(ctx, `operator-${i + 1}`).publicKey);
}
