import type { SpendableUtxo } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { ARM_FLAG, STATE_BYTES, decodeReceipt, decodeState, type PoolState, type Receipt } from './encoding.ts';
import type { PoolContracts } from './contracts.ts';

export interface ReceiptUtxo {
  utxo: SpendableUtxo;
  receipt: Receipt;
}

export interface PoolUtxos {
  state: SpendableUtxo;
  decodedState: PoolState;
  rewards: SpendableUtxo[];
  receipts: ReceiptUtxo[];
}

export const isStateUtxo = (u: SpendableUtxo, poolCategory: string): boolean =>
  u.token?.category === poolCategory && u.token.nft?.capability === 'minting';

export const isReceiptUtxo = (u: SpendableUtxo, poolCategory: string): boolean =>
  u.token?.category === poolCategory && u.token.nft?.capability === 'none';

export const isRewardUtxo = (u: SpendableUtxo, rewardCategory: string): boolean =>
  u.token?.category === rewardCategory && u.token.nft === undefined && u.token.amount > 0n;

/** The root gate's pending-root NFT: the only mutable NFT of the pool category. */
export const isPendingUtxo = (u: SpendableUtxo, poolCategory: string): boolean =>
  u.token?.category === poolCategory && u.token.nft?.capability === 'mutable';

export const receiptOf = (u: SpendableUtxo): Receipt => decodeReceipt(u.token?.nft?.commitment ?? '');

/** Reads the pool's state NFT, reward token UTXOs (largest first) and receipts from the network. */
export async function readPool(contracts: PoolContracts): Promise<PoolUtxos> {
  const { poolCategory, rewardCategory } = contracts.params;
  const states = (await contracts.pool.getUtxos()).filter((u) => isStateUtxo(u, poolCategory));
  if (states.length !== 1) throw new Error(`expected one pool state NFT, found ${states.length}`);
  const state = states[0] as SpendableUtxo;
  const vaultUtxos = await contracts.vault.getUtxos();
  const rewards = vaultUtxos
    .filter((u) => isRewardUtxo(u, rewardCategory))
    .sort((a, b) => (a.token?.amount ?? 0n) < (b.token?.amount ?? 0n) ? 1 : -1);
  const receipts = vaultUtxos.filter((u) => isReceiptUtxo(u, poolCategory)).map((utxo) => ({ utxo, receipt: receiptOf(utxo) }));
  return { state, decodedState: decodeState(state.token?.nft?.commitment ?? ''), rewards, receipts };
}

export interface PendingUtxo {
  utxo: SpendableUtxo;
  pending: PoolState;
  /** Armed for operator pushes (ADR 0008): the commitment is the active state followed by 0x01. */
  armed: boolean;
}

/** Reads the root gate's pending-root NFT. */
export async function readPending(contracts: PoolContracts): Promise<PendingUtxo> {
  const found = (await contracts.gate.getUtxos()).filter((u) => isPendingUtxo(u, contracts.params.poolCategory));
  if (found.length !== 1) throw new Error(`expected one pending-root NFT, found ${found.length}`);
  const utxo = found[0] as SpendableUtxo;
  const commitment = utxo.token?.nft?.commitment ?? '';
  const armed = commitment.length === (STATE_BYTES + 1) * 2 && commitment.endsWith(ARM_FLAG);
  return { utxo, pending: decodeState(armed ? commitment.slice(0, STATE_BYTES * 2) : commitment), armed };
}

/** Total reward tokens still held by the pool. */
export const poolBalance = (rewards: readonly SpendableUtxo[]): bigint =>
  rewards.reduce((sum, u) => sum + (u.token?.amount ?? 0n), 0n);

export const receiptKeyHex = (r: ReceiptUtxo): string => binToHex(r.receipt.key);
