// Wallet claims (docs/decisions/0012-wallet-claims.md), end to end in process: the relay prepares an unsigned claim
// funded by the wallet's own coins, the page checks it, a fake wallet signs the inputs the page names, and the mock
// network (full VM validation) accepts it. A relay that tampers with the plan is refused before the wallet signs.
import { describe, expect, it } from 'vitest';
import { binToHex, decodeTransaction, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { randomUtxo } from 'cashscript';
import { validateWallet } from '../src/relay/config.ts';
import { createPrepare, parsePrepareBody, type PrepareDeps } from '../src/relay/prepare.ts';
import { checkPrepared, type CheckContext, type PreparedJson, type WalletAddress } from '../web/src/wallet-check.ts';
import { fakeWallet } from './helpers/fake-wallet.ts';
import { alice, bob, config, epochFile, mallory, relayer, setup, tokensAt, type Setup } from './helpers/relay-fixture.ts';

const wallet = fakeWallet('wallet');
const addr = (path: string, index: number): WalletAddress => {
  const k = wallet.key(path, index);
  return { address: k.address, lockingBytecode: k.lockingBytecode, path, index };
};
const receive0 = addr('receive', 0);
const change0 = addr('change', 0);
const W = config.relay.wallet;

async function world(o: { fund?: bigint; off?: boolean } = {}) {
  const s = await setup();
  if (o.fund !== 0n) s.f.provider.addUtxo(receive0.address, randomUtxo({ satoshis: o.fund ?? 20_000n }));
  const deps: PrepareDeps = {
    network: 'chipnet',
    relay: config.relay,
    fees: config.fees,
    prefix: 'bchtest',
    contracts: s.f.contracts,
    epochs: [epochFile()],
    provider: s.f.provider,
    now: () => new Date(s.clock.ms),
    off: o.off ?? false,
  };
  return { s, prepare: createPrepare(deps).prepare };
}

const body = (leaf: string) => ({ address: leaf, change: change0.address, wallet: [receive0.address, change0.address] });

function context(s: Setup, leaf: Uint8Array, claimable: bigint): CheckContext {
  return {
    leaf,
    pool: hexToBin(s.f.contracts.pool.lockingBytecode),
    vault: hexToBin(s.f.contracts.vault.lockingBytecode),
    rewardCategory: s.f.contracts.params.rewardCategory,
    claimable,
    wallet: [receive0, change0],
    change: change0.lockingBytecode,
    maxSpendSats: BigInt(W.maxSpendSats),
    userPrompt: 'claim',
  };
}

/** Rewrites one output of a prepared transaction, as a dishonest relay would. */
function tamper(p: PreparedJson, i: number, edit: (o: { lockingBytecode: Uint8Array; valueSatoshis: bigint }) => void): PreparedJson {
  const tx = decodeTransaction(hexToBin(p.tx));
  if (typeof tx === 'string') throw new Error(tx);
  edit(tx.outputs[i] as { lockingBytecode: Uint8Array; valueSatoshis: bigint });
  return { ...p, tx: binToHex(encodeTransaction(tx)) };
}

describe('wallet claims', () => {
  it('the wallet signs and pays; the leaf gets exactly its amount; the relay spends nothing of its own', async () => {
    const { s, prepare } = await world();
    const relayBefore = (await s.f.provider.getUtxos(relayer.address)).reduce((t, u) => t + u.satoshis, 0n);
    const r = await prepare(body(alice.address));
    expect(r.body.code, JSON.stringify(r.body)).toBe('prepared');
    expect(s.sends()).toBe(0);
    const checked = checkPrepared(r.body as unknown as PreparedJson, context(s, alice.lockingBytecode, 100n));
    if ('refused' in checked) throw new Error(checked.refused);
    expect(checked.inputPaths).toEqual([[3, 'receive', 0]]);
    expect(checked.spendSats).toBeGreaterThan(0n);
    expect(checked.spendSats).toBeLessThanOrEqual(BigInt(W.maxSpendSats));
    const signed = wallet.sign(checked.request, checked.inputPaths);
    await s.f.provider.sendRawTransaction(signed);
    expect(await tokensAt(s.f, alice.address)).toBe(100n);
    expect(await tokensAt(s.f, change0.address)).toBe(0n);
    const relayAfter = (await s.f.provider.getUtxos(relayer.address)).reduce((t, u) => t + u.satoshis, 0n);
    expect(relayAfter).toBe(relayBefore);
    const again = await prepare(body(alice.address));
    expect(again.body.code).toBe('nothingToClaim');
  });

  it('a signature from the wrong key is refused by the network', async () => {
    const { s, prepare } = await world();
    const r = await prepare(body(bob.address));
    const checked = checkPrepared(r.body as unknown as PreparedJson, context(s, bob.lockingBytecode, 250n));
    if ('refused' in checked) throw new Error(checked.refused);
    const wrongPath = checked.inputPaths.map(([i]) => [i, 'change', 0] as [number, string, number]);
    await expect(s.f.provider.sendRawTransaction(wallet.sign(checked.request, wrongPath))).rejects.toThrow();
    expect(await tokensAt(s.f, bob.address)).toBe(0n);
  });

  it('the page refuses a prepared claim that pays someone else, before the wallet sees it', async () => {
    const { s, prepare } = await world();
    const r = await prepare(body(alice.address));
    const p = r.body as unknown as PreparedJson;
    const ctx = context(s, alice.lockingBytecode, 100n);
    const redirected = tamper(p, 2, (o) => (o.lockingBytecode = mallory.lockingBytecode));
    expect(checkPrepared(redirected, ctx)).toEqual({ refused: expect.stringMatching(/not the leaf/) });
    const tx = decodeTransaction(hexToBin(p.tx));
    if (typeof tx === 'string') throw new Error(tx);
    const changeAt = tx.outputs.findIndex((o) => binToHex(o.lockingBytecode) === binToHex(change0.lockingBytecode));
    const skimmed = tamper(p, changeAt, (o) => (o.lockingBytecode = mallory.lockingBytecode));
    expect(checkPrepared(skimmed, ctx)).toEqual({ refused: expect.stringMatching(/not the leaf/) });
    const costly = tamper(p, changeAt, (o) => (o.valueSatoshis -= BigInt(W.maxSpendSats)));
    expect(checkPrepared(costly, ctx)).toEqual({ refused: expect.stringMatching(/more than/) });
    expect(checkPrepared(p, { ...ctx, claimable: 99n })).toEqual({ refused: expect.stringMatching(/would receive 100, not 99/) });
  });

  it('the page refuses inputs that are neither the pool nor its own wallet', async () => {
    const { s, prepare } = await world();
    const p = (await prepare(body(alice.address))).body as unknown as PreparedJson;
    const ctx = context(s, alice.lockingBytecode, 100n);
    const foreign = { ...p, sourceOutputs: p.sourceOutputs.map((o, i) => (i === 3 ? { ...o, lockingBytecode: binToHex(mallory.lockingBytecode) } : o)) };
    expect(checkPrepared(foreign, ctx)).toEqual({ refused: expect.stringMatching(/neither the pool nor the wallet/) });
    expect(checkPrepared({ ...p, sourceOutputs: p.sourceOutputs.slice(1) }, ctx)).toEqual({ refused: 'source outputs do not match the inputs' });
    expect(checkPrepared(p, { ...ctx, change: mallory.lockingBytecode })).toEqual({
      refused: 'the change address is not one of the wallet addresses',
    });
  });

  it('names an empty wallet, a leaf outside the epoch and the off switch; never sends', async () => {
    const empty = await world({ fund: 0n });
    expect((await empty.prepare(body(alice.address))).body).toMatchObject({ code: 'walletEmpty' });
    const { s, prepare } = await world();
    expect((await prepare(body(mallory.address))).body.code).toBe('notInEpoch');
    const off = await world({ off: true });
    expect((await off.prepare(body(alice.address))).status).toBe(503);
    expect(s.sends() + empty.s.sends() + off.s.sends()).toBe(0);
  });

  it('parses requests strictly and keeps wallet settings in config', () => {
    const ok = parsePrepareBody(body(alice.address), 'bchtest', W.maxAddresses);
    expect('status' in ok).toBe(false);
    expect(parsePrepareBody({ ...body(alice.address), wallet: [] }, 'bchtest', 6)).toMatchObject({ status: 400 });
    expect(parsePrepareBody({ ...body(alice.address), wallet: Array(7).fill(receive0.address) }, 'bchtest', 6)).toMatchObject({
      body: { code: 'tooManyAddresses' },
    });
    expect(parsePrepareBody({ ...body(alice.address), change: mallory.address }, 'bchtest', 6)).toMatchObject({ body: { code: 'changeNotInWallet' } });
    expect(parsePrepareBody({ ...body('bitcoincash:qqyuz8zh06c8h39guuedjpfvnlvjeg394ucvfe6ltt') }, 'bchtest', 6)).toMatchObject({
      body: { code: 'wrongNetwork' },
    });
    expect(validateWallet(W)).toEqual([]);
    expect(validateWallet({ ...W, relayUrls: ['http://x'] })).toContain('relay.wallet.relayUrls must list wss:// URLs');
  });
});
