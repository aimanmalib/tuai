// "Confirmed on chain" checks on the activity page: what one Electrum answer about a transaction means, and asking about
// many transactions with a small number in flight. No DOM and no socket here, so the rules are unit tested.

export type ChainCheck =
  | { kind: 'confirmed'; height: number }
  | { kind: 'mempool' }
  | { kind: 'unknown' }
  | { kind: 'error'; reason: string };

/** One Electrum request; the socket's `request` in the page, a fake in tests. */
export type ElectrumRequest = (method: string, ...params: unknown[]) => Promise<unknown>;

const NOT_FOUND = /no such mempool or blockchain transaction|not found/i;

/**
 * Reads a verbose `blockchain.transaction.get` answer. Confirmed only when the server answered for this txid with a
 * positive confirmation count; the block is the tip minus the confirmations plus one.
 */
export function readVerdict(txid: string, tip: number, answer: unknown): ChainCheck {
  const a = answer as { txid?: unknown; confirmations?: unknown } | null;
  if (!a || typeof a !== 'object') return { kind: 'error', reason: 'no answer' };
  if (a.txid !== txid) return { kind: 'error', reason: 'the answer is for another transaction' };
  if (a.confirmations === undefined || a.confirmations === 0) return { kind: 'mempool' };
  if (typeof a.confirmations !== 'number' || !Number.isInteger(a.confirmations) || a.confirmations < 0 || a.confirmations > tip) {
    return { kind: 'error', reason: 'the confirmation count does not fit the chain tip' };
  }
  return { kind: 'confirmed', height: tip - a.confirmations + 1 };
}

/** A refused request: a transaction the server does not have, or any other failure with its message. */
export function readFailure(e: unknown): ChainCheck {
  const message = e instanceof Error ? e.message : String(e);
  return NOT_FOUND.test(message) ? { kind: 'unknown' } : { kind: 'error', reason: message.slice(0, 160) };
}

/**
 * Asks about every txid, at most `concurrency` at a time, reporting each verdict as it arrives. A verbose answer gives
 * confirmations, not a block, so the tip is read before and after each answer and the pair is read again when a block
 * arrived in between; otherwise the block shown would be one too low.
 */
export async function checkTransactions(
  request: ElectrumRequest,
  txids: readonly string[],
  concurrency: number,
  attempts: number,
  onResult: (txid: string, check: ChainCheck) => void,
): Promise<void> {
  const tip = async (): Promise<number> => {
    const answer = (await request('blockchain.headers.get_tip')) as { height?: unknown } | null;
    if (typeof answer?.height !== 'number') throw new Error('no chain tip in the answer');
    return answer.height;
  };
  const one = async (txid: string): Promise<ChainCheck> => {
    for (let i = 0; i < attempts; i++) {
      const before = await tip();
      const answer = await request('blockchain.transaction.get', txid, true);
      const after = await tip();
      if (before === after) return readVerdict(txid, after, answer);
    }
    return { kind: 'error', reason: `the chain tip kept moving, ${attempts} reads` };
  };
  const queue = [...new Set(txids)];
  const worker = async (): Promise<void> => {
    for (let txid = queue.shift(); txid !== undefined; txid = queue.shift()) {
      let check: ChainCheck;
      try {
        check = await one(txid);
      } catch (e) {
        check = readFailure(e);
      }
      onResult(txid, check);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
}
