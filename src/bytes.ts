import { binToHex, flattenBinArray, hexToBin, sha256 as libauthSha256 } from '@bitauth/libauth';

export { binToHex, hexToBin };

/** Largest value that fits a positive VM script number and a CashToken amount (2^63 - 1). */
export const MAX_UINT63 = (1n << 63n) - 1n;

export const sha256 = (data: Uint8Array): Uint8Array => libauthSha256.hash(data);

export const concat = (...parts: Uint8Array[]): Uint8Array => flattenBinArray(parts);

/** Little-endian 8-byte encoding; rejects values outside 0..2^63-1 so they stay valid script numbers. */
export function uint64le(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT63) throw new RangeError(`amount out of range: ${value}`);
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function isHex(value: string, bytes?: number): boolean {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) return false;
  return bytes === undefined || value.length === bytes * 2;
}

export function hexToBinChecked(value: string, bytes?: number): Uint8Array {
  if (!isHex(value, bytes)) {
    throw new Error(bytes === undefined ? 'expected lowercase hex' : `expected ${bytes} bytes of lowercase hex`);
  }
  return hexToBin(value);
}
