import { describe, expect, it } from 'vitest';
import { binToHex, hexToBin } from '../src/bytes.ts';
import {
  LinkMethod,
  addressToLockingBytecode,
  encodeLeaf,
  hashLeaf,
  leafFromAddress,
  lockingBytecodeToAddress,
} from '../src/leaf.ts';

const P2PKH = hexToBin('76a914' + '11'.repeat(20) + '88ac');

describe('leaf encoding', () => {
  it('lays out tag, method, little-endian amount and locking bytecode', () => {
    const encoded = encodeLeaf({ method: LinkMethod.compatibilityMapping, cumulative: 0x0102n, lockingBytecode: P2PKH });
    expect(binToHex(encoded)).toBe('00' + '01' + '0201000000000000' + binToHex(P2PKH));
  });

  it('changes the hash when any field changes', () => {
    const base = { method: LinkMethod.fahName, cumulative: 5n, lockingBytecode: P2PKH };
    const h = binToHex(hashLeaf(base));
    expect(binToHex(hashLeaf({ ...base, cumulative: 6n }))).not.toBe(h);
    expect(binToHex(hashLeaf({ ...base, method: LinkMethod.compatibilityMapping }))).not.toBe(h);
    const other = P2PKH.slice();
    other[3] = 0x12;
    expect(binToHex(hashLeaf({ ...base, lockingBytecode: other }))).not.toBe(h);
  });

  it('rejects amounts outside 0..2^63-1, unknown methods and oversized scripts', () => {
    const base = { method: LinkMethod.fahName, cumulative: 1n, lockingBytecode: P2PKH };
    expect(() => encodeLeaf({ ...base, cumulative: -1n })).toThrow(/range/);
    expect(() => encodeLeaf({ ...base, cumulative: 1n << 63n })).toThrow(/range/);
    expect(() => encodeLeaf({ ...base, method: 3 as LinkMethod })).toThrow(/method/);
    expect(() => encodeLeaf({ ...base, lockingBytecode: new Uint8Array(0) })).toThrow(/locking bytecode/);
    expect(() => encodeLeaf({ ...base, lockingBytecode: new Uint8Array(202) })).toThrow(/locking bytecode/);
    expect(binToHex(encodeLeaf({ ...base, cumulative: (1n << 63n) - 1n })).slice(4, 20)).toBe('ffffffffffffff7f');
  });
});

describe('addresses', () => {
  it('round-trips CashAddr with and without prefix, token-aware or not', () => {
    const tokenAddr = lockingBytecodeToAddress(P2PKH, 'bchtest', true);
    const plainAddr = lockingBytecodeToAddress(P2PKH, 'bchtest', false);
    expect(tokenAddr.startsWith('bchtest:z')).toBe(true);
    expect(plainAddr.startsWith('bchtest:q')).toBe(true);
    for (const a of [tokenAddr, plainAddr, plainAddr.toUpperCase()]) {
      expect(binToHex(addressToLockingBytecode(a))).toBe(binToHex(P2PKH));
    }
    const bare = plainAddr.split(':')[1] as string;
    expect(binToHex(addressToLockingBytecode(bare, 'bchtest'))).toBe(binToHex(P2PKH));
  });

  it('rejects a bad checksum or a prefix for another network', () => {
    const addr = lockingBytecodeToAddress(P2PKH, 'bitcoincash', false);
    const broken = addr.slice(0, -1) + (addr.endsWith('q') ? 'p' : 'q');
    expect(() => addressToLockingBytecode(broken)).toThrow(/invalid address/);
    expect(() => addressToLockingBytecode(addr.split(':')[1] as string, 'bchtest')).toThrow(/invalid address/);
  });

  it('builds a leaf from an address', () => {
    const addr = lockingBytecodeToAddress(P2PKH, 'bitcoincash');
    const leaf = leafFromAddress(addr, 42n);
    expect(leaf.method).toBe(LinkMethod.fahName);
    expect(binToHex(leaf.lockingBytecode)).toBe(binToHex(P2PKH));
  });
});
