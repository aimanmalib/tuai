import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { binToHex, concat, hexToBin } from '../src/bytes.ts';
import { hashLeaf, type Leaf } from '../src/leaf.ts';
import { computeRoot, getProof, proofFromJson, proofToJson, verifyLeafHash, verifyProof } from '../src/merkle/proof.ts';
import { ZERO_HASH, buildTree, treeDepth } from '../src/merkle/tree.ts';
import { VECTORS_PATH, renderVectors, syntheticLeaf } from '../scripts/vectors.ts';

const MAX = 24;
const leaves300 = Array.from({ length: 300 }, (_, i) => syntheticLeaf(i));
const tree300 = buildTree(leaves300.map(hashLeaf), MAX);
const leafAt = (i: number) => leaves300[i] as Leaf;

/** Independent reference: node:crypto, written without the library's helpers. */
function referenceRoot(leaves: Leaf[]): string {
  const h = (b: Buffer) => createHash('sha256').update(b).digest();
  let level: Buffer[] = leaves.map((l) => {
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(l.cumulative);
    return h(Buffer.concat([Buffer.from([0, l.method]), amount, Buffer.from(l.lockingBytecode)]));
  });
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(h(Buffer.concat([Buffer.from([1]), level[i] as Buffer, level[i + 1] ?? Buffer.alloc(32)])));
    }
    level = next;
  }
  return (level[0] as Buffer).toString('hex');
}

describe('tree shape', () => {
  it('computes depth as ceil(log2 n)', () => {
    expect([1, 2, 3, 4, 5, 300, 512, 513].map(treeDepth)).toEqual([0, 1, 2, 2, 3, 9, 9, 10]);
    expect(() => treeDepth(0)).toThrow();
  });

  it('matches an independent implementation for 1, 2, 3 and 300 leaves', () => {
    for (const n of [1, 2, 3, 300]) {
      const leaves = leaves300.slice(0, n);
      expect(binToHex(buildTree(leaves.map(hashLeaf), MAX).root)).toBe(referenceRoot(leaves));
    }
  });

  it('refuses a tree deeper than maxDepth', () => {
    expect(() => buildTree(leaves300.map(hashLeaf), 8)).toThrow(/depth 9/);
  });
});

describe('proofs', () => {
  it('verifies every index of a 300-leaf tree', () => {
    for (let i = 0; i < 300; i += 1) {
      const proof = getProof(tree300, i);
      expect(proof.siblings).toHaveLength(9);
      expect(verifyProof(leafAt(i), proof, tree300.root, MAX)).toBe(true);
    }
  });

  it('proves the last leaf through zero padding', () => {
    const proof = getProof(tree300, 299);
    expect(proof.siblings.some((s) => binToHex(s) === binToHex(ZERO_HASH))).toBe(true);
    const three = buildTree(leaves300.slice(0, 3).map(hashLeaf), MAX);
    const p = getProof(three, 2);
    expect(binToHex(p.siblings[0] as Uint8Array)).toBe(binToHex(ZERO_HASH));
    expect(verifyProof(leafAt(2), p, three.root, MAX)).toBe(true);
  });

  it('rejects a changed amount', () => {
    const leaf = { ...leafAt(10), cumulative: leafAt(10).cumulative + 1n };
    expect(verifyProof(leaf, getProof(tree300, 10), tree300.root, MAX)).toBe(false);
  });

  it('rejects a changed address', () => {
    const leaf = { ...leafAt(10), lockingBytecode: leafAt(11).lockingBytecode };
    expect(verifyProof(leaf, getProof(tree300, 10), tree300.root, MAX)).toBe(false);
  });

  it('rejects a changed link method', () => {
    const leaf = { ...leafAt(10), method: leafAt(10).method === 0 ? 1 : 0 } as Leaf;
    expect(verifyProof(leaf, getProof(tree300, 10), tree300.root, MAX)).toBe(false);
  });

  it('rejects a swapped or altered sibling', () => {
    const proof = getProof(tree300, 42);
    const swapped = { ...proof, siblings: [...proof.siblings] };
    [swapped.siblings[0], swapped.siblings[1]] = [proof.siblings[1] as Uint8Array, proof.siblings[0] as Uint8Array];
    expect(verifyProof(leafAt(42), swapped, tree300.root, MAX)).toBe(false);
    const flipped = proof.siblings.map((s) => s.slice());
    const target = flipped[4] as Uint8Array;
    target[0] = (target[0] as number) ^ 1;
    expect(verifyProof(leafAt(42), { ...proof, siblings: flipped }, tree300.root, MAX)).toBe(false);
  });

  it('rejects a proof used at another index', () => {
    const proof = getProof(tree300, 42);
    expect(verifyProof(leafAt(42), { ...proof, index: 43 }, tree300.root, MAX)).toBe(false);
  });

  it('rejects indexes that are out of range or not integers', () => {
    const proof = getProof(tree300, 5);
    for (const index of [-1, 512, 5 + 512, 5.5, Number.NaN]) {
      expect(verifyProof(leafAt(5), { ...proof, index }, tree300.root, MAX)).toBe(false);
    }
    expect(() => getProof(tree300, 300)).toThrow(RangeError);
  });

  it('rejects a truncated or extended proof', () => {
    const proof = getProof(tree300, 7);
    expect(verifyProof(leafAt(7), { ...proof, siblings: proof.siblings.slice(0, -1) }, tree300.root, MAX)).toBe(false);
    const extended = { ...proof, siblings: [...proof.siblings, ZERO_HASH] };
    expect(verifyProof(leafAt(7), extended, tree300.root, MAX)).toBe(false);
  });

  it('rejects a proof longer than maxDepth even when it would fold to the root', () => {
    const proof = getProof(tree300, 7);
    expect(computeRoot(hashLeaf(leafAt(7)), proof, 8)).toBeUndefined();
    expect(verifyProof(leafAt(7), proof, tree300.root, 8)).toBe(false);
  });

  it('rejects a sibling that is not 32 bytes', () => {
    const proof = getProof(tree300, 7);
    const bad = [...proof.siblings];
    bad[2] = (bad[2] as Uint8Array).slice(0, 31);
    expect(verifyProof(leafAt(7), { ...proof, siblings: bad }, tree300.root, MAX)).toBe(false);
  });

  it('rejects an inner node presented as a leaf (domain separation)', () => {
    // Forge a "leaf" whose fields serialize to exactly left || right of a level-1 node. Without distinct leaf and
    // node tags its hash would equal that node, and the shortened proof would fold to the root. Search for a tree
    // whose first leaf hash starts with a valid method byte and a positive amount so the forgery is well formed.
    for (let salt = 1n; ; salt += 1n) {
      const leaves = leaves300.slice(0, 4).map((l, i) => (i === 0 ? { ...l, cumulative: salt } : l));
      const tree = buildTree(leaves.map(hashLeaf), MAX);
      const raw = concat(tree.levels[0]?.[0] as Uint8Array, tree.levels[0]?.[1] as Uint8Array);
      if ((raw[0] as number) > 1 || (raw[8] as number) >= 0x80) continue;
      const amount = new DataView(raw.buffer, raw.byteOffset + 1, 8).getBigUint64(0, true);
      const forged = { method: raw[0], cumulative: amount, lockingBytecode: raw.slice(9) } as Leaf;
      const shortened = { index: 0, siblings: getProof(tree, 0).siblings.slice(1) };
      expect(verifyLeafHash(tree.levels[1]?.[0] as Uint8Array, shortened, tree.root, MAX)).toBe(true);
      expect(verifyProof(forged, shortened, tree.root, MAX)).toBe(false);
      break;
    }
  });

  it('round-trips proofs through JSON and refuses malformed hex', () => {
    const proof = getProof(tree300, 150);
    expect(verifyProof(leafAt(150), proofFromJson(proofToJson(proof)), tree300.root, MAX)).toBe(true);
    expect(() => proofFromJson({ index: 0, siblings: ['zz'] })).toThrow(/hex/);
    expect(() => proofFromJson({ index: 0, siblings: ['00'.repeat(31)] })).toThrow(/32 bytes/);
  });
});

describe('examples/vectors.json', () => {
  const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
    vectors: { leafCount: number; root: string; leaves: { preimage: string; hash: string; proof: { index: number; siblings: string[] } }[] }[];
  };

  it('is the current output of scripts/vectors.ts', () => {
    expect(readFileSync(VECTORS_PATH, 'utf8')).toBe(renderVectors());
    expect(file.vectors.length).toBeGreaterThanOrEqual(6);
    expect(file.vectors.map((v) => v.leafCount)).toEqual(expect.arrayContaining([1, 2, 3, 300]));
  });

  it('verifies every listed proof from the preimage alone', () => {
    for (const v of file.vectors) {
      for (const l of v.leaves) {
        const leafHash = createHash('sha256').update(hexToBin(l.preimage)).digest();
        expect(leafHash.toString('hex')).toBe(l.hash);
        expect(verifyLeafHash(new Uint8Array(leafHash), proofFromJson(l.proof), hexToBin(v.root), MAX)).toBe(true);
      }
    }
  });
});
