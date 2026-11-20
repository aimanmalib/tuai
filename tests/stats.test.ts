// The live numbers strip's arithmetic, on frozen fixtures: no published record or chain value is locked here.
import { describe, expect, it } from 'vitest';
import { claimBytesAt, computeStats, refreshMs, type StatsSources } from '../web/src/stats.ts';
import type { ActivityIndex, ActivityTx } from '../web/src/activity.ts';
import type { ElectrumUtxo } from '../web/src/model.ts';

const POOL = 'bchtest:pool';
const REWARD = 'aa'.repeat(32);
const RECEIPT = 'bb'.repeat(32);

const tx = (step: string, feeSats: number, error?: string): ActivityTx => ({
  step,
  epoch: 1,
  kind: `${step}-epoch-1`,
  txid: error ? null : step.padEnd(64, '0').slice(0, 64),
  bytes: feeSats,
  feeSats,
  height: error ? null : 100,
  utc: '2026-11-19T00:00:00Z',
  links: [],
  ...(error ? { error } : {}),
});

const index = (txs: ActivityTx[], pool = POOL): ActivityIndex => ({
  network: 'chipnet',
  runs: [
    { run: 'other', pool: 'bchtest:other', epochs: [], transactions: [tx('claim-first', 9999)] },
    { run: 'main', pool, epochs: [], transactions: txs },
  ],
});

const utxo = (value: number, token?: ElectrumUtxo['token_data']): ElectrumUtxo => ({
  tx_hash: '00'.repeat(32),
  tx_pos: 0,
  height: 1,
  value,
  ...(token ? { token_data: token } : {}),
});
const tokens = (amount: string) => utxo(800, { category: REWARD, amount });
const receipt = () => utxo(1000, { category: RECEIPT, amount: '0', nft: { capability: 'none', commitment: '' } });

function sources(over: Partial<StatsSources> = {}): StatsSources {
  return {
    epoch: { ok: true, value: { epoch: 2, leaves: 300 } },
    index: { ok: true, value: index([tx('deploy', 500), tx('claim-first', 1900), tx('claim-page', 2100), tx('double-claim', 0, 'refused'), tx('activate', 0, 'too early')]) },
    chain: { ok: true, value: { tip: 338_200, pool: [utxo(1000)], vault: [tokens('500'), receipt(), receipt()], receipts: 2 } },
    poolAddress: POOL,
    rewardCategory: REWARD,
    relay: { enabled: true, claimsLeft: 54 },
    estimate: { claimBytes: 1900, satsPerByte: 1 },
    ...over,
  };
}

describe('computeStats', () => {
  it('fills every tile from full data, counting only the shown pool and only claim steps', () => {
    const s = computeStats(sources());
    expect(s.leaves).toEqual({ ok: true, value: { epoch: 2, leaves: 300 } });
    expect(s.claims).toEqual({ ok: true, value: { recorded: 2, refused: 1, claimedOnChain: 2 } });
    expect(s.held).toEqual({ ok: true, value: { sats: 1000 + 800 + 2000, tokens: 500n } });
    expect(s.cost).toEqual({ ok: true, value: { sats: 2000, source: 'recorded', count: 2 } });
    expect(s.relay).toEqual({ ok: true, value: { claimsLeft: 54 } });
    expect(s.tip).toBe(338_200);
  });

  it('falls back to the measured size times the fee rate when no claim is recorded yet', () => {
    const s = computeStats(sources({ index: { ok: true, value: index([tx('deploy', 500)]) }, estimate: { claimBytes: 1872, satsPerByte: 1.5 } }));
    expect(s.claims).toEqual({ ok: true, value: { recorded: 0, refused: 0, claimedOnChain: 2 } });
    expect(s.cost).toEqual({ ok: true, value: { sats: 2808, source: 'estimated', count: 0 } });
  });

  it('shows an epoch without leaves as zero, not as missing', () => {
    const s = computeStats(sources({ epoch: { ok: true, value: { epoch: 1, leaves: 0 } } }));
    expect(s.leaves).toEqual({ ok: true, value: { epoch: 1, leaves: 0 } });
  });

  it('keeps the other tiles when Electrum cannot be reached', () => {
    const s = computeStats(sources({ chain: { ok: false, reason: 'timeout' } }));
    expect(s.held).toEqual({ ok: false, reason: 'timeout' });
    expect(s.tip).toBeNull();
    expect(s.claims).toEqual({ ok: true, value: { recorded: 2, refused: 1, claimedOnChain: null } });
    expect(s.leaves.ok).toBe(true);
    expect(s.cost.ok).toBe(true);
  });

  it('reports the relayer reason when it is off or unreachable, and nothing on a network without one', () => {
    expect(computeStats(sources({ relay: { enabled: false, reason: 'off' } })).relay).toEqual({ ok: false, reason: 'off' });
    expect(computeStats(sources({ relay: { enabled: false } })).relay).toEqual({ ok: false, reason: 'unreachable' });
    expect(computeStats(sources({ relay: undefined })).relay).toBeUndefined();
  });

  it('reads a mainnet record with a single run and no relayer', () => {
    const one: ActivityIndex = { network: 'mainnet', runs: [{ run: 'mainnet', pool: 'bitcoincash:p', epochs: [], transactions: [tx('claim-first', 1872)] }] };
    const s = computeStats(sources({ index: { ok: true, value: one }, poolAddress: 'bitcoincash:p', relay: undefined }));
    expect(s.claims).toEqual({ ok: true, value: { recorded: 1, refused: 0, claimedOnChain: 2 } });
    expect(s.cost).toEqual({ ok: true, value: { sats: 1872, source: 'recorded', count: 1 } });
  });

  it('adds token amounts beyond 2^53 exactly and ignores other categories', () => {
    const big = '9007199254740993';
    const vault = [tokens(big), tokens(big), utxo(1, { category: 'cc'.repeat(32), amount: '7' })];
    const s = computeStats(sources({ chain: { ok: true, value: { tip: 1, pool: [], vault, receipts: 0 } } }));
    expect(s.held).toEqual({ ok: true, value: { sats: 1601, tokens: 18014398509481986n } });
  });

  it('leaves claims and cost empty with the reason when the record cannot be read', () => {
    const s = computeStats(sources({ index: { ok: false, reason: '404 /epochs/chipnet/transactions.json' }, estimate: { claimBytes: 0, satsPerByte: 1 } }));
    expect(s.claims).toEqual({ ok: false, reason: '404 /epochs/chipnet/transactions.json' });
    expect(s.cost).toEqual({ ok: false, reason: '404 /epochs/chipnet/transactions.json' });
  });

  it('does not borrow another run when the shown pool is not in the record', () => {
    const s = computeStats(sources({ poolAddress: 'bchtest:unknown' }));
    expect(s.claims).toEqual({ ok: true, value: { recorded: 0, refused: 0, claimedOnChain: 2 } });
  });
});

describe('claimBytesAt and refreshMs', () => {
  const claims = [
    { depth: 1, firstClaimBytes: 1678 },
    { depth: 9, firstClaimBytes: 1936 },
    { depth: 7, firstClaimBytes: 1872 },
  ];
  it('picks the measured depth, else the next deeper one, else the deepest', () => {
    expect(claimBytesAt(claims, 7)).toBe(1872);
    expect(claimBytesAt(claims, 8)).toBe(1936);
    expect(claimBytesAt(claims, 0)).toBe(1678);
    expect(claimBytesAt(claims, 20)).toBe(1936);
    expect(claimBytesAt([], 3)).toBe(0);
  });
  it('keeps the interval inside 5..60 seconds', () => {
    expect(refreshMs(15)).toBe(15_000);
    expect(refreshMs(1)).toBe(5_000);
    expect(refreshMs(600)).toBe(60_000);
  });
});
