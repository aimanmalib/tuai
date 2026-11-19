// The chipnet demo relayer on the mock network (docs/decisions/0009-chipnet-relayer.md): it pays fee and dust, the
// reward goes to the leaf, foreign outputs are refused before sending, and it never runs on another network.
import { describe, expect, it } from 'vitest';
import type { Output } from 'cashscript';
import { readPool } from '../src/pool/utxos.ts';
import { planClaim } from '../src/tx/claim.ts';
import { validateRelay } from '../src/relay/config.ts';
import { checkClaimOutputs } from '../src/relay/guard.ts';
import { parseClaimBody } from '../src/relay/service.ts';
import { FEE_RATE, SATS } from './helpers/pool-fixture.ts';
import { alice, bob, config, epochFile, leaves, mallory, relayer, setup, tokensAt } from './helpers/relay-fixture.ts';
import type { Leaf } from '../src/leaf.ts';

describe('chipnet demo relayer', () => {
  it('pays the leaf exactly its cumulative amount; the relayer only pays fee and dust', async () => {
    const s = await setup();
    const before = (await s.relay.status()).body.balanceSats as number;
    const r = await s.relay.claim({ address: alice.address });
    expect(r.body.code, JSON.stringify(r.body)).toBe('claimed');
    expect(r.body.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(await tokensAt(s.f, alice.address)).toBe(100n);
    expect(await tokensAt(s.f, relayer.address)).toBe(0n);
    const after = (await s.relay.status()).body.balanceSats as number;
    const cap = config.relay.maxFeeSatsPerClaim + config.fees.tokenOutputDustSats + config.fees.receiptDustSats;
    expect(before - after).toBeGreaterThan(0);
    expect(before - after).toBeLessThanOrEqual(cap);
  });

  it('refuses a plan whose outputs pay a foreign script, before anything is sent', async () => {
    const s = await setup();
    const pool = await readPool(s.f.contracts);
    const plan = planClaim({
      contracts: s.f.contracts,
      pool,
      leaf: leaves[0] as Leaf,
      proof: { index: 0, siblings: epochFile().leaves[0]!.proof.map((h) => Uint8Array.from(Buffer.from(h, 'hex'))) },
      funding: { utxos: [], signer: relayer.signer, changeAddress: relayer.address },
      paymentSats: SATS,
      receiptSats: SATS,
      feeRate: FEE_RATE,
    });
    const scripts = {
      leaf: alice.lockingBytecode,
      pool: Uint8Array.from(Buffer.from(s.f.contracts.pool.lockingBytecode, 'hex')),
      vault: Uint8Array.from(Buffer.from(s.f.contracts.vault.lockingBytecode, 'hex')),
      relayer: relayer.lockingBytecode,
    };
    const expect100 = { rewardCategory: s.f.contracts.params.rewardCategory, payment: 100n };
    expect(checkClaimOutputs(plan.outputs, scripts, expect100)).toBeNull();
    const redirected = plan.outputs.map((o: Output, i) => (i === 2 ? { ...o, to: mallory.lockingBytecode } : o));
    expect(checkClaimOutputs(redirected, scripts, expect100)).toMatch(/not the leaf/);
    const toRelayer = plan.outputs.map((o: Output, i) => (i === 2 ? { ...o, to: relayer.lockingBytecode } : o));
    expect(checkClaimOutputs(toRelayer, scripts, expect100)).toMatch(/tokens to the relayer/);
    expect(checkClaimOutputs(plan.outputs, scripts, { ...expect100, payment: 99n })).toMatch(/would receive 100, not 99/);
    expect(s.sends()).toBe(0);
  });

  it('sends nothing when a plan would pay a foreign output', async () => {
    const s = await setup({ alterPlan: (p) => (p.outputs[2] = { ...(p.outputs[2] as Output), to: mallory.lockingBytecode }) });
    const r = await s.relay.claim({ address: alice.address });
    expect([r.status, r.body.code]).toEqual([500, 'guardRefused']);
    expect(s.sends()).toBe(0);
    expect(await tokensAt(s.f, mallory.address)).toBe(0n);
  });

  it('refuses to run on any network but chipnet, whatever the config says', async () => {
    await expect(setup({ network: 'mainnet' })).rejects.toThrow(/chipnet only/);
    await expect(setup({ relay: { networks: ['chipnet', 'mainnet'] } })).rejects.toThrow(/exactly \["chipnet"\]/);
    expect(validateRelay({ ...config.relay, networks: ['mainnet'] })).toContain('relay.networks must be exactly ["chipnet"]');
    expect(validateRelay(config.relay)).toEqual([]);
    expect(config.relay.networks).toEqual(['chipnet']);
  });

  it('keeps a global hourly limit', async () => {
    const s = await setup({ relay: { maxClaimsPerHour: 1 } });
    expect((await s.relay.claim({ address: alice.address })).body.code).toBe('claimed');
    const second = await s.relay.claim({ address: bob.address });
    expect([second.status, second.body.code]).toEqual([429, 'hourFull']);
    expect((await s.relay.status()).body).toMatchObject({ enabled: false, reason: 'hourFull' });
    s.clock.ms += 61 * 60 * 1000;
    expect((await s.relay.claim({ address: bob.address })).body.code).toBe('claimed');
  });

  it('switches off below the minimum balance and with the kill switch', async () => {
    const low = await setup({ fund: BigInt(config.relay.minBalanceSats - 1) });
    expect((await low.relay.status()).body).toMatchObject({ network: 'chipnet', enabled: false, reason: 'lowBalance' });
    expect((await low.relay.claim({ address: alice.address })).body.code).toBe('lowBalance');
    const off = await setup({ off: true });
    expect((await off.relay.status()).body).toMatchObject({ enabled: false, reason: 'off' });
    expect((await off.relay.claim({ address: alice.address })).status).toBe(503);
    expect(low.sends() + off.sends()).toBe(0);
  });

  it('answers nothing-to-claim without sending, and names addresses it cannot serve', async () => {
    const s = await setup();
    await s.relay.claim({ address: alice.address });
    const sent = s.sends();
    const again = await s.relay.claim({ address: alice.address });
    expect(again.body).toMatchObject({ code: 'nothingToClaim', claimed: '100' });
    expect(s.sends()).toBe(sent);
    expect((await s.relay.claim({ address: mallory.address })).body.code).toBe('notInEpoch');
    expect((await s.relay.claim({ address: 'nope' })).body.code).toBe('badAddress');
    expect((await s.relay.claim({ address: 1 })).body.code).toBe('badRequest');
    expect(parseClaimBody({ address: 'bitcoincash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2' }, 'bchtest')).toMatchObject({ body: { code: 'wrongNetwork' } });
  });

  it('claims again only to show the refusal: the contract refuses the duplicate receipt', async () => {
    const s = await setup();
    expect((await s.relay.claim({ address: bob.address, again: true })).body.code).toBe('notClaimedYet');
    await s.relay.claim({ address: bob.address });
    const r = await s.relay.claim({ address: bob.address, again: true });
    expect(r.body.code, JSON.stringify(r.body)).toBe('refused');
    expect(String(r.body.local)).toMatch(/ClaimPool|failed/);
    expect(String(r.body.network).length).toBeGreaterThan(0);
    expect(await tokensAt(s.f, bob.address)).toBe(250n);
  });
});
