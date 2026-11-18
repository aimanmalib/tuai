import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TransactionBuilder } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { hexToBinChecked } from '../../bytes.ts';
import { demoLayout, syntheticAmount } from '../../demo/layout.ts';
import { lockingBytecodeToAddress } from '../../leaf.ts';
import { receiptKey } from '../../pool/encoding.ts';
import type { PoolUtxos } from '../../pool/utxos.ts';
import { assembleClaim } from '../../tx/claim.ts';
import { flag, requireFlag, type ParsedArgs } from '../args.ts';
import { broadcast, measure } from '../broadcast.ts';
import { prepareClaim } from './claim.ts';
import { loadKey, payerRole, type Context } from '../context.ts';
import { updateRunLog } from '../runs.ts';
import { plainUtxos, selectFunding } from '../wallet.ts';

const demoRoles = (ctx: Context): string[] => ctx.config.demo.keyIndices.map((_, i) => `demo-${i + 1}`);

/**
 * `demo allocations --round 1|2 --out <file>`: the demonstration tree's allocations. Round 1 places the project demo
 * keys at their configured indices among keyless synthetic leaves; round 2 adds a top-up to every demo key.
 */
export function demoAllocations(ctx: Context, a: ParsedArgs) {
  const d = ctx.config.demo;
  const round = Number(requireFlag(a, 'round'));
  if (round !== 1 && round !== 2) throw new Error('--round must be 1 or 2');
  const unit = 10n ** BigInt(ctx.config.rewards.decimals);
  const keys = demoRoles(ctx).map((r) => binToHex(loadKey(ctx, r).lockingBytecode));
  const isKey = new Set(keys);
  const rows =
    round === 2
      ? keys.map((k) => ({ lockingBytecode: k, amount: BigInt(d.topUpWhole) * unit }))
      : demoLayout({ demoKeys: keys, indices: d.keyIndices, leafCount: d.leafCount, label: d.label }).map((k) => ({
          lockingBytecode: k,
          amount: isKey.has(k) ? BigInt(d.keyAmountWhole) * unit : syntheticAmount(k, BigInt(d.syntheticMaxWhole), unit),
        }));
  const allocations = rows.map((r) => ({ address: lockingBytecodeToAddress(hexToBinChecked(r.lockingBytecode), ctx.prefix), amount: r.amount.toString() }));
  const out = resolve(requireFlag(a, 'out'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ allocations }, null, 1)}\n`);
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  return { out, round, allocations: allocations.length, demoKeys: keys.length, total: total.toString() };
}

/** `fund <role> --sats N`: sends plain BCH from the payer to another project key (never to an outside address). */
export async function fund(ctx: Context, a: ParsedArgs) {
  const role = a.positional[1];
  if (!role || !/^(demo|operator)-[0-9]+$/.test(role)) throw new Error('usage: tuai fund <demo-N|operator-N> --sats N');
  const to = loadKey(ctx, role);
  const sats = BigInt(flag(a, 'sats') ?? ctx.config.demo.otherPayerFundingSats);
  const payer = loadKey(ctx, flag(a, 'payer') ?? payerRole(ctx.network));
  const funding = selectFunding(await plainUtxos(ctx, payer), sats + 2_000n);
  const builder = new TransactionBuilder({ provider: ctx.provider })
    .addInputs(funding, payer.signer.unlockP2PKH())
    .addOutput({ to: to.address, amount: sats })
    .addBchChangeOutputIfNeeded({ to: payer.address, feeRate: ctx.config.fees.satsPerByte });
  const tx = await broadcast(ctx, builder, { kind: `fund-${role}`, ownInputs: funding, ownLockingBytecode: payer.lockingBytecode });
  return { to: to.address, sats: sats.toString(), tx };
}

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

/**
 * `demo double-claim <address> --epoch <file>`: attempts to claim an already claimed leaf a second time by
 * inserting a duplicate receipt. Checked by the local VM, then sent to the network (not on mock) so the node's
 * refusal is recorded too. Succeeds (exit 0) only when the attempt is refused.
 */
export async function demoDoubleClaim(ctx: Context, a: ParsedArgs) {
  const address = a.positional[2];
  if (!address) throw new Error('usage: tuai demo double-claim <address> --epoch <file>');
  const { entry, epoch, plan, funding, payer } = await prepareClaim(ctx, a, address, withoutOwnReceipt);
  const builder = assembleClaim(plan, ctx.provider);
  let local: string | null = null;
  try {
    builder.debug();
  } catch (e) {
    local = (e as Error).message.split('\n')[0]?.slice(0, 300) ?? 'refused';
  }
  const m = await measure(builder, { kind: 'double-claim', ownInputs: funding, ownLockingBytecode: payer.lockingBytecode });
  let network: string | null = null;
  let txid: string | null = null;
  if (ctx.network !== 'mock') {
    try {
      txid = await ctx.provider.sendRawTransaction(m.hex);
    } catch (e) {
      network = (e as Error).message.slice(0, 300);
    }
  }
  const refused = local !== null && (ctx.network === 'mock' || network !== null);
  updateRunLog(ctx, (log) =>
    log.txs.push({
      kind: `double-claim-epoch-${epoch}`,
      txid,
      bytes: m.bytes,
      feeSats: m.feeSats,
      spentSats: txid ? m.spentSats : 0,
      utc: ctx.now().toISOString(),
      error: `local: ${local ?? 'accepted'}; network: ${network ?? (ctx.network === 'mock' ? 'not sent' : 'accepted')}`,
      note: `leaf ${entry.index}`,
    }),
  );
  return { ok: refused, leaf: entry.index, localRefusal: local, networkRefusal: network, txid };
}
