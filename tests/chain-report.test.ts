import { describe, expect, it } from 'vitest';
import { renderTransactions, replaceGenerated, type PublicTx } from '../src/demo/report.ts';

const TXID = 'ab'.repeat(32);
const rows: PublicTx[] = [
  { kind: 'deploy', txid: TXID, bytes: 858, feeSats: 858, utc: '2026-11-18T00:05:05.539Z', height: 336006 },
  { kind: 'activate-epoch-1', txid: null, bytes: 500, feeSats: 500, utc: '2026-11-18T00:06:00.000Z', height: null, error: 'BIP68 | lock\n\nnon-BIP68-final (code 64)' },
  { kind: 'claim-first-epoch-1', txid: TXID, bytes: 1200, feeSats: 1200, utc: '2026-11-18T01:00:00.000Z', height: null, note: 'leaf 0' },
];

describe('chain report', () => {
  it('lists every attempt with its full txid, block and result', () => {
    const t = renderTransactions(rows, [{ name: 'x', txUrl: 'https://x.example/tx/' }]).split('\n');
    expect(t).toHaveLength(5);
    expect(t[2]).toBe(`| 1 | 2026-11-18 00:05:05 | deploy | [\`${TXID}\`](https://x.example/tx/${TXID}) | 858 | 858 | 336006 | accepted |`);
    expect(t[3]).toContain('| not mined |');
    expect(t[3]).toContain('refused: BIP68 \\| lock non-BIP68-final (code 64) |');
    expect(t[4]).toMatch(/\| - \| accepted \(leaf 0\) \|$/);
  });

  it('links the txid to the primary explorer and names the others after it', () => {
    const two = [
      { name: 'x', txUrl: 'https://x.example/tx/' },
      { name: 'Second', txUrl: 'https://y.example/chipnet/tx/' },
    ];
    expect(renderTransactions(rows, two).split('\n')[2]).toContain(`| [\`${TXID}\`](https://x.example/tx/${TXID}) ([Second](https://y.example/chipnet/tx/${TXID})) |`);
    expect(renderTransactions(rows, []).split('\n')[2]).toContain(`| \`${TXID}\` |`);
  });

  it('replaces only the marked block', () => {
    const doc = '# M\n\n## Chipnet\n\n<!-- chipnet-transactions:start -->\nold\n<!-- chipnet-transactions:end -->\n\n## Next\n';
    const once = replaceGenerated(doc, 'chipnet', 'new');
    expect(once).toBe('# M\n\n## Chipnet\n\n<!-- chipnet-transactions:start -->\nnew\n<!-- chipnet-transactions:end -->\n\n## Next\n');
    expect(replaceGenerated(once, 'chipnet', 'new')).toBe(once);
    expect(() => replaceGenerated(doc, 'mainnet', 'x')).toThrow(/no mainnet transaction markers/);
  });
});
