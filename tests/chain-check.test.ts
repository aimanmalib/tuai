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

/** Fake Electrum: a tip that `blockDuringGet` moves by one block inside chosen `transaction.get` calls (1-based). */
function fakeChain(start: number, blocks: Record<string, number | undefined>, blockDuringGet: number[] = []) {
  let tip = start;
  let gets = 0;
  const asked: string[] = [];
  const request = async (method: string, ...params: unknown[]): Promise<unknown> => {
    if (method === 'blockchain.headers.get_tip') return { height: tip, hex: '00' };
    expect(method).toBe('blockchain.transaction.get');
    expect(params[1]).toBe(true);
    gets++;
    if (blockDuringGet.includes(gets)) tip++;
    const txid = String(params[0]);
    asked.push(txid);
    const block = blocks[txid];
    return block === undefined ? { txid } : { txid, confirmations: tip - block + 1 };
  };
  return { request, asked };
}

describe('checking many transactions', () => {
  it('asks once per txid, keeps at most the limit in flight, and reports confirmed, mempool and error', async () => {
    let inFlight = 0;
    let most = 0;
    const asked: string[] = [];
    const request = async (method: string, ...params: unknown[]): Promise<unknown> => {
      if (method === 'blockchain.headers.get_tip') return { height: 1000 };
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
    await checkTransactions(request, [A, B, C, D, A], 2, 5, (txid, check) => seen.set(txid, check));
    expect(asked.sort()).toEqual([A, B, C, D].sort());
    expect(most).toBe(2);
    expect(seen.get(A)).toEqual({ kind: 'confirmed', height: 991 });
    expect(seen.get(B)).toEqual({ kind: 'mempool' });
    expect(seen.get(C)).toEqual({ kind: 'unknown' });
    expect(seen.get(D)).toEqual({ kind: 'error', reason: 'connection closed' });
  });

  it('is not one block short when a block arrives while the server answers', async () => {
    // The first answer counts confirmations from tip 1001 although the tip read before it was 1000.
    const { request, asked } = fakeChain(1000, { [A]: 991 }, [1]);
    const seen = new Map<string, ChainCheck>();
    await checkTransactions(request, [A], 1, 5, (txid, check) => seen.set(txid, check));
    expect(seen.get(A)).toEqual({ kind: 'confirmed', height: 991 });
    expect(asked).toEqual([A, A]);
  });

  it('reports a tip that keeps moving instead of a guessed block', async () => {
    const { request } = fakeChain(1000, { [A]: 991 }, [1, 2, 3]);
    const seen = new Map<string, ChainCheck>();
    await checkTransactions(request, [A], 1, 3, (txid, check) => seen.set(txid, check));
    expect(seen.get(A)).toEqual({ kind: 'error', reason: 'the chain tip kept moving, 3 reads' });
  });

  it('reports every transaction as not checked when the tip cannot be read', async () => {
    const request = async (method: string): Promise<unknown> => (method === 'blockchain.headers.get_tip' ? null : { txid: A });
    const seen = new Map<string, ChainCheck>();
    await checkTransactions(request, [A, B], 2, 5, (txid, check) => seen.set(txid, check));
    expect(seen.get(A)).toEqual({ kind: 'error', reason: 'no chain tip in the answer' });
    expect(seen.get(B)).toEqual({ kind: 'error', reason: 'no chain tip in the answer' });
  });
});
