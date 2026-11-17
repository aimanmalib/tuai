/**
 * Generates examples/vectors.json: fixed leaves, roots and proofs for other implementations to check against.
 * Usage: tsx scripts/vectors.ts [--check]
 * Leaves use synthetic locking bytecode derived from a hash of the index; no keys exist for them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, concat, sha256 } from '../src/bytes.ts';
import { REPO_ROOT } from '../src/config.ts';
import { LinkMethod, encodeLeaf, hashLeaf, lockingBytecodeToAddress, type Leaf } from '../src/leaf.ts';
import { getProof, proofToJson } from '../src/merkle/proof.ts';
import { buildTree } from '../src/merkle/tree.ts';

export const VECTORS_PATH = resolve(REPO_ROOT, 'examples/vectors.json');
const MAX_DEPTH = 24;
const SIZES = [1, 2, 3, 4, 5, 300];
const LARGE_SAMPLE = [0, 1, 150, 298, 299];

/** P2PKH for most leaves, P2SH32 every fifth, method 1 every seventh: covers both lengths and both methods. */
export function syntheticLeaf(i: number): Leaf {
  const digest = sha256(new TextEncoder().encode(`tuai-vector-${i}`));
  const lockingBytecode =
    i % 5 === 4
      ? concat(Uint8Array.of(0xaa, 0x20), digest, Uint8Array.of(0x87))
      : concat(Uint8Array.of(0x76, 0xa9, 0x14), digest.slice(0, 20), Uint8Array.of(0x88, 0xac));
  return {
    method: i % 7 === 6 ? LinkMethod.compatibilityMapping : LinkMethod.fahName,
    cumulative: BigInt(1000 * (i + 1) + i),
    lockingBytecode,
  };
}

export function buildVectors() {
  const vectors = SIZES.map((size) => {
    const leaves = Array.from({ length: size }, (_, i) => syntheticLeaf(i));
    const tree = buildTree(leaves.map(hashLeaf), MAX_DEPTH);
    const indices = size > 8 ? LARGE_SAMPLE : leaves.map((_, i) => i);
    return {
      name: `${size}-leaf`,
      leafCount: size,
      depth: tree.depth,
      root: binToHex(tree.root),
      leaves: indices.map((i) => {
        const leaf = leaves[i] as Leaf;
        return {
          index: i,
          address: lockingBytecodeToAddress(leaf.lockingBytecode, 'bitcoincash'),
          method: leaf.method,
          cumulative: leaf.cumulative.toString(),
          lockingBytecode: binToHex(leaf.lockingBytecode),
          preimage: binToHex(encodeLeaf(leaf)),
          hash: binToHex(hashLeaf(leaf)),
          proof: proofToJson(getProof(tree, i)),
        };
      }),
    };
  });
  return {
    description:
      'Leaf = sha256(0x00 || method || uint64le(cumulative) || lockingBytecode); node = sha256(0x01 || left || right); ' +
      'direction from the index bits (0 = running hash on the left); odd levels padded with 32 zero bytes.',
    generator: 'scripts/vectors.ts',
    vectors,
  };
}

export const renderVectors = (): string => `${JSON.stringify(buildVectors(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = renderVectors();
  if (process.argv.includes('--check')) {
    if (readFileSync(VECTORS_PATH, 'utf8') !== rendered) {
      console.error('examples/vectors.json is out of date; run: npx tsx scripts/vectors.ts');
      process.exit(1);
    }
    console.log('examples/vectors.json is up to date');
  } else {
    writeFileSync(VECTORS_PATH, rendered);
    console.log(`wrote ${VECTORS_PATH}`);
  }
}
