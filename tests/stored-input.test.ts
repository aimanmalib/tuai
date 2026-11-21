import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeStoredHex, encodeStoredHex, HEX_SUFFIX, readStoredInput } from '../src/epoch/stored-input.ts';

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tuai-stored-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('stored inputs', () => {
  const bytes = new TextEncoder().encode('{"distro":[{"amount":1.5,"name":"x"}]}\n');

  it('round-trips bytes through line-wrapped hex text', () => {
    const text = encodeStoredHex(bytes, 16);
    expect(text.split('\n').filter(Boolean).every((l) => l.length <= 16)).toBe(true);
    expect(/^[0-9a-f\n]+$/.test(text)).toBe(true);
    expect(decodeStoredHex(text)).toEqual(bytes);
  });

  it('reads the raw file when present and the hex form otherwise', () => {
    const dir = tempDir();
    const raw = join(dir, 'a.json');
    writeFileSync(raw, bytes);
    expect(new Uint8Array(readStoredInput(raw))).toEqual(bytes);
    const hexOnly = join(dir, 'b.json');
    writeFileSync(`${hexOnly}${HEX_SUFFIX}`, encodeStoredHex(bytes));
    expect(readStoredInput(hexOnly)).toEqual(bytes);
  });

  it('refuses a missing input and hex text that is not hex', () => {
    const dir = tempDir();
    expect(() => readStoredInput(join(dir, 'none.json'))).toThrow(/not found/);
    const bad = join(dir, 'bad.json');
    writeFileSync(`${bad}${HEX_SUFFIX}`, 'zz\n');
    expect(() => readStoredInput(bad)).toThrow(/hex/);
  });
});
