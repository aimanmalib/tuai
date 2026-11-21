/**
 * Pure parts of the third-party wallet driver (scripts/wallet-claim-cashonize.ts, docs/decisions/0016-third-party-wallet.md):
 * its config section, the .env value it keeps the wallet's phrase in, the log filter that keeps the phrase and the
 * WizardConnect pairing link out of every line it prints, and the record of claims the wallet signed.
 */
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin } from '@bitauth/libauth';

/** Networks the third-party wallet driver may run on. */
export type WalletNetwork = 'chipnet' | 'mainnet';
export const WALLET_NETWORKS: readonly WalletNetwork[] = ['chipnet', 'mainnet'];

/** Per-network part of `thirdPartyWallet`: where the driver writes, and how much the project may fund the wallet. */
export interface ThirdPartyWalletNetwork {
  /** Screenshots and the address the wallet showed, for this network (ignored by git). */
  outputDir: string;
  /** Claims the wallet signed on this network: `deployments/<network>/wallet-claims.json`. */
  recordPath: string;
  /** Largest amount the project payer may send the wallet for fees, in satoshis. */
  maxFundSats: number;
}

/** `thirdPartyWallet` in config/tuai.json. */
export interface ThirdPartyWalletConfig {
  name: string;
  version: string;
  /** Source commit of the wallet build the driver was run with. */
  commit: string;
  /** Local port the wallet's static build is served on (127.0.0.1 only). */
  port: number;
  envFile: string;
  mnemonicEnv: string;
  timeoutSeconds: number;
  networks: Record<WalletNetwork, ThirdPartyWalletNetwork>;
}

/** Ports other local tools on the host listen on; the wallet build is never served there. */
export const RESERVED_PORTS: readonly number[] = [4173, 4174, 4175, 4190];
/**
 * Upper bounds for `maxFundSats` that config cannot raise: the wallet only needs fees for a few claims, and on
 * mainnet every funding transaction is also counted against `budget.mainnetMaxSats`.
 */
export const FUND_CEILING_SATS: Readonly<Record<WalletNetwork, number>> = { chipnet: 30_000, mainnet: 10_000 };

export function validateThirdPartyWallet(w: ThirdPartyWalletConfig | undefined): string[] {
  if (!w) return ['thirdPartyWallet is missing'];
  const e: string[] = [];
  if (!Number.isInteger(w.port) || w.port < 1024 || w.port > 65535 || RESERVED_PORTS.includes(w.port))
    e.push(`thirdPartyWallet.port must be 1024..65535 and not one of ${RESERVED_PORTS.join(', ')}`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(w.mnemonicEnv)) e.push('thirdPartyWallet.mnemonicEnv must be an upper-case variable name');
  if (!/^[0-9a-f]{40}$/.test(w.commit)) e.push('thirdPartyWallet.commit must be a 40-hex commit id');
  if (!Number.isInteger(w.timeoutSeconds) || w.timeoutSeconds < 30) e.push('thirdPartyWallet.timeoutSeconds must be >= 30');
  for (const k of ['name', 'version', 'envFile'] as const)
    if (typeof w[k] !== 'string' || w[k] === '') e.push(`thirdPartyWallet.${k} is required`);
  const names = Object.keys(w.networks ?? {});
  if (names.length === 0) e.push('thirdPartyWallet.networks must name at least one network');
  for (const name of names) {
    const at = `thirdPartyWallet.networks.${name}`;
    if (!(WALLET_NETWORKS as readonly string[]).includes(name)) {
      e.push(`${at}: the driver runs on ${WALLET_NETWORKS.join(' or ')} only`);
      continue;
    }
    const n = w.networks[name as WalletNetwork];
    const ceiling = FUND_CEILING_SATS[name as WalletNetwork];
    if (!Number.isInteger(n.maxFundSats) || n.maxFundSats <= 0 || n.maxFundSats > ceiling) e.push(`${at}.maxFundSats must be 1..${ceiling}`);
    if (n.recordPath !== `deployments/${name}/wallet-claims.json`) e.push(`${at}.recordPath must be deployments/${name}/wallet-claims.json`);
    if (typeof n.outputDir !== 'string' || n.outputDir === '') e.push(`${at}.outputDir is required`);
  }
  if (new Set(names.map((n) => w.networks[n as WalletNetwork]?.outputDir)).size !== names.length)
    e.push('thirdPartyWallet.networks: each network needs its own outputDir');
  return e;
}

/** The network a `--network` value names (absent = chipnet) with its settings; refuses one the config does not list. */
export function walletNetwork(w: ThirdPartyWalletConfig, value: string | undefined): ThirdPartyWalletNetwork & { network: WalletNetwork } {
  const network = (value ?? 'chipnet') as WalletNetwork;
  const n = (WALLET_NETWORKS as readonly string[]).includes(network) ? w.networks[network] : undefined;
  if (!n) throw new Error(`--network ${String(value)}: the third-party wallet driver runs on ${Object.keys(w.networks).join(' or ')}`);
  return { ...n, network };
}

/** Refuses a wallet funding amount outside 1..maxFundSats for the network; checked before anything is built. */
export function checkFundAmount(n: ThirdPartyWalletNetwork & { network: WalletNetwork }, sats: bigint): void {
  if (sats <= 0n || sats > BigInt(n.maxFundSats))
    throw new RangeError(`funding the wallet with ${sats} sats on ${n.network} is outside 1..${n.maxFundSats} (thirdPartyWallet.networks.${n.network}.maxFundSats)`);
}

/** Value of `name` in the text of a .env file (KEY=value lines; quotes around the value are removed). */
export function readEnvValue(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m?.[1] !== name) continue;
    const v = (m[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
    return v === '' ? undefined : v;
  }
  return undefined;
}

/** The .env text with `name=value` added; refuses to replace a value that is already there. */
export function withEnvValue(text: string, name: string, value: string): string {
  if (readEnvValue(text, name) !== undefined) throw new Error(`${name} is already set; it is never replaced`);
  if (/[\r\n"]/.test(value)) throw new Error(`${name}: the value has a line break or a quote`);
  const kept = text.split(/\r?\n/).filter((l) => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l)).join('\n');
  const head = kept === '' || kept.endsWith('\n') ? kept : `${kept}\n`;
  return `${head}${name}="${value}"\n`;
}

const PAIRING = /\b(?:wiz|wc|cc):\/\/\S+/gi;

/**
 * A line safe to print: WizardConnect pairing links are cut and every secret is replaced, also when its words are
 * split by other spaces or line breaks. Secrets shorter than 8 characters are ignored (they would match too much).
 */
export function redact(line: string, secrets: readonly string[]): string {
  let out = line.replace(PAIRING, (m) => `${m.slice(0, m.indexOf('://') + 3)}[hidden]`);
  for (const s of secrets) {
    const words = s.trim().split(/\s+/).filter(Boolean);
    if (words.join(' ').length < 8) continue;
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    out = out.replace(new RegExp(pattern, 'gi'), '[hidden]');
  }
  return out;
}

/** One claim the third-party wallet signed on the public page. */
export interface WalletClaim {
  txid: string;
  wallet: string;
  commit: string;
  leafIndex: number;
  address: string;
  /** Block height once mined; null while it was not in a block when recorded. */
  height: number | null;
  at: string;
  /** Size and fee of the claim transaction as read back from the chain; absent until read. */
  bytes?: number;
  feeSats?: number;
}

export interface WalletClaimsRecord {
  network: WalletNetwork;
  claims: WalletClaim[];
}

const ADDRESS_PREFIX: Readonly<Record<WalletNetwork, string>> = { chipnet: 'bchtest', mainnet: 'bitcoincash' };

function claimProblem(c: WalletClaim, network: WalletNetwork): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(c.txid)) return 'txid must be 64 lower-case hex characters';
  if (!new RegExp(`^${ADDRESS_PREFIX[network]}:[02-9ac-hj-np-z]{42}$`).test(c.address)) return `${c.address}: not a ${network} address`;
  if (!Number.isInteger(c.leafIndex) || c.leafIndex < 0) return `${c.txid}: leafIndex must be a whole number >= 0`;
  if (c.height !== null && (!Number.isInteger(c.height) || c.height <= 0)) return `${c.txid}: height must be null or > 0`;
  if (Number.isNaN(Date.parse(c.at)) || new Date(c.at).toISOString() !== c.at) return `${c.txid}: at must be an ISO UTC time`;
  if (!/^[0-9a-f]{40}$/.test(c.commit) || c.wallet === '') return `${c.txid}: wallet and commit are required`;
  for (const k of ['bytes', 'feeSats'] as const)
    if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k] <= 0)) return `${c.txid}: ${k} must be a whole number > 0 when present`;
  return undefined;
}

/**
 * Reads wallet-claims.json text and checks every entry against the network the record names. No file yet
 * (undefined) gives an empty record for `network`; a file for another network than `network` is refused.
 */
export function parseWalletClaims(text: string | undefined, network?: WalletNetwork): WalletClaimsRecord {
  if (text === undefined) return { network: network ?? 'chipnet', claims: [] };
  const r = JSON.parse(text) as WalletClaimsRecord;
  if (!WALLET_NETWORKS.includes(r.network) || !Array.isArray(r.claims))
    throw new Error(`wallet claims record: network must be ${WALLET_NETWORKS.join(' or ')} with a claims list`);
  if (network !== undefined && r.network !== network) throw new Error(`wallet claims record is for ${r.network}, not ${network}`);
  for (const c of r.claims) {
    const p = claimProblem(c, r.network);
    if (p) throw new Error(`wallet claims record: ${p}`);
  }
  return r;
}

const sizeOf = (c: WalletClaim) => (c.bytes === undefined || c.feeSats === undefined ? {} : { bytes: c.bytes, feeSats: c.feeSats });

/** Adds a claim, or fills in the height, size and fee of one already recorded with the same txid. */
export function addWalletClaim(r: WalletClaimsRecord, c: WalletClaim): WalletClaimsRecord {
  const p = claimProblem(c, r.network);
  if (p) throw new Error(p);
  const old = r.claims.find((x) => x.txid === c.txid);
  if (!old) return { ...r, claims: [...r.claims, c] };
  return { ...r, claims: r.claims.map((x) => (x.txid === c.txid ? { ...x, height: c.height ?? x.height, ...sizeOf(c.bytes === undefined ? x : c) } : x)) };
}

/** Size in bytes and fee in satoshis of a mined transaction, from raw transaction hex fetched by txid. */
export async function txSizeAndFee(rawHex: (txid: string) => Promise<string>, txid: string): Promise<{ bytes: number; feeSats: number }> {
  const decode = (hex: string, id: string) => {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === 'string') throw new Error(`${id}: ${tx}`);
    return tx;
  };
  const hex = await rawHex(txid);
  const tx = decode(hex, txid);
  let inSats = 0n;
  for (const i of tx.inputs) {
    const prevId = binToHex(i.outpointTransactionHash);
    const prev = decode(await rawHex(prevId), prevId).outputs[i.outpointIndex];
    if (!prev) throw new Error(`${txid}: input ${prevId}:${i.outpointIndex} not found`);
    inSats += prev.valueSatoshis;
  }
  const outSats = tx.outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  return { bytes: hex.length / 2, feeSats: Number(inSats - outSats) };
}

export function formatWalletClaims(r: WalletClaimsRecord): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

const scriptOf = (address: string): string | undefined => {
  const r = cashAddressToLockingBytecode(address);
  return typeof r === 'string' ? undefined : binToHex(r.bytecode);
};

/**
 * Index of `address` among an epoch's leaves; throws when it is not a leaf. Compared by locking script, so the plain
 * address the wallet shows finds its leaf when the epoch lists the token-aware form of the same key.
 */
export function leafIndexOf(leaves: readonly { address?: string }[], address: string): number {
  const want = scriptOf(address);
  const i = want === undefined ? -1 : leaves.findIndex((l) => l.address !== undefined && scriptOf(l.address) === want);
  if (i < 0) throw new Error(`${address} is not a leaf of the newest epoch`);
  return i;
}

/** First P2PKH address (not a token address) of the network in text the wallet shows. */
export function firstWalletAddress(texts: readonly string[], network: WalletNetwork): string | undefined {
  const pattern = new RegExp(`${ADDRESS_PREFIX[network]}:q[02-9ac-hj-np-z]{41}`);
  for (const t of texts) {
    const m = pattern.exec(t);
    if (m) return m[0];
  }
  return undefined;
}
