import { TransactionBuilder, type NetworkProvider, type SignatureTemplate, type SpendableUtxo } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { EMPTY_STATE, HEAD_RECEIPT, encodeReceipt, encodeState, type PoolState } from '../pool/encoding.ts';
import { poolContracts, type PoolContracts, type PushParams } from '../pool/contracts.ts';
import { splitAmount } from '../pool/shards.ts';

export interface DeployOptions {
  provider: NetworkProvider;
  signer: SignatureTemplate;
  /** Payer address; receives the BCH change. */
  payerAddress: string;
  /** BCH UTXO at output index 0 of its transaction; its txid becomes the pool token category. */
  genesisUtxo: SpendableUtxo;
  /** Reward token UTXOs held by the payer (one category, fungible only); all of them move into the vault. */
  rewardUtxos: SpendableUtxo[];
  maxDepth: number;
  /** Root gate: three operator public keys (hex) and the activation delay in blocks. */
  operatorKeys: readonly string[];
  activationDelay: number;
  /** Operator push path (ADR 0008); without it the pool uses the version 1 contracts. */
  push?: PushParams;
  /** Defaults to an empty root (epoch 0): nothing is claimable before the first root is activated. */
  initialState?: PoolState;
  /** Satoshis kept with each pool output (state NFT, head receipt, reward tokens). */
  outputSats: bigint;
  /** Satoshis kept with the reward tokens instead of `outputSats`; operator pushes take their dust and fee from them. */
  vaultSats?: bigint;
  feeRate: number;
  /** State NFT copies and reward token UTXOs (ADR 0013); claims on different shards do not conflict. Defaults to 1. */
  shards?: number;
}

export interface DeployPlan {
  builder: TransactionBuilder;
  contracts: PoolContracts;
}

/**
 * One transaction creates the pool: the minting state NFT (pool contract), the receipt list head and the
 * reward tokens (vault contract), and the pending-root NFT (gate contract) holding the same state.
 * Only the state NFTs hold minting rights, and only the pool script can move them. A sharded pool adds one more
 * state NFT and one more reward token UTXO per extra shard after the pending NFT; the reward tokens are split evenly.
 */
export function buildDeploy(o: DeployOptions): DeployPlan {
  if (o.genesisUtxo.vout !== 0 || o.genesisUtxo.token) throw new Error('genesis input must be a plain BCH output at index 0');
  const rewardCategory = o.rewardUtxos[0]?.token?.category;
  if (!rewardCategory) throw new Error('at least one reward token UTXO is needed');
  if (o.rewardUtxos.some((u) => u.token?.category !== rewardCategory || u.token.nft)) {
    throw new Error('reward UTXOs must all hold fungible tokens of one category');
  }
  const rewardAmount = o.rewardUtxos.reduce((sum, u) => sum + (u.token?.amount ?? 0n), 0n);
  const [firstAmount, ...otherAmounts] = splitAmount(rewardAmount, o.shards ?? 1);
  const poolCategory = o.genesisUtxo.txid;
  const contracts = poolContracts(
    {
      poolCategory,
      rewardCategory,
      maxDepth: o.maxDepth,
      operatorKeys: o.operatorKeys,
      activationDelay: o.activationDelay,
      ...(o.push ? { push: o.push } : {}),
    },
    o.provider,
  );
  const initial = binToHex(encodeState(o.initialState ?? EMPTY_STATE));
  const unlocker = o.signer.unlockP2PKH();
  const stateOutput = {
    to: contracts.pool.tokenAddress,
    amount: o.outputSats,
    token: { category: poolCategory, amount: 0n, nft: { capability: 'minting' as const, commitment: initial } },
  };
  const rewardOutput = (amount: bigint) => ({
    to: contracts.vault.tokenAddress,
    amount: o.vaultSats ?? o.outputSats,
    token: { category: rewardCategory, amount },
  });
  const builder = new TransactionBuilder({ provider: o.provider })
    .addInput(o.genesisUtxo, unlocker)
    .addInputs(o.rewardUtxos, unlocker)
    .addOutput(stateOutput)
    .addOutput({
      to: contracts.vault.tokenAddress,
      amount: o.outputSats,
      token: { category: poolCategory, amount: 0n, nft: { capability: 'none', commitment: binToHex(encodeReceipt(HEAD_RECEIPT)) } },
    })
    .addOutput(rewardOutput(firstAmount as bigint))
    .addOutput({
      to: contracts.gate.tokenAddress,
      amount: o.outputSats,
      token: { category: poolCategory, amount: 0n, nft: { capability: 'mutable', commitment: initial } },
    })
    .addOutputs(otherAmounts.flatMap((amount) => [stateOutput, rewardOutput(amount)]))
    .addBchChangeOutputIfNeeded({ to: o.payerAddress, feeRate: o.feeRate });
  return { builder, contracts };
}
