// The demo relayer's logic, without HTTP: it pays the fee and dust of a claim from its own chipnet key. The
// contracts send the reward tokens to the leaf's own locking bytecode; the relayer cannot direct them anywhere else.
import { binToHex, decodeCashAddress, hexToBin } from '@bitauth/libauth';
import type { NetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { findLeaf, leafFromJson, type EpochFile, type LeafJson } from '../epoch/file.ts';
import { addressToLockingBytecode, type CashAddressPrefix } from '../leaf.ts';
import { findReceipt, receiptKey } from '../pool/encoding.ts';
import type { PoolContracts } from '../pool/contracts.ts';
import { withoutOwnReceipt } from '../pool/hide-receipt.ts';
import { readPool, type PoolUtxos } from '../pool/utxos.ts';
import { assembleClaim, planClaim, type ClaimPlan } from '../tx/claim.ts';
import { hexToBinChecked } from '../bytes.ts';
import { assertRelayNetwork, type RelayConfig } from './config.ts';
import { checkClaimOutputs } from './guard.ts';
import { HourlyLimit, SerialQueue } from './limits.ts';

export interface RelayKey {
  signer: SignatureTemplate;
  lockingBytecode: Uint8Array;
  address: string;
}

export interface RelayDeps {
  network: string;
  relay: RelayConfig;
  fees: { satsPerByte: number; tokenOutputDustSats: number; receiptDustSats: number };
  prefix: CashAddressPrefix;
  contracts: PoolContracts;
  /** Epoch files of the deployment; a claim uses the one holding the pool's active root. */
  epochs: readonly EpochFile[];
  key: RelayKey;
  provider: NetworkProvider;
  now: () => Date;
  /** Kill switch (relay.offEnv=1). */
  off: boolean;
  /** Tests only: alters a plan before it is checked, to prove the output guard refuses it. */
  alterPlan?: (plan: ClaimPlan) => void;
}

export interface RelayReply {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, code: string, extra: Record<string, unknown> = {}): RelayReply => ({ status, body: { code, ...extra } });
const firstLine = (e: unknown): string => ((e as Error).message ?? String(e)).split('\n')[0]?.slice(0, 300) ?? 'error';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the chain server did not answer in time')), ms)));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Parses `{ address, again? }`; the address must be a CashAddr of the relay network. */
export function parseClaimBody(body: unknown, prefix: CashAddressPrefix): { lockingBytecode: Uint8Array; again: boolean } | RelayReply {
  const b = body as { address?: unknown; again?: unknown } | null;
  if (!b || typeof b !== 'object' || typeof b.address !== 'string' || b.address.length > 128) return reply(400, 'badRequest');
  if (b.again !== undefined && typeof b.again !== 'boolean') return reply(400, 'badRequest');
  const raw = b.address.trim().toLowerCase();
  const full = raw.includes(':') ? raw : `${prefix}:${raw}`;
  const decoded = decodeCashAddress(full);
  if (typeof decoded === 'string') return reply(400, 'badAddress');
  if (decoded.prefix !== prefix) return reply(400, 'wrongNetwork');
  return { lockingBytecode: addressToLockingBytecode(full), again: b.again === true };
}

export function createRelay(d: RelayDeps) {
  assertRelayNetwork(d.network, d.relay);
  const limit = new HourlyLimit(d.relay.maxClaimsPerHour, d.now);
  const queue = new SerialQueue();
  const ms = d.relay.electrumTimeoutSeconds * 1000;
  const perClaim = BigInt(d.relay.maxFeeSatsPerClaim + d.fees.tokenOutputDustSats + d.fees.receiptDustSats);
  const params = d.contracts.params;
  const scripts = {
    pool: hexToBin(d.contracts.pool.lockingBytecode),
    vault: hexToBin(d.contracts.vault.lockingBytecode),
    relayer: d.key.lockingBytecode,
  };

  async function funds() {
    const utxos = (await withTimeout(d.provider.getUtxos(d.key.address), ms)).filter((u) => !u.token);
    utxos.sort((a, b) => (a.satoshis < b.satoshis ? 1 : a.satoshis > b.satoshis ? -1 : 0));
    return { utxos, balance: utxos.reduce((s, u) => s + u.satoshis, 0n) };
  }

  function offReason(balance: bigint): string | null {
    if (d.off || !d.relay.enabled) return 'off';
    if (balance < BigInt(d.relay.minBalanceSats)) return 'lowBalance';
    if (limit.used() >= d.relay.maxClaimsPerHour) return 'hourFull';
    return null;
  }

  async function status(): Promise<RelayReply> {
    const { balance } = await funds();
    const reason = offReason(balance);
    return {
      status: 200,
      body: {
        network: d.network,
        enabled: reason === null,
        ...(reason ? { reason } : {}),
        address: d.key.address,
        balanceSats: Number(balance),
        claimsLeft: Number(balance / perClaim),
        claimsThisHour: limit.used(),
        maxClaimsPerHour: d.relay.maxClaimsPerHour,
        minBalanceSats: d.relay.minBalanceSats,
      },
    };
  }

  const fileFor = (pool: PoolUtxos): EpochFile | undefined =>
    d.epochs.find((f) => f.root === binToHex(pool.decodedState.root) && f.epoch === pool.decodedState.epoch);

  function plan(pool: PoolUtxos, entry: LeafJson, funding: Awaited<ReturnType<typeof funds>>['utxos']) {
    const picked = [];
    let sum = 0n;
    for (const u of funding) {
      if (sum >= perClaim) break;
      picked.push(u);
      sum += u.satoshis;
    }
    const p = planClaim({
      contracts: d.contracts,
      pool,
      leaf: leafFromJson(entry),
      proof: { index: entry.index, siblings: entry.proof.map((s) => hexToBinChecked(s, 32)) },
      funding: { utxos: picked, signer: d.key.signer, changeAddress: d.key.address },
      paymentSats: BigInt(d.fees.tokenOutputDustSats),
      receiptSats: BigInt(d.fees.receiptDustSats),
      feeRate: d.fees.satsPerByte,
    });
    d.alterPlan?.(p);
    return p;
  }

  /** Builds and checks a claim: the output guard and the fee cap, before any broadcast. */
  async function checked(builder: TransactionBuilder, leaf: Uint8Array, payment: bigint): Promise<{ hex: string } | RelayReply> {
    const refused = checkClaimOutputs(builder.outputs, { ...scripts, leaf }, { rewardCategory: params.rewardCategory, payment });
    if (refused) return reply(500, 'guardRefused', { message: refused });
    const hex = await builder.build();
    const fee = builder.inputs.reduce((s, i) => s + i.satoshis, 0n) - builder.outputs.reduce((s, o) => s + o.amount, 0n);
    if (fee > BigInt(d.relay.maxFeeSatsPerClaim)) return reply(500, 'feeTooHigh', { feeSats: Number(fee) });
    return { hex };
  }

  async function attempt(lockingBytecode: Uint8Array, again: boolean): Promise<RelayReply> {
    const { utxos, balance } = await funds();
    const reason = offReason(balance);
    if (reason === 'off' || reason === 'lowBalance') return reply(503, reason);
    const pool = await withTimeout(readPool(d.contracts), ms);
    const file = fileFor(pool);
    if (!file) return reply(503, 'epochMissing', { epoch: pool.decodedState.epoch });
    const entry = findLeaf(file, binToHex(lockingBytecode));
    if (!entry) return reply(404, 'notInEpoch', { epoch: file.epoch });
    const own = findReceipt(pool.receipts, (r) => r.receipt, receiptKey(lockingBytecode));
    const claimed = own?.kind === 'own' ? own.receipt.claimed : 0n;
    const cumulative = BigInt(entry.cumulative);
    const claimable = cumulative > claimed ? cumulative - claimed : 0n;
    if (!again && claimable === 0n) return reply(200, 'nothingToClaim', { claimed: claimed.toString() });
    if (again && claimed === 0n) return reply(409, 'notClaimedYet');
    if (!limit.take()) return reply(429, 'hourFull');

    if (!again) {
      const p = plan(pool, entry, utxos);
      const builder = assembleClaim(p, d.provider);
      const ok = await checked(builder, lockingBytecode, claimable);
      if ('status' in ok) return ok;
      try {
        builder.debug();
        const txid = await withTimeout(d.provider.sendRawTransaction(ok.hex), ms);
        return reply(200, 'claimed', { txid, kind: p.kind, paid: claimable.toString(), bytes: ok.hex.length / 2 });
      } catch (e) {
        return reply(502, 'nodeRefused', { message: firstLine(e) });
      }
    }

    // Claim again: plan as if the leaf's receipt were absent, so a duplicate receipt is inserted. The contract must refuse.
    const p = plan(withoutOwnReceipt(pool, lockingBytecode), entry, utxos);
    const builder = assembleClaim(p, d.provider);
    const ok = await checked(builder, lockingBytecode, p.payment);
    if ('status' in ok) return ok;
    let local: string;
    try {
      builder.debug();
      return reply(500, 'notRefusedLocally');
    } catch (e) {
      local = firstLine(e);
    }
    try {
      const txid = await withTimeout(d.provider.sendRawTransaction(ok.hex), ms);
      return reply(500, 'acceptedAgain', { txid, local });
    } catch (e) {
      return reply(200, 'refused', { local, network: firstLine(e) });
    }
  }

  async function claim(body: unknown): Promise<RelayReply> {
    const parsed = parseClaimBody(body, d.prefix);
    if ('status' in parsed) return parsed;
    return queue.run(() => attempt(parsed.lockingBytecode, parsed.again));
  }

  return { status, claim };
}

export type Relay = ReturnType<typeof createRelay>;
