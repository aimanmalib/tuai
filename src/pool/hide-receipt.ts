import { binToHex } from '@bitauth/libauth';
import { receiptKey } from './encoding.ts';
import type { PoolUtxos } from './utxos.ts';

/**
 * Hides a leaf's own receipt so the claim is planned as a first claim again: the predecessor's `next` is read as
 * if the receipt were absent. The contract reads the real commitment, so it must refuse the insertion.
 */
export function withoutOwnReceipt(pool: PoolUtxos, lockingBytecode: Uint8Array): PoolUtxos {
  const key = binToHex(receiptKey(lockingBytecode));
  const own = pool.receipts.find((r) => binToHex(r.receipt.key) === key);
  if (!own) throw new Error('this leaf has no receipt yet; claim it first');
  const receipts = pool.receipts
    .filter((r) => r !== own)
    .map((r) => (binToHex(r.receipt.next) === key ? { ...r, receipt: { ...r.receipt, next: own.receipt.next } } : r));
  return { ...pool, receipts };
}
