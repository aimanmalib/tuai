// Reads the roots a deployment committed on chain and compares them with roots recomputed from the epoch files.
// The chain side comes from the recorded propose and activate transactions: each carries the pool state NFT
// (root, epoch, inputs hash) as an output of the pool category, so old epochs stay checkable after newer ones activate.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { binToHex } from '@bitauth/libauth';
import { decodeTx } from '../cost/distributions.ts';
import { verifyEpoch } from '../epoch/verify.ts';
import { decodeState, STATE_BYTES, type PoolState } from '../pool/encoding.ts';

export interface RecordedTransaction {
  kind: string;
  txid?: string;
}

export interface EpochOnChain {
  epoch: number;
  rootOnChain: string | null;
  rootRecomputed: string;
  inputsHashOnChain: string | null;
  inputsHashRecomputed: string;
}

export interface DeploymentWatch {
  network: string;
  epochs: EpochOnChain[];
  /** Every difference by name: a missing transaction, a state that disagrees between transactions, a mismatch. */
  findings: string[];
}

export type RawTransactionSource = (txid: string) => Promise<string>;

/** Pool state commitments carried by outputs of `poolCategory` in a raw transaction. */
export function statesInTransaction(hex: string, poolCategory: string): PoolState[] {
  return decodeTx(hex)
    .outputs.filter((o) => o.token && binToHex(o.token.category) === poolCategory && o.token.nft?.commitment.length === STATE_BYTES)
    .map((o) => decodeState(o.token!.nft!.commitment));
}

const EPOCH_FILE = /^epoch-(\d+)\.json$/;

export const epochFilesIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => EPOCH_FILE.test(f))
    .sort((a, b) => Number(EPOCH_FILE.exec(a)![1]) - Number(EPOCH_FILE.exec(b)![1]))
    .map((f) => join(dir, f));

/**
 * Compares every `epoch-N.json` in a deployment folder (`pool.json`, `transactions.json`, epoch files) with the
 * state its `propose-epoch-N` and `activate-epoch-N` transactions put on chain.
 */
export async function watchDeployment(dir: string, getRaw: RawTransactionSource): Promise<DeploymentWatch> {
  const pool = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8')) as { network: string; poolCategory: string };
  const recordsPath = join(dir, 'transactions.json');
  const records = existsSync(recordsPath)
    ? (JSON.parse(readFileSync(recordsPath, 'utf8')) as { transactions: RecordedTransaction[] }).transactions
    : [];
  const findings: string[] = [];
  const epochs: EpochOnChain[] = [];
  for (const path of epochFilesIn(dir)) {
    const v = verifyEpoch(path);
    for (const p of v.problems) findings.push(`epoch ${v.epoch}: ${p}`);
    const seen: PoolState[] = [];
    for (const kind of [`propose-epoch-${v.epoch}`, `activate-epoch-${v.epoch}`]) {
      const txids = records.filter((r) => r.kind === kind && r.txid).map((r) => r.txid!);
      if (txids.length === 0) findings.push(`epoch ${v.epoch}: no ${kind} transaction is recorded`);
      for (const txid of txids) {
        const states = statesInTransaction(await getRaw(txid), pool.poolCategory).filter((s) => s.epoch === v.epoch);
        if (states.length === 0) findings.push(`epoch ${v.epoch}: ${kind} ${txid} carries no pool state for this epoch`);
        seen.push(...states);
      }
    }
    const roots = new Set(seen.map((s) => binToHex(s.root)));
    const hashes = new Set(seen.map((s) => binToHex(s.inputsHash)));
    if (roots.size > 1 || hashes.size > 1) findings.push(`epoch ${v.epoch}: recorded transactions commit to different states`);
    const row: EpochOnChain = {
      epoch: v.epoch,
      rootOnChain: seen[0] ? binToHex(seen[0].root) : null,
      rootRecomputed: v.recomputedRoot,
      inputsHashOnChain: seen[0] ? binToHex(seen[0].inputsHash) : null,
      inputsHashRecomputed: v.recomputedInputsHash,
    };
    if (row.rootOnChain !== row.rootRecomputed) findings.push(`epoch ${v.epoch}: root on chain differs from the recomputed root`);
    if (row.inputsHashOnChain !== row.inputsHashRecomputed) findings.push(`epoch ${v.epoch}: inputs hash on chain differs from the recomputed one`);
    epochs.push(row);
  }
  if (epochs.length === 0) findings.push(`no epoch files in ${dir}`);
  return { network: pool.network, epochs, findings };
}
