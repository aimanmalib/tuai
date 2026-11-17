import { readFileSync } from 'node:fs';
import { binToHex } from '@bitauth/libauth';
import { hexToBinChecked } from '../bytes.ts';
import { hashLeaf, lockingBytecodeToAddress, type CashAddressPrefix, type Leaf, type LinkMethod } from '../leaf.ts';
import { buildTree } from '../merkle/tree.ts';
import { getProof } from '../merkle/proof.ts';
import { balancesToLeaves, type Balances } from './cumulative.ts';
import { manifestHash } from './canonical.ts';

export const EPOCH_FORMAT = 'tuai-epoch/1';
export const MANIFEST_FORMAT = 'tuai-manifest/1';

/** One input file, stored next to the epoch file so anyone can recompute the root. */
export interface ManifestInput {
  /** Path relative to the epoch file's folder. */
  file: string;
  sha256: string;
  kind: 'distro' | 'allocations';
  /** For sponsor API inputs: the query that produced the file. */
  request?: { path: string; query: Record<string, string> };
}

/** Everything the root depends on. Its canonical hash is the inputs hash committed on chain. */
export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  epoch: number;
  maxDepth: number;
  /** Link method given to entries that do not name one. */
  defaultMethod: LinkMethod;
  /** Base units per whole token: 10^decimals. */
  decimals: number;
  previous: { file: string; epoch: number; root: string } | null;
  inputs: ManifestInput[];
}

export interface RecipientJson {
  lockingBytecode: string;
  method: LinkMethod;
  cumulative: string;
  highWater: string;
}

export interface LeafJson {
  index: number;
  /** Null when the locking bytecode has no CashAddr form. */
  address: string | null;
  method: LinkMethod;
  cumulative: string;
  lockingBytecode: string;
  proof: string[];
}

export interface EpochFile {
  format: typeof EPOCH_FORMAT;
  network: string;
  epoch: number;
  root: string;
  inputsHash: string;
  depth: number;
  manifest: Manifest;
  /** Running totals carried into the next epoch (includes recipients with nothing earned yet). */
  recipients: RecipientJson[];
  leaves: LeafJson[];
}

export const recipientsToJson = (balances: Balances): RecipientJson[] =>
  [...balances.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lockingBytecode, b]) => ({
      lockingBytecode,
      method: b.method,
      cumulative: b.cumulative.toString(),
      highWater: b.highWater.toString(),
    }));

export const recipientsFromJson = (rows: readonly RecipientJson[]): Balances =>
  new Map(rows.map((r) => [r.lockingBytecode, { method: r.method, cumulative: BigInt(r.cumulative), highWater: BigInt(r.highWater) }]));

export const leafFromJson = (l: LeafJson): Leaf => ({
  method: l.method,
  cumulative: BigInt(l.cumulative),
  lockingBytecode: hexToBinChecked(l.lockingBytecode),
});

function addressOrNull(bytecode: Uint8Array, prefix: CashAddressPrefix): string | null {
  try {
    return lockingBytecodeToAddress(bytecode, prefix);
  } catch {
    return null;
  }
}

/** Builds the tree over the balances and writes every leaf with its proof. */
export function makeEpochFile(network: string, prefix: CashAddressPrefix, manifest: Manifest, balances: Balances): EpochFile {
  const leaves = balancesToLeaves(balances);
  if (leaves.length === 0) throw new Error('nobody has earned anything yet: an epoch needs at least one leaf');
  const tree = buildTree(leaves.map(hashLeaf), manifest.maxDepth);
  return {
    format: EPOCH_FORMAT,
    network,
    epoch: manifest.epoch,
    root: binToHex(tree.root),
    inputsHash: manifestHash(manifest),
    depth: tree.depth,
    manifest,
    recipients: recipientsToJson(balances),
    leaves: leaves.map((leaf, index) => ({
      index,
      address: addressOrNull(leaf.lockingBytecode, prefix),
      method: leaf.method,
      cumulative: leaf.cumulative.toString(),
      lockingBytecode: binToHex(leaf.lockingBytecode),
      proof: getProof(tree, index).siblings.map(binToHex),
    })),
  };
}

export function readEpochFile(path: string): EpochFile {
  const file = JSON.parse(readFileSync(path, 'utf8')) as EpochFile;
  if (file.format !== EPOCH_FORMAT) throw new Error(`${path} is not a Tuai epoch file`);
  return file;
}

/** Finds the leaf paying `lockingBytecode` (hex). */
export const findLeaf = (file: EpochFile, lockingBytecode: string): LeafJson | undefined =>
  file.leaves.find((l) => l.lockingBytecode === lockingBytecode);
