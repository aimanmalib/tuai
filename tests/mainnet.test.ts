// The mainnet card's numbers: claim count, refusals and the newest claim, from an activity index shaped like the one the
// build writes. Fixtures are frozen here; the committed mainnet record is only checked for shape.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mainnetSummary, shortTxid } from '../web/src/mainnet.ts';
import { buildTxIndex } from '../scripts/tx-index.ts';
import type { ActivityIndex, ActivityTx } from '../web/src/activity.ts';

const hex = (c: string) => c.repeat(64);
const explorers = [
  { name: 'one.example', txUrl: 'https://one.example/tx/' },
  { name: 'two.example', txUrl: 'https://two.example/transaction/' },
];

function tx(step: string, txid: string | null, height: number | null, utc: string, error?: string): ActivityTx {
  return { step, epoch: 1, kind: `${step}-epoch-1`, txid, bytes: 1000, feeSats: 1000, height, utc, links: [], ...(error ? { error } : {}) };
}

const index = (...runs: ActivityTx[][]): ActivityIndex => ({
  network: 'mainnet',
  runs: runs.map((transactions, i) => ({ run: `mainnet-${i}`, pool: `pool-${i}`, epochs: [], transactions })),
});

describe('mainnet card', () => {
  it('counts accepted claims only, not deploy or propose steps', () => {
    const s = mainnetSummary(
      index([
        tx('deploy', hex('a'), 10, '2026-11-19T17:00:00Z'),
        tx('propose', hex('b'), 10, '2026-11-19T17:01:00Z'),
        tx('claim-first', hex('c'), 12, '2026-11-19T19:00:00Z'),
      ]),
      explorers,
    );
    expect(s.claims).toBe(1);
    expect(s.refused).toBe(0);
    expect(s.latest?.txid).toBe(hex('c'));
  });

  it('counts refused claim attempts apart and never picks one as the latest', () => {
    const s = mainnetSummary(
      index([
        tx('claim-first', hex('c'), 12, '2026-11-19T19:00:00Z'),
        tx('double-claim', null, null, '2026-11-19T20:00:00Z', 'refused'),
        tx('claim-page', hex('9'), null, '2026-11-19T21:00:00Z', 'refused after it was sent'),
      ]),
      explorers,
    );
    expect(s).toMatchObject({ claims: 1, refused: 2 });
    expect(s.latest?.txid).toBe(hex('c'));
  });

  it('picks the highest block, then the later send time, across runs', () => {
    const s = mainnetSummary(
      index(
        [tx('claim-first', hex('1'), 20, '2026-11-20T01:00:00Z'), tx('claim-first', hex('2'), 21, '2026-11-20T00:00:00Z')],
        [tx('claim-additional', hex('3'), 21, '2026-11-20T02:00:00Z'), tx('claim-first', hex('4'), 20, '2026-11-20T03:00:00Z')],
      ),
      explorers,
    );
    expect(s.claims).toBe(4);
    expect(s.latest).toMatchObject({ txid: hex('3'), height: 21 });
  });

  it('treats a claim recorded before it was mined as the newest', () => {
    const s = mainnetSummary(index([tx('claim-first', hex('1'), 30, '2026-11-20T03:00:00Z'), tx('claim-first', hex('2'), null, '2026-11-20T01:00:00Z')]), explorers);
    expect(s.latest).toMatchObject({ txid: hex('2'), height: null });
  });

  it('links the latest claim to every configured explorer, primary first', () => {
    const s = mainnetSummary(index([tx('claim-first', hex('c'), 12, '2026-11-19T19:00:00Z')]), explorers);
    expect(s.latest?.links).toEqual([
      { name: 'one.example', url: `https://one.example/tx/${hex('c')}` },
      { name: 'two.example', url: `https://two.example/transaction/${hex('c')}` },
    ]);
    expect(mainnetSummary(index([tx('claim-first', hex('c'), 12, 'x')]), []).latest?.links).toEqual([]);
  });

  it('has no latest claim for an empty record', () => {
    expect(mainnetSummary(index(), explorers)).toEqual({ claims: 0, refused: 0, latest: null });
    expect(mainnetSummary(index([tx('deploy', hex('a'), 10, 'x')]), explorers).latest).toBeNull();
  });

  it('shortens a txid for display and leaves short strings alone', () => {
    expect(shortTxid(hex('ab').slice(0, 64))).toBe(`abababab…abababab`);
    expect(shortTxid('abc')).toBe('abc');
  });

  it('reads the committed mainnet record into at least one claim with a txid and a block', () => {
    const cfg = JSON.parse(readFileSync('config/tuai.json', 'utf8')) as { networks: { mainnet: { explorers: { name: string; txUrl: string }[] } } };
    const built = buildTxIndex(process.cwd(), 'deployments', { mainnet: cfg.networks.mainnet.explorers }).find((i) => i.network === 'mainnet');
    expect(built).toBeDefined();
    const s = mainnetSummary(built!, cfg.networks.mainnet.explorers);
    expect(s.claims).toBeGreaterThanOrEqual(1);
    expect(s.latest?.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(s.latest?.height).toBeGreaterThan(0);
    expect(s.latest?.links.length).toBe(cfg.networks.mainnet.explorers.length);
  });
});
