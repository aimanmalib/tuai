import { describe, expect, it } from 'vitest';
import { explorerLinks, explorerProblems, explorersOf } from '../src/explorers.ts';
import { loadConfig } from '../src/config.ts';

describe('explorers', () => {
  it('reads the named list first, primary first', () => {
    const list = [
      { name: 'One', txUrl: 'https://one.example/tx/' },
      { name: 'Two', txUrl: 'https://two.example/chipnet/tx/' },
    ];
    expect(explorersOf({ explorers: list, explorerTxUrl: 'https://old.example/tx/' })).toEqual(list);
    expect(explorerLinks(list, 'ab')).toEqual([
      { name: 'One', url: 'https://one.example/tx/ab' },
      { name: 'Two', url: 'https://two.example/chipnet/tx/ab' },
    ]);
  });

  it('reads the older single URL as one explorer named after its host, and nothing as none', () => {
    expect(explorersOf({ explorerTxUrl: 'https://old.example/tx/' })).toEqual([{ name: 'old.example', txUrl: 'https://old.example/tx/' }]);
    expect(explorersOf({ explorers: [], explorerTxUrl: 'https://old.example/tx/' })).toHaveLength(1);
    expect(explorersOf({})).toEqual([]);
    expect(explorersOf(undefined)).toEqual([]);
  });

  it('rejects explorer entries without a name or with a URL that cannot take a txid', () => {
    expect(explorerProblems('chipnet', { explorers: [{ name: 'A', txUrl: 'https://a.example/tx/' }] })).toEqual([]);
    expect(explorerProblems('chipnet', { explorers: [{ name: '', txUrl: 'https://a.example/tx/' }] })).toHaveLength(1);
    expect(explorerProblems('chipnet', { explorers: [{ name: 'A', txUrl: 'http://a.example/tx/' }] })).toHaveLength(1);
    expect(explorerProblems('chipnet', { explorers: [{ name: 'A', txUrl: 'https://a.example/tx' }] })).toHaveLength(1);
    expect(explorerProblems('chipnet', { explorers: 'x' })).toHaveLength(1);
    expect(explorerProblems('chipnet', { explorerTxUrl: 'https://a.example' })).toHaveLength(1);
  });

  it('gives every network the claim page shows at least one explorer in the committed config', () => {
    const c = loadConfig();
    for (const n of c.web.networks) expect(explorersOf(c.networks[n]).length, n).toBeGreaterThan(0);
  });
});
