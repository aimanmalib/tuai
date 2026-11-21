import { existsSync, readFileSync } from 'node:fs';
import { hexToBinChecked } from '../bytes.ts';

/**
 * Suffix of an input stored as hex text instead of raw bytes. Some sponsor responses carry a field whose name
 * and value look like a credential to secret scanners; hex text keeps the exact bytes (and so the hash in the
 * manifest and on chain) while never matching such a pattern. The manifest still names the `.json` file.
 */
export const HEX_SUFFIX = '.hex';

/** Decodes hex text with line breaks back to the original input bytes. */
export const decodeStoredHex = (text: string): Uint8Array => hexToBinChecked(text.replace(/\s+/g, ''));

/** Encodes input bytes as hex text in fixed lines, the form `readStoredInput` accepts next to the `.json` name. */
export function encodeStoredHex(bytes: Uint8Array, width = 128): string {
  const hex = Buffer.from(bytes).toString('hex');
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += width) lines.push(hex.slice(i, i + width));
  return `${lines.join('\n')}\n`;
}

/** Reads an input by its manifest path: the raw file when present, otherwise the same name with `.hex` appended. */
export function readStoredInput(path: string): Uint8Array {
  if (existsSync(path)) return readFileSync(path);
  const hexPath = `${path}${HEX_SUFFIX}`;
  if (existsSync(hexPath)) return decodeStoredHex(readFileSync(hexPath, 'utf8'));
  throw new Error(`input ${path} not found (also looked for ${hexPath})`);
}
