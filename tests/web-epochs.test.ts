import { describe, expect, it } from 'vitest';
import { collectEpochFiles } from '../scripts/web-epochs.ts';

describe('served epoch files', () => {
  it('serves pool.json, every epoch file, inputs and an index for each configured network', () => {
    const files = collectEpochFiles(process.cwd(), 'deployments', ['chipnet', 'mainnet']);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('chipnet/pool.json');
    expect(paths).toContain('chipnet/epoch-1.json');
    expect(paths.some((p) => p.startsWith('chipnet/inputs/'))).toBe(true);
    // A network without a deployment record is skipped rather than served empty.
    expect(paths.some((p) => p.startsWith('mainnet/'))).toBe(false);
    const index = JSON.parse(files.find((f) => f.path === 'chipnet/index.json')!.body) as { epochs: number[] };
    const epochFiles = paths.filter((p) => /^chipnet\/epoch-\d+\.json$/.test(p)).length;
    expect(index.epochs).toHaveLength(epochFiles);
    expect([...index.epochs].sort((a, b) => a - b)).toEqual(index.epochs);
  });
});
