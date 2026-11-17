import type { SpendableUtxo } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { decodeReceipt, decodeState, type PoolState, type Receipt } from './encoding.ts';
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

/** Total reward tokens still held by the pool. */
export const poolBalance = (rewards: readonly SpendableUtxo[]): bigint =>
  rewards.reduce((sum, u) => sum + (u.token?.amount ?? 0n), 0n);

export const receiptKeyHex = (r: ReceiptUtxo): string => binToHex(r.receipt.key);
