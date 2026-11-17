import { concat, sha256 } from '../bytes.ts';

/** Domain tag for inner nodes; leaves use 0x00 (see leaf.ts). */
export const NODE_TAG = 0x01;
export const HASH_BYTES = 32;
/** Padding for an odd level. Nobody knows a preimage, so it can never be proven as a leaf. */
export const ZERO_HASH = new Uint8Array(HASH_BYTES);

export const hashNode = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  sha256(concat(Uint8Array.of(NODE_TAG), left, right));

/** Number of levels above the leaves: 0 for one leaf, ceil(log2(n)) otherwise. */
export function treeDepth(leafCount: number): number {
  if (!Number.isSafeInteger(leafCount) || leafCount < 1) throw new Error('a tree needs at least one leaf');
  let depth = 0;
  while (2 ** depth < leafCount) depth += 1;
  return depth;
}

export interface MerkleTree {
  /** levels[0] = leaf hashes, levels[depth] = [root]. Odd levels are stored without their padding. */
  levels: Uint8Array[][];
  root: Uint8Array;
  depth: number;
  leafCount: number;
}

export function buildTree(leafHashes: readonly Uint8Array[], maxDepth: number): MerkleTree {
  const depth = treeDepth(leafHashes.length);
  if (depth > maxDepth) throw new Error(`tree depth ${depth} is above the limit of ${maxDepth}`);
  for (const h of leafHashes) {
    if (h.length !== HASH_BYTES) throw new Error('every leaf hash must be 32 bytes');
  }
  const levels: Uint8Array[][] = [[...leafHashes]];
  for (let level = 0; level < depth; level += 1) {
    const current = levels[level] as Uint8Array[];
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashNode(current[i] as Uint8Array, current[i + 1] ?? ZERO_HASH));
    }
    levels.push(next);
  }
  const root = levels[depth]?.[0];
  if (!root) throw new Error('tree has no root');
  return { levels, root, depth, leafCount: leafHashes.length };
}
