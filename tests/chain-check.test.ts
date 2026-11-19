import { describe, expect, it } from 'vitest';
import { checkTransactions, readFailure, readVerdict, type ChainCheck } from '../web/src/chain-check.ts';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const D = 'dd'.repeat(32);

describe('chain check verdicts', () => {
  it('confirms only an answer for the same txid with confirmations, at tip minus confirmations plus one', () => {
    expect(readVerdict(A, 338_001, { txid: A, confirmations: 1993 })).toEqual({ kind: 'confirmed', height: 336_009 });
    expect(readVerdict(A, 100, { txid: A, confirmations: 1 })).toEqual({ kind: 'confirmed', height: 100 });
    expect(readVerdict(A, 100, { txid: B, confirmations: 5 })).toMatchObject({ kind: 'error' });
    expect(readVerdict(A, 100, null)).toMatchObject({ kind: 'error' });
    expect(readVerdict(A, 100, 'deadbeef')).toMatchObject({ kind: 'error' });
  });

  it('reads a transaction without confirmations as not in a block yet', () => {
    expect(readVerdict(A, 100, { txid: A })).toEqual({ kind: 'mempool' });
    expect(readVerdict(A, 100, { txid: A, confirmations: 0 })).toEqual({ kind: 'mempool' });
  });

  it('refuses confirmation counts that do not fit the tip', () => {
    expect(readVerdict(A, 100, { txid: A, confirmations: 101 })).toMatchObject({ kind: 'error' });
    expect(readVerdict(A, 100, { txid: A, confirmations: -1 })).toMatchObject({ kind: 'error' });
    expect(readVerdict(A, 100, { txid: A, confirmations: '5' })).toMatchObject({ kind: 'error' });
  });

  it('tells a transaction the server does not have from other failures', () => {
    const daemon = "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'})";
    expect(readFailure(new Error(daemon))).toEqual({ kind: 'unknown' });
    expect(readFailure(new Error('timeout: blockchain.transaction.get'))).toEqual({ kind: 'error', reason: 'timeout: blockchain.transaction.get' });
  });
});

describe('checking many transactions', () => {
  it('asks once per txid, keeps at most the limit in flight, and reports confirmed, mempool and error', async () => {
    let inFlight = 0;
    let most = 0;
    const asked: string[] = [];
    const request = async (method: string, ...params: unknown[]): Promise<unknown> => {
      expect(method).toBe('blockchain.transaction.get');
      expect(params[1]).toBe(true);
      const txid = String(params[0]);
      asked.push(txid);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (txid === C) throw new Error('No such mempool or blockchain transaction');
      if (txid === D) throw new Error('connection closed');
      return txid === A ? { txid, confirmations: 10 } : { txid };
    };
    const seen = new Map<string, ChainCheck>();
    await checkTransactions(request, 1000, [A, B, C, D, A], 2, (txid, check) => seen.set(txid, check));
    expect(asked.sort()).toEqual([A, B, C, D].sort());
    expect(most).toBe(2);
    expect(seen.get(A)).toEqual({ kind: 'confirmed', height: 991 });
    expect(seen.get(B)).toEqual({ kind: 'mempool' });
    expect(seen.get(C)).toEqual({ kind: 'unknown' });
    expect(seen.get(D)).toEqual({ kind: 'error', reason: 'connection closed' });
  });
});
