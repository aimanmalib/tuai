import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TransactionBuilder } from 'cashscript';
import { buildDeploy } from '../../tx/deploy.ts';
import { pushParamsFromConfig } from '../../pool/contracts.ts';
import { flag, requireFlag, type ParsedArgs } from '../args.ts';
import { broadcast } from '../broadcast.ts';
import { loadKey, operatorKeys, payerRole, type Context } from '../context.ts';
import { readRunLog, updateRunLog } from '../runs.ts';
import { genesisUtxo } from '../wallet.ts';

function vaultSats(a: ParsedArgs): { vaultSats?: bigint } {
  const value = flag(a, 'vault-sats');
  if (value === undefined) return {};
  if (!/^\d+$/.test(value)) throw new Error('--vault-sats must be a whole number of satoshis');
  return { vaultSats: BigInt(value) };
}

/** `token genesis --amount N`: creates a fungible test token held by the payer key. */
export async function tokenGenesis(ctx: Context, a: ParsedArgs) {
  const amount = BigInt(requireFlag(a, 'amount'));
  if (amount <= 0n) throw new RangeError('amount must be positive');
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const genesis = await genesisUtxo(ctx, payer);
  const builder = new TransactionBuilder({ provider: ctx.provider })
    .addInput(genesis, payer.signer.unlockP2PKH())
    .addOutput({ to: payer.address, amount: BigInt(ctx.config.fees.tokenOutputDustSats), token: { category: genesis.txid, amount } })
    .addBchChangeOutputIfNeeded({ to: payer.address, feeRate: ctx.config.fees.satsPerByte });
  const tx = await broadcast(ctx, builder, { kind: 'token-genesis', ownInputs: [genesis], ownLockingBytecode: payer.lockingBytecode });
  updateRunLog(ctx, (log) => {
    log.rewardCategory = genesis.txid;
  });
  return { category: genesis.txid, amount: amount.toString(), tx };
}

/**
 * `deploy [--vault-sats N] [--run <name>]`: moves all of the payer's reward tokens into a new pool with an empty root
 * (epoch 0). `--vault-sats` leaves that much BCH with the reward tokens, which operator pushes spend on dust and fees.
 */
export async function deploy(ctx: Context, a: ParsedArgs) {
  if (readRunLog(ctx).pool && !a.flags.has('force')) throw new Error(`a pool is already deployed on ${ctx.deployment}; pass --force to replace it, or --run <name> for a separate record`);
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const rewardCategory = flag(a, 'reward-category') ?? readRunLog(ctx).rewardCategory ?? ctx.config.networks[ctx.network].rewardCategory;
  if (!rewardCategory) throw new Error('no reward token category: run tuai token genesis or pass --reward-category');
  const all = await ctx.provider.getUtxos(payer.address);
  const rewardUtxos = all.filter((u) => u.token?.category === rewardCategory && !u.token.nft);
  if (rewardUtxos.length === 0) throw new Error(`the payer holds no tokens of category ${rewardCategory}`);
  const genesis = await genesisUtxo(ctx, payer, rewardUtxos);
  const params = {
    maxDepth: ctx.config.tree.maxDepth,
    operatorKeys: operatorKeys(ctx),
    activationDelay: ctx.config.networks[ctx.network].activationDelayBlocks,
    push: pushParamsFromConfig(ctx.config, ctx.config.networks[ctx.network].pushDelayBlocks),
  };
  const { builder, contracts } = buildDeploy({
    provider: ctx.provider,
    signer: payer.signer,
    payerAddress: payer.address,
    genesisUtxo: genesis,
    rewardUtxos,
    ...params,
    outputSats: BigInt(ctx.config.fees.tokenOutputDustSats),
    ...vaultSats(a),
    feeRate: ctx.config.fees.satsPerByte,
  });
  const tx = await broadcast(ctx, builder, { kind: 'deploy', ownInputs: [genesis, ...rewardUtxos], ownLockingBytecode: payer.lockingBytecode });
  const pool = { ...contracts.params, deployTxid: tx.txid as string };
  updateRunLog(ctx, (log) => {
    log.pool = pool;
  });
  const publicInfo = {
    network: ctx.network,
    ...pool,
    contracts: { pool: contracts.pool.tokenAddress, vault: contracts.vault.tokenAddress, gate: contracts.gate.tokenAddress },
  };
  if (ctx.network !== 'mock') {
    const dir = resolve(ctx.repoRoot, 'deployments', ctx.deployment);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'pool.json'), `${JSON.stringify(publicInfo, null, 1)}\n`);
  }
  return { ...publicInfo, tx };
}
