import { cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { concat, sha256, uint64le } from './bytes.ts';

/** Domain tag for leaves; inner nodes use a different tag (see merkle/tree.ts). */
export const LEAF_TAG = 0x00;

/** How an address was linked to a Folding@home identity. */
export const LinkMethod = {
  /** Address embedded in the Folding@home user name; checkable from public stats files. */
  fahName: 0,
  /** Address mapping kept by FoldingCash (compatibility addresses). */
  compatibilityMapping: 1,
  /** Legacy BTC P2PKH address in the Folding@home name, paid to the same hash160 script on BCH (src/leaf-legacy.ts). */
  legacyBtcName: 2,
} as const;
export type LinkMethod = (typeof LinkMethod)[keyof typeof LinkMethod];
const METHODS: readonly number[] = Object.values(LinkMethod);

/** Standard outputs carry at most 201 bytes of locking bytecode; a leaf must always be payable. */
export const MAX_LOCKING_BYTECODE = 201;

export type CashAddressPrefix = 'bitcoincash' | 'bchtest' | 'bchreg';

export interface Leaf {
  method: LinkMethod;
  /** Total ever earned by this locking bytecode, in base token units. Never decreases between epochs. */
  cumulative: bigint;
  /** Where a claim for this leaf must pay. */
  lockingBytecode: Uint8Array;
}

export function assertLeaf(leaf: Leaf): void {
  if (!METHODS.includes(leaf.method)) throw new Error(`unknown link method: ${leaf.method}`);
  if (leaf.lockingBytecode.length === 0 || leaf.lockingBytecode.length > MAX_LOCKING_BYTECODE) {
    throw new Error(`locking bytecode must be 1..${MAX_LOCKING_BYTECODE} bytes`);
  }
  if (leaf.method === LinkMethod.legacyBtcName && !isP2pkh(leaf.lockingBytecode)) {
    throw new Error('a legacy BTC leaf (method 2) must pay a P2PKH script');
  }
  uint64le(leaf.cumulative);
}

const isP2pkh = (b: Uint8Array): boolean =>
  b.length === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 0x14 && b[23] === 0x88 && b[24] === 0xac;

/** Leaf preimage: 0x00 || method(1) || uint64le(cumulative) || lockingBytecode. */
export function encodeLeaf(leaf: Leaf): Uint8Array {
  assertLeaf(leaf);
  return concat(Uint8Array.of(LEAF_TAG, leaf.method), uint64le(leaf.cumulative), leaf.lockingBytecode);
}

export const hashLeaf = (leaf: Leaf): Uint8Array => sha256(encodeLeaf(leaf));

/** Converts a CashAddr (with or without its prefix) to locking bytecode. Throws a named error when invalid. */
export function addressToLockingBytecode(address: string, defaultPrefix: CashAddressPrefix = 'bitcoincash'): Uint8Array {
  const trimmed = address.trim();
  const full = trimmed.includes(':') ? trimmed.toLowerCase() : `${defaultPrefix}:${trimmed.toLowerCase()}`;
  const decoded = cashAddressToLockingBytecode(full);
  if (typeof decoded === 'string') throw new Error(`invalid address ${address}: ${decoded}`);
  return decoded.bytecode;
}

export function lockingBytecodeToAddress(
  bytecode: Uint8Array,
  prefix: CashAddressPrefix = 'bitcoincash',
  tokenSupport = true,
): string {
  const result = lockingBytecodeToCashAddress({ bytecode, prefix, tokenSupport });
  if (typeof result === 'string') throw new Error(`locking bytecode has no CashAddr form: ${result}`);
  return result.address;
}

export function leafFromAddress(
  address: string,
  cumulative: bigint,
  method: LinkMethod = LinkMethod.fahName,
  defaultPrefix: CashAddressPrefix = 'bitcoincash',
): Leaf {
  const leaf = { method, cumulative, lockingBytecode: addressToLockingBytecode(address, defaultPrefix) };
  assertLeaf(leaf);
  return leaf;
}
