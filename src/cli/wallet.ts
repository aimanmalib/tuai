import { TransactionBuilder, type SpendableUtxo } from 'cashscript';
import { broadcast } from './broadcast.ts';
import type { Context, ProjectKey } from './context.ts';

/** BCH-only UTXOs of a key, largest first. */
export async function plainUtxos(ctx: Context, key: ProjectKey): Promise<SpendableUtxo[]> {
  const all = await ctx.provider.getUtxos(key.address);
  return all.filter((u) => !u.token).sort((a, b) => (a.satoshis < b.satoshis ? 1 : a.satoshis > b.satoshis ? -1 : 0));
}

export const balanceOf = (utxos: readonly SpendableUtxo[]): bigint => utxos.reduce((s, u) => s + u.satoshis, 0n);

/** Largest plain UTXOs whose total reaches `target` (all of them when it cannot be reached). */
export function selectFunding(utxos: readonly SpendableUtxo[], target: bigint): SpendableUtxo[] {
  const picked: SpendableUtxo[] = [];
  let sum = 0n;
  for (const u of utxos) {
    if (sum >= target) break;
    picked.push(u);
    sum += u.satoshis;
  }
  if (picked.length === 0) throw new Error('the paying key has no BCH to fund this transaction');
  return picked;
}

/**
 * Token categories come from a BCH output at index 0. Uses one when the key has it, otherwise sends the key's
 * coins to itself first so that output 0 of that transaction can serve.
 */
export async function genesisUtxo(ctx: Context, key: ProjectKey, exclude: readonly SpendableUtxo[] = []): Promise<SpendableUtxo> {
  const skip = new Set(exclude.map((u) => `${u.txid}:${u.vout}`));
  const plain = (await plainUtxos(ctx, key)).filter((u) => !skip.has(`${u.txid}:${u.vout}`));
  const ready = plain.find((u) => u.vout === 0);
  if (ready) return ready;
  if (plain.length === 0) throw new Error('the paying key has no BCH');
  const unlocker = key.signer.unlockP2PKH();
  const builder = new TransactionBuilder({ provider: ctx.provider })
    .addInputs(plain, unlocker)
    .addBchChangeOutputIfNeeded({ to: key.address, feeRate: ctx.config.fees.satsPerByte });
  const sent = await broadcast(ctx, builder, { kind: 'prepare-genesis', ownInputs: plain, ownLockingBytecode: key.lockingBytecode });
  const out = (await plainUtxos(ctx, key)).find((u) => u.txid === sent.txid && u.vout === 0);
  if (!out) throw new Error('the prepared genesis output is not visible yet; run the command again');
  return out;
}
