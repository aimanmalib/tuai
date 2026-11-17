// Recognizes push distributions in decoded transactions: output 0 returns BCH change to the distributor and every
// other output pays the dust amount plus reward tokens of one category to a P2PKH recipient.
import { binToHex, decodeTransaction, hexToBin, type Output, type Transaction } from '@bitauth/libauth';

export interface DistributionMeasurement {
  txid: string;
  bytes: number;
  inputs: number;
  recipients: number;
  feeSats: number;
  dustSats: number;
}

const isP2pkh = (b: Uint8Array): boolean => b.length === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 0x14 && b[23] === 0x88 && b[24] === 0xac;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => binToHex(a) === binToHex(b);

export function decodeTx(hex: string): Transaction {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(`cannot decode transaction: ${tx}`);
  return tx;
}

/** Outpoint transaction ids of a transaction's inputs, in input order. */
export const inputTxids = (tx: Transaction): string[] => tx.inputs.map((i) => binToHex(i.outpointTransactionHash));

/** Output 0 is token-free P2PKH change and every later output pays `dustSats` and `category` tokens to a P2PKH script. */
export function hasDistributionShape(tx: Transaction, category: string, dustSats: bigint): boolean {
  const [change, ...paid] = tx.outputs;
  if (!change || change.token || !isP2pkh(change.lockingBytecode) || paid.length === 0) return false;
  return paid.every(
    (o) => o.valueSatoshis === dustSats && isP2pkh(o.lockingBytecode) && o.token?.nft === undefined && binToHex(o.token?.category ?? new Uint8Array()) === category,
  );
}

/**
 * Measures `hex` as a push distribution, or returns undefined when it does not have that shape.
 * `spent` holds the outputs spent by each input, in input order; every input must belong to the distributor.
 */
export function measureDistribution(
  txid: string,
  hex: string,
  spent: readonly Output[],
  category: string,
  dustSats: bigint,
): DistributionMeasurement | undefined {
  const tx = decodeTx(hex);
  if (!hasDistributionShape(tx, category, dustSats)) return undefined;
  const [change, ...paid] = tx.outputs;
  if (spent.length !== tx.inputs.length || !spent.every((o) => sameBytes(o.lockingBytecode, change!.lockingBytecode))) return undefined;
  const sum = (outs: readonly Output[]) => outs.reduce((s, o) => s + o.valueSatoshis, 0n);
  return {
    txid,
    bytes: hex.length / 2,
    inputs: tx.inputs.length,
    recipients: paid.length,
    feeSats: Number(sum(spent) - sum(tx.outputs)),
    dustSats: Number(sum(paid)),
  };
}
