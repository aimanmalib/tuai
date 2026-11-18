import { binToHex, binsAreEqual, hexToBin } from '@bitauth/libauth';
import { concat, hexToBinChecked, sha256, uint64le } from '../bytes.ts';

export const HASH_BYTES = 32;
export const STATE_BYTES = 68;
export const RECEIPT_BYTES = 72;
/** Byte (hex) RootGate.arm appends to the pending-root commitment to open operator pushes (ADR 0008). */
export const ARM_FLAG = '01';

/** Pool state NFT commitment: root(32) epoch(4 LE) inputsHash(32). */
export interface PoolState {
  root: Uint8Array;
  epoch: number;
  inputsHash: Uint8Array;
}

/** Initial state: a zero root has no known preimage, so nothing is claimable until a root is activated. */
export const EMPTY_STATE: PoolState = { root: new Uint8Array(32), epoch: 0, inputsHash: new Uint8Array(32) };

export function encodeState(state: PoolState): Uint8Array {
  if (state.root.length !== HASH_BYTES || state.inputsHash.length !== HASH_BYTES) throw new Error('state hashes must be 32 bytes');
  if (!Number.isInteger(state.epoch) || state.epoch < 0 || state.epoch > 0x7fffffff) throw new RangeError('epoch out of range');
  const epoch = new Uint8Array(4);
  new DataView(epoch.buffer).setUint32(0, state.epoch, true);
  return concat(state.root, epoch, state.inputsHash);
}

export function decodeState(commitment: Uint8Array | string): PoolState {
  const bytes = typeof commitment === 'string' ? hexToBinChecked(commitment) : commitment;
  if (bytes.length !== STATE_BYTES) throw new Error(`state commitment must be ${STATE_BYTES} bytes`);
  return {
    root: bytes.slice(0, 32),
    epoch: new DataView(bytes.buffer, bytes.byteOffset + 32, 4).getUint32(0, true),
    inputsHash: bytes.slice(36, 68),
  };
}

/** Receipt NFT commitment: key(32) next(32) claimed(8 LE). Receipts form a list sorted by key. */
export interface Receipt {
  key: Uint8Array;
  next: Uint8Array;
  claimed: bigint;
}

export const HEAD_KEY = new Uint8Array(32);
export const END_KEY = new Uint8Array(32).fill(0xff);
/** The list head created at deploy; END_KEY in `next` marks the end of the list. */
export const HEAD_RECEIPT: Receipt = { key: HEAD_KEY, next: END_KEY, claimed: 0n };

export const receiptKey = (lockingBytecode: Uint8Array): Uint8Array => sha256(lockingBytecode);

export function encodeReceipt(receipt: Receipt): Uint8Array {
  if (receipt.key.length !== HASH_BYTES || receipt.next.length !== HASH_BYTES) throw new Error('receipt keys must be 32 bytes');
  return concat(receipt.key, receipt.next, uint64le(receipt.claimed));
}

export function decodeReceipt(commitment: Uint8Array | string): Receipt {
  const bytes = typeof commitment === 'string' ? hexToBinChecked(commitment) : commitment;
  if (bytes.length !== RECEIPT_BYTES) throw new Error(`receipt commitment must be ${RECEIPT_BYTES} bytes`);
  let claimed = 0n;
  for (let i = 7; i >= 0; i -= 1) claimed = (claimed << 8n) | BigInt(bytes[64 + i] as number);
  return { key: bytes.slice(0, 32), next: bytes.slice(32, 64), claimed };
}

/** Keys are ordered as little-endian unsigned integers, the same order the contract uses. */
export function keyToBigInt(key: Uint8Array): bigint {
  let value = 0n;
  for (let i = key.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(key[i] as number);
  return value;
}

export type ReceiptMatch<T> = { kind: 'own'; item: T; receipt: Receipt } | { kind: 'predecessor'; item: T; receipt: Receipt };

/** Finds the receipt a claim for `key` must spend: its own receipt, or the list node it is inserted after. */
export function findReceipt<T>(items: readonly T[], read: (item: T) => Receipt, key: Uint8Array): ReceiptMatch<T> | undefined {
  const target = keyToBigInt(key);
  for (const item of items) {
    const receipt = read(item);
    if (binsAreEqual(receipt.key, key)) return { kind: 'own', item, receipt };
  }
  for (const item of items) {
    const receipt = read(item);
    if (keyToBigInt(receipt.key) < target && target < keyToBigInt(receipt.next)) return { kind: 'predecessor', item, receipt };
  }
  return undefined;
}

/** Token categories are shown in txid byte order; the VM compares them in internal (reversed) order. */
export const categoryToVm = (category: string): Uint8Array => hexToBin(category).reverse();
export const categoryFromVm = (bytes: Uint8Array): string => binToHex(bytes.slice().reverse());
