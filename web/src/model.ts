// Claim page logic without the DOM: address lookup, proof check, chain comparison, amounts. Unit tested in node.
import { binToHex, binsAreEqual, cashAddressToLockingBytecode, decodeCashAddress, hexToBin } from '@bitauth/libauth';
import { hashLeaf, type CashAddressPrefix } from '../../src/leaf.ts';
import { hashNode } from '../../src/merkle/tree.ts';
import { decodeReceipt, decodeState, receiptKey, type PoolState, type Receipt } from '../../src/pool/encoding.ts';
import { blocksUntilActivation } from '../../src/gate/maturity.ts';

/** The parts of a published epoch file the page reads (format tuai-epoch/1). */
export interface EpochLeaf {
  index: number;
  address: string | null;
  method: number;
  cumulative: string;
  lockingBytecode: string;
  proof: string[];
}
export interface EpochFileView {
  network: string;
  epoch: number;
  root: string;
  inputsHash: string;
  depth: number;
  leaves: EpochLeaf[];
}

/** Published deployment record (deployments/<network>/pool.json). */
export interface PoolRecord {
  network: string;
  poolCategory: string;
  rewardCategory: string;
  activationDelay: number;
  maxDepth: number;
  deployTxid: string;
  contracts: { pool: string; vault: string; gate: string };
}

/** An Electrum `listunspent` entry with `include_tokens`. */
export interface ElectrumUtxo {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
  token_data?: { category: string; amount: string; nft?: { capability: string; commitment: string } };
}

export interface ChainView {
  tip: number;
  active: PoolState;
  pending: { state: PoolState; height: number } | undefined;
  receipts: Receipt[];
}

export type AddressResult =
  | { ok: true; lockingBytecode: Uint8Array; prefix: string }
  | { ok: false; reason: 'invalid' | 'wrongNetwork'; prefix?: string };

/** Accepts a CashAddr with or without its prefix, token-aware (z) or not (q); both pay the same locking bytecode. */
export function parseAddress(input: string, networkPrefix: CashAddressPrefix): AddressResult {
  const raw = input.trim().toLowerCase();
  if (raw === '') return { ok: false, reason: 'invalid' };
  const full = raw.includes(':') ? raw : `${networkPrefix}:${raw}`;
  const decoded = decodeCashAddress(full);
  if (typeof decoded === 'string') return { ok: false, reason: 'invalid' };
  if (decoded.prefix !== networkPrefix) return { ok: false, reason: 'wrongNetwork', prefix: decoded.prefix };
  const locking = cashAddressToLockingBytecode(full);
  if (typeof locking === 'string') return { ok: false, reason: 'invalid' };
  return { ok: true, lockingBytecode: locking.bytecode, prefix: decoded.prefix };
}

export const findLeaf = (file: EpochFileView, lockingBytecode: Uint8Array): EpochLeaf | undefined => {
  const hex = binToHex(lockingBytecode);
  return file.leaves.find((l) => l.lockingBytecode === hex);
};

export interface ProofStep {
  level: number;
  sibling: string;
  /** Which side the running hash sits on at this level. */
  side: 'left' | 'right';
  result: string;
}

/** Recomputes the root from a leaf and its proof, step by step, in the browser. */
export function proofPath(leaf: EpochLeaf, maxDepth: number): { leafHash: string; steps: ProofStep[]; root: string } | undefined {
  if (leaf.proof.length > maxDepth || !Number.isSafeInteger(leaf.index) || leaf.index < 0 || leaf.index >= 2 ** leaf.proof.length) {
    return undefined;
  }
  let hash: Uint8Array;
  try {
    hash = hashLeaf({ method: leaf.method as 0 | 1, cumulative: BigInt(leaf.cumulative), lockingBytecode: hexToBin(leaf.lockingBytecode) });
  } catch {
    return undefined;
  }
  const leafHash = binToHex(hash);
  const steps: ProofStep[] = [];
  let position = leaf.index;
  for (const [level, siblingHex] of leaf.proof.entries()) {
    if (!/^[0-9a-f]{64}$/.test(siblingHex)) return undefined;
    const sibling = hexToBin(siblingHex);
    const side = position % 2 === 1 ? 'right' : 'left';
    hash = side === 'right' ? hashNode(sibling, hash) : hashNode(hash, sibling);
    steps.push({ level, sibling: siblingHex, side, result: binToHex(hash) });
    position = Math.floor(position / 2);
  }
  return { leafHash, steps, root: binToHex(hash) };
}

/** Builds the chain view from the pool, gate and vault UTXOs of one deployment. */
export function chainViewFrom(
  record: PoolRecord,
  tip: number,
  poolUtxos: readonly ElectrumUtxo[],
  gateUtxos: readonly ElectrumUtxo[],
  vaultUtxos: readonly ElectrumUtxo[],
): ChainView {
  const ofPool = (u: ElectrumUtxo, capability: string) =>
    u.token_data?.category === record.poolCategory && u.token_data.nft?.capability === capability;
  const states = poolUtxos.filter((u) => ofPool(u, 'minting'));
  if (states.length === 0) throw new Error('found no pool state NFT');
  // A sharded pool holds one state NFT per shard; the newest epoch among them is the active root (ADR 0013).
  const active = states
    .map((u) => decodeState(u.token_data?.nft?.commitment ?? ''))
    .reduce((best, s) => (s.epoch > best.epoch ? s : best));
  const gate = gateUtxos.find((u) => ofPool(u, 'mutable'));
  const gateState = gate ? decodeState(gate.token_data?.nft?.commitment ?? '') : undefined;
  const pending = gate && gateState && gateState.epoch > active.epoch ? { state: gateState, height: gate.height } : undefined;
  const receipts = vaultUtxos.filter((u) => ofPool(u, 'none')).map((u) => decodeReceipt(u.token_data?.nft?.commitment ?? ''));
  return { tip, active, pending, receipts };
}

export type RootCheck = 'match' | 'mismatch';

export interface LookupResult {
  leaf: EpochLeaf;
  path: NonNullable<ReturnType<typeof proofPath>>;
  /** The proof folds to the root written in the epoch file. */
  proofMatchesFile: boolean;
  /** The epoch file's root is the root the pool contract holds on chain. */
  fileMatchesChain: RootCheck;
  cumulative: bigint;
  claimed: bigint;
  claimable: bigint;
}

/** Everything the page shows for one address, or why it cannot be shown. */
export function lookup(file: EpochFileView, chain: ChainView, lockingBytecode: Uint8Array, maxDepth: number): LookupResult | 'notFound' | 'badProof' {
  const leaf = findLeaf(file, lockingBytecode);
  if (!leaf) return 'notFound';
  const path = proofPath(leaf, maxDepth);
  if (!path) return 'badProof';
  const proofMatchesFile = path.root === file.root;
  const chainRoot = binToHex(chain.active.root);
  const fileMatchesChain: RootCheck = chainRoot === file.root && chain.active.epoch === file.epoch ? 'match' : 'mismatch';
  const key = receiptKey(lockingBytecode);
  const receipt = chain.receipts.find((r) => binsAreEqual(r.key, key));
  const cumulative = BigInt(leaf.cumulative);
  const claimed = receipt?.claimed ?? 0n;
  const claimable = cumulative > claimed ? cumulative - claimed : 0n;
  return { leaf, path, proofMatchesFile, fileMatchesChain, cumulative, claimed, claimable };
}

/** Leaves that still have tokens to claim: cumulative above what their receipt on chain records. */
export function openLeaves(file: EpochFileView, chain: ChainView): EpochLeaf[] {
  const claimed = new Map(chain.receipts.map((r) => [binToHex(r.key), r.claimed]));
  return file.leaves.filter((l) => BigInt(l.cumulative) > (claimed.get(binToHex(receiptKey(hexToBin(l.lockingBytecode)))) ?? 0n));
}

/** Blocks before a pending root may be activated; the delay is scaled on networks that scale sequence locks. */
export function pendingBlocksLeft(chain: ChainView, record: PoolRecord, sequenceBlockScale = 1): number | undefined {
  if (!chain.pending) return undefined;
  return blocksUntilActivation(chain.pending.height, record.activationDelay * sequenceBlockScale, chain.tip);
}

/** Base units to a decimal string with thousands separators, trailing zeros trimmed. */
export function formatUnits(value: bigint, decimals: number, locale = 'en'): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  // en-US and ms-MY both group with commas and use a point for decimals.
  const grouped = new Intl.NumberFormat(locale === 'ms' ? 'ms-MY' : 'en-US').format(whole);
  return frac ? `${grouped}.${frac}` : grouped;
}

/** The CLI command that claims for this address from a clone of the repository. */
export const claimCommand = (address: string, network: string, epoch: number, deploymentsDir: string): string =>
  `npx tsx bin/tuai.ts claim ${address} --network ${network} --epoch ${deploymentsDir}/${network}/epoch-${epoch}.json`;
