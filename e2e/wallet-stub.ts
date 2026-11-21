// A stand-in for the page's lazily loaded WizardConnect module: it shows a pairing link and, in "connect" mode,
// connects a wallet whose address at (path, index) comes from a table built here, so no Nostr relay is contacted.
// Addresses the test does not name are synthetic P2PKH addresses that no fake chain knows.
import { binToHex, lockingBytecodeToCashAddress, sha256 } from '@bitauth/libauth';
import { readFileSync } from 'node:fs';

export type KeyPath = 'receive' | 'change';
export interface StubAddress {
  address: string;
  hex: string;
}

const wallet = (JSON.parse(readFileSync('config/tuai.json', 'utf8')) as { relay: { wallet: { maxAddressesPerScan: number } } }).relay.wallet;

/** A P2PKH chipnet address that belongs to no real key, named by a label. */
export function syntheticAddress(label: string): StubAddress {
  const hash = sha256.hash(new TextEncoder().encode(`tuai e2e wallet ${label}`)).slice(0, 20);
  const bytecode = Uint8Array.from([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);
  const a = lockingBytecodeToCashAddress({ bytecode, prefix: 'bchtest', tokenSupport: true });
  if (typeof a === 'string') throw new Error(a);
  return { address: a.address, hex: binToHex(bytecode) };
}

/**
 * The wallet's addresses on each key path, up to the scan cap from config; `known` replaces chosen indexes, and a
 * path listed in `without` has no key at all (as a wallet that shares only receive keys).
 */
export function walletTable(seed: string, known: Partial<Record<KeyPath, Record<number, StubAddress>>> = {}, without: KeyPath[] = []) {
  const table: Record<KeyPath, StubAddress[]> = { receive: [], change: [] };
  for (const path of ['receive', 'change'] as const) {
    if (without.includes(path)) continue;
    for (let i = 0; i < wallet.maxAddressesPerScan; i++) table[path].push(known[path]?.[i] ?? syntheticAddress(`${seed} ${path} ${i}`));
  }
  return table;
}

export function stubModule(mode: 'pair' | 'connect', pairing: string, table: Record<KeyPath, StubAddress[]>): string {
  return `
const T = ${JSON.stringify(table)};
export function connectWallet(o) {
  window.__wallet = { closed: 0, end: undefined, derived: 0 };
  o.onUri(${JSON.stringify(pairing)}, ${JSON.stringify(pairing)});
  return new Promise((resolve, reject) => {
    o.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    if (${JSON.stringify(mode)} !== 'connect') return;
    setTimeout(() => resolve({
      name: 'Fake wallet',
      close() { window.__wallet.closed++; },
      onClose(listener) { window.__wallet.end = listener; },
      address(path, index) {
        const w = (T[path] || [])[index];
        if (!w) return undefined;
        window.__wallet.derived++;
        return { address: w.address, path, index, lockingBytecode: Uint8Array.from(w.hex.match(/../g).map((h) => parseInt(h, 16))) };
      },
      sign() { return new Promise(() => {}); },
    }), 300);
  });
}`;
}
