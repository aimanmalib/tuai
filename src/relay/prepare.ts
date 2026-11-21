// Wallet claims (docs/decisions/0012-wallet-claims.md). The relay plans an unsigned claim funded by coins of the
// user's own wallet: it reads those coins from the chain, never signs, never sends, and spends nothing of its own.
// The page checks every input and output before the wallet sees the transaction; the wallet signs and broadcasts.
import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { placeholderP2PKHUnlocker, type NetworkProvider, type SpendableUtxo } from 'cashscript';
import { leafFromJson, type EpochFile } from '../epoch/file.ts';
import { addressToLockingBytecode, type CashAddressPrefix } from '../leaf.ts';
import type { PoolContracts } from '../pool/contracts.ts';
import { assembleClaim, planClaim } from '../tx/claim.ts';
import { hexToBinChecked } from '../bytes.ts';
import { assertWalletNetwork, type RelayConfig } from './config.ts';
import { checkClaimOutputs, scriptOf } from './guard.ts';
import { HourlyLimit, SerialQueue } from './limits.ts';
import { firstLine, lookupLeaf, reply, withTimeout, type RelayReply } from './lookup.ts';
import { parseAddress } from './service.ts';

export interface PrepareDeps {
  network: string;
  relay: RelayConfig;
  fees: { satsPerByte: number; tokenOutputDustSats: number; receiptDustSats: number };
  prefix: CashAddressPrefix;
  contracts: PoolContracts;
  epochs: readonly EpochFile[];
  provider: NetworkProvider;
  now: () => Date;
  off: boolean;
}

export interface PrepareRequest {
  leaf: Uint8Array;
  change: string;
  wallet: string[];
}

/** Parses `{ address, change, wallet: [address...] }`; every address must be a CashAddr of the prepare route's network. */
export function parsePrepareBody(body: unknown, prefix: CashAddressPrefix, maxAddresses: number): PrepareRequest | RelayReply {
  const b = body as { address?: unknown; change?: unknown; wallet?: unknown } | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.wallet) || b.wallet.length === 0) return reply(400, 'badRequest');
  if (b.wallet.length > maxAddresses) return reply(400, 'tooManyAddresses', { max: maxAddresses });
  const leaf = parseAddress(b.address, prefix);
  if ('status' in leaf) return leaf;
  const change = parseAddress(b.change, prefix);
  if ('status' in change) return change;
  const wallet: string[] = [];
  for (const w of b.wallet) {
    const a = parseAddress(w, prefix);
    if ('status' in a) return a;
    if (!wallet.includes(a.address)) wallet.push(a.address);
  }
  if (!wallet.includes(change.address)) return reply(400, 'changeNotInWallet');
  return { leaf: leaf.lockingBytecode, change: change.address, wallet };
}

/** JSON form of one source output; the page turns it back into bytes and checks it. */
export interface SourceOutputJson {
  lockingBytecode: string;
  valueSatoshis: string;
  token?: { category: string; amount: string; nft?: { capability: string; commitment: string } };
}

export function createPrepare(d: PrepareDeps) {
  assertWalletNetwork(d.network, d.relay.wallet);
  const w = d.relay.wallet;
  const limit = new HourlyLimit(w.maxPreparesPerHour, d.now);
  const queue = new SerialQueue();
  const ms = d.relay.electrumTimeoutSeconds * 1000;
  const scripts = { pool: hexToBin(d.contracts.pool.lockingBytecode), vault: hexToBin(d.contracts.vault.lockingBytecode) };

  async function coins(addresses: readonly string[]): Promise<(SpendableUtxo & { address: string })[]> {
    const out = [];
    for (const address of addresses) {
      for (const u of await withTimeout(d.provider.getUtxos(address), ms)) if (!u.token) out.push({ ...u, address });
    }
    return out.sort((a, b) => (a.satoshis < b.satoshis ? 1 : a.satoshis > b.satoshis ? -1 : 0));
  }

  async function attempt(r: PrepareRequest): Promise<RelayReply> {
    const found = await lookupLeaf(d.contracts, d.epochs, r.leaf, ms);
    if ('status' in found) return found;
    const { pool, entry, claimed, claimable } = found;
    if (claimable === 0n) return reply(200, 'nothingToClaim', { claimed: claimed.toString() });
    const picked: (SpendableUtxo & { address: string })[] = [];
    let sum = 0n;
    for (const c of await coins(r.wallet)) {
      if (sum >= BigInt(w.maxSpendSats)) break;
      picked.push(c);
      sum += c.satoshis;
    }
    if (sum === 0n) return reply(200, 'walletEmpty', { needSats: w.maxSpendSats });
    const plan = planClaim({
      contracts: d.contracts,
      pool,
      leaf: leafFromJson(entry),
      proof: { index: entry.index, siblings: entry.proof.map((s) => hexToBinChecked(s, 32)) },
      funding: { utxos: picked, signer: (u) => placeholderP2PKHUnlocker((u as SpendableUtxo & { address: string }).address), changeAddress: r.change },
      paymentSats: BigInt(d.fees.tokenOutputDustSats),
      receiptSats: BigInt(d.fees.receiptDustSats),
      feeRate: d.fees.satsPerByte,
    });
    const builder = assembleClaim(plan, d.provider);
    const change = addressToLockingBytecode(r.change);
    const refused = checkClaimOutputs(builder.outputs, { ...scripts, leaf: r.leaf, relayer: change }, {
      rewardCategory: d.contracts.params.rewardCategory,
      payment: claimable,
    });
    if (refused) return reply(500, 'guardRefused', { message: refused });
    let wc;
    try {
      wc = builder.generateWcTransactionObject({ broadcast: true });
    } catch (e) {
      return reply(200, 'walletShort', { needSats: w.maxSpendSats, message: firstLine(e) });
    }
    const back = builder.outputs.filter((o) => scriptOf(o.to) === binToHex(change) && !o.token);
    const spend = sum - back.reduce((s, o) => s + o.amount, 0n);
    if (spend > BigInt(w.maxSpendSats)) return reply(500, 'spendTooHigh', { spendSats: Number(spend) });
    const sourceOutputs: SourceOutputJson[] = wc.sourceOutputs.map((o) => ({
      lockingBytecode: binToHex(o.lockingBytecode),
      valueSatoshis: o.valueSatoshis.toString(),
      ...(o.token
        ? {
            token: {
              category: binToHex(o.token.category),
              amount: o.token.amount.toString(),
              ...(o.token.nft ? { nft: { capability: o.token.nft.capability, commitment: binToHex(o.token.nft.commitment) } } : {}),
            },
          }
        : {}),
    }));
    return reply(200, 'prepared', {
      tx: binToHex(encodeTransaction(wc.transaction)),
      sourceOutputs,
      kind: plan.kind,
      payment: claimable.toString(),
      spendSats: Number(spend),
    });
  }

  async function prepare(body: unknown): Promise<RelayReply> {
    if (d.off || !d.relay.enabled || !w.enabled) return reply(503, 'off');
    const parsed = parsePrepareBody(body, d.prefix, w.maxAddresses);
    if ('status' in parsed) return parsed;
    if (!limit.take()) return reply(429, 'hourFull');
    return queue.run(() => attempt(parsed));
  }

  return { prepare };
}

export type Prepare = ReturnType<typeof createPrepare>;
