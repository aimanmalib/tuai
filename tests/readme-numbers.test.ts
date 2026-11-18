// Every txid and every grouped number in the README must come from a measured or generated document.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const readme = read('README.md');
const measured = read('docs/MEASURED.md');
const sources = [measured, read('docs/COST.md'), read('docs/DEPTH.md')].join('\n');

describe('README figures', () => {
  it('cites only txids recorded in docs/MEASURED.md', () => {
    const txids = readme.match(/\b[0-9a-f]{64}\b/g) ?? [];
    expect(txids.length).toBeGreaterThan(0);
    expect(txids.filter((t) => !measured.includes(t))).toEqual([]);
  });

  it('cites only grouped numbers that appear in MEASURED, COST or DEPTH, with or without separators', () => {
    const numbers = readme.match(/\b\d{1,3}(?:,\d{3})+\b/g) ?? [];
    expect(numbers.length).toBeGreaterThan(0);
    // Generated tables print some sizes without separators (1899), others with them (1,473).
    const inSources = (n: string): boolean => sources.includes(n) || new RegExp(`\\b${n.replace(/,/g, '')}\\b`).test(sources);
    expect(numbers.filter((n) => !inSources(n))).toEqual([]);
  });
});
