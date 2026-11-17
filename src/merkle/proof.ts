import { binToHex, binsAreEqual } from '@bitauth/libauth';
import { hexToBinChecked } from '../bytes.ts';
import { hashLeaf, type Leaf } from '../leaf.ts';
import { HASH_BYTES, ZERO_HASH, hashNode, type MerkleTree } from './tree.ts';

export interface MerkleProof {
  /** Leaf position; bit i says whether the running hash is the right (1) or left (0) child at level i. */
  index: number;
  /** One sibling hash per level, from the leaves up. */
  siblings: Uint8Array[];
}

export interface MerkleProofJson {
  index: number;
  siblings: string[];
}

export function getProof(tree: MerkleTree, index: number): MerkleProof {
  if (!Number.isSafeInteger(index) || index < 0 || index >= tree.leafCount) {
    throw new RangeError(`leaf index ${index} is outside 0..${tree.leafCount - 1}`);
  }
  const siblings: Uint8Array[] = [];
  let position = index;
  for (let level = 0; level < tree.depth; level += 1) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    siblings.push(tree.levels[level]?.[sibling] ?? ZERO_HASH);
    position = Math.floor(position / 2);
  }
  return { index, siblings };
}

/**
 * Folds a leaf hash up to a root. Returns undefined for malformed proofs: a non-integer or negative index,
 * an index that does not fit the proof length, a proof longer than maxDepth, or a sibling that is not 32 bytes.
 */
export function computeRoot(leafHash: Uint8Array, proof: MerkleProof, maxDepth: number): Uint8Array | undefined {
  const { index, siblings } = proof;
  if (siblings.length > maxDepth || leafHash.length !== HASH_BYTES) return undefined;
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** siblings.length) return undefined;
  let hash = leafHash;
  let position = index;
  for (const sibling of siblings) {
    if (sibling.length !== HASH_BYTES) return undefined;
    hash = position % 2 === 1 ? hashNode(sibling, hash) : hashNode(hash, sibling);
    position = Math.floor(position / 2);
  }
  return hash;
}

export function verifyLeafHash(leafHash: Uint8Array, proof: MerkleProof, root: Uint8Array, maxDepth: number): boolean {
  const computed = computeRoot(leafHash, proof, maxDepth);
  return computed !== undefined && binsAreEqual(computed, root);
}

export function verifyProof(leaf: Leaf, proof: MerkleProof, root: Uint8Array, maxDepth: number): boolean {
  let leafHash: Uint8Array;
  try {
    leafHash = hashLeaf(leaf);
  } catch {
    return false;
  }
  return verifyLeafHash(leafHash, proof, root, maxDepth);
}

export const proofToJson = (proof: MerkleProof): MerkleProofJson => ({
  index: proof.index,
  siblings: proof.siblings.map(binToHex),
});

export const proofFromJson = (json: MerkleProofJson): MerkleProof => ({
  index: json.index,
  siblings: json.siblings.map((s) => hexToBinChecked(s, HASH_BYTES)),
});
