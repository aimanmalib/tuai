import { binToHex, hexToBin } from '@bitauth/libauth';
import { sha256 } from '../bytes.ts';

/**
 * Demonstration tree layout: project demo keys at chosen leaf indices, every other leaf a synthetic P2PKH script
 * whose 20-byte hash is derived from a label (nobody holds a key for it, so those leaves are never claimed).
 * Leaves are sorted by locking bytecode, so each synthetic hash is drawn from the gap between its neighbouring
 * demo keys; that pins the demo keys to the requested indices.
 */
export interface DemoLayoutOptions {
  /** P2PKH locking bytecode (hex) of each demo key, in any order. */
  demoKeys: readonly string[];
  /** Target leaf index for each demo key, same length as `demoKeys`. */
  indices: readonly number[];
  leafCount: number;
  /** Label mixed into every synthetic hash, so separate demonstrations get separate leaves. */
  label: string;
}

const P2PKH = /^76a914([0-9a-f]{40})88ac$/;
const SPACE = 1n << 160n;

const hashOf = (bytecode: string): bigint => {
  const m = P2PKH.exec(bytecode);
  if (!m) throw new Error(`demo key ${bytecode} is not a P2PKH locking bytecode`);
  return BigInt(`0x${m[1]}`);
};

const toBytecode = (h: bigint): string => `76a914${h.toString(16).padStart(40, '0')}88ac`;

const draw = (label: string, n: number): bigint =>
  BigInt(`0x${binToHex(sha256(new TextEncoder().encode(`tuai synthetic leaf ${label} ${n}`)))}`);

/** Returns the locking bytecode of every leaf in tree order; demo keys sit at their requested indices. */
export function demoLayout(o: DemoLayoutOptions): string[] {
  if (o.demoKeys.length !== o.indices.length) throw new Error('each demo key needs exactly one index');
  const keys = o.demoKeys.map(hashOf).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idx = [...o.indices].sort((a, b) => a - b);
  if (new Set(keys).size !== keys.length) throw new Error('demo keys must be distinct');
  if (new Set(idx).size !== idx.length || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= o.leafCount)) {
    throw new Error(`demo indices must be distinct integers in 0..${o.leafCount - 1}`);
  }
  const out: bigint[] = [];
  let counter = 0;
  for (let gap = 0; gap <= keys.length; gap += 1) {
    const low = gap === 0 ? -1n : (keys[gap - 1] as bigint);
    const high = gap === keys.length ? SPACE : (keys[gap] as bigint);
    const want = (gap === keys.length ? o.leafCount : (idx[gap] as number)) - out.length;
    if (BigInt(want) > high - low - 1n) throw new Error('not enough room between demo keys for the synthetic leaves');
    const fill = new Set<bigint>();
    while (fill.size < want) {
      fill.add(low + 1n + (draw(o.label, counter) % (high - low - 1n)));
      counter += 1;
    }
    out.push(...[...fill].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    if (gap < keys.length) out.push(keys[gap] as bigint);
  }
  return out.map(toBytecode);
}

/** Amount for a synthetic leaf: 1..max whole tokens, fixed by its bytecode. */
export function syntheticAmount(bytecode: string, maxWhole: bigint, unit: bigint): bigint {
  const h = BigInt(`0x${binToHex(sha256(hexToBin(bytecode)))}`);
  return ((h % maxWhole) + 1n) * unit;
}
