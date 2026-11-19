// Relayer auto-claims by opt-in threshold (docs/decisions/0010-relayer-auto-claim.md), on the mock network: below the
// threshold nothing is sent, at or above it the leaf is paid, a payment moved elsewhere fails in the contract itself,
// and no opt-in means no claim.
import { describe, expect, it } from 'vitest';
import { binToHex } from '@bitauth/libauth';
import type { Output } from 'cashscript';
import { readPool } from '../src/pool/utxos.ts';
import { assembleClaim, planClaim } from '../src/tx/claim.ts';
import { parseOptIns } from '../src/relay/optins.ts';
import { main } from '../src/cli/main.ts';
import type { Leaf } from '../src/leaf.ts';
import { alice, bob, config, epochFile, leaves, mallory, relayer, setup, tokensAt } from './helpers/relay-fixture.ts';
import { testKey } from './helpers/pool-fixture.ts';

const carol = testKey('c');
const optIn = (address: string, minAmount: bigint) => ({ address, minAmount });

describe('relayer auto-claim by opt-in threshold', () => {
  it('skips a leaf below its threshold and sends nothing', async () => {
    const s = await setup();
    const [r] = await s.relay.autoClaim([optIn(bob.address, 251n)]);
    expect(r).toMatchObject({ address: bob.address, code: 'belowThreshold', claimable: '250', minAmount: '251' });
    expect(s.sends()).toBe(0);
    expect(await tokensAt(s.f, bob.address)).toBe(0n);
  });

  it('claims for each leaf at or above its threshold; the reward reaches the leaf only', async () => {
    const s = await setup();
    const out = await s.relay.autoClaim([optIn(alice.address, 100n), optIn(bob.address, 1000n), optIn(carol.address, 5n)]);
    expect(out.map((r) => r.code)).toEqual(['claimed', 'belowThreshold', 'claimed']);
    expect(out[0]?.txid).toMatch(/^[0-9a-f]{64}$/);
    expect([await tokensAt(s.f, alice.address), await tokensAt(s.f, bob.address), await tokensAt(s.f, carol.address)]).toEqual([100n, 0n, 7n]);
    expect(await tokensAt(s.f, relayer.address)).toBe(0n);
    expect(s.sends()).toBe(2);
    const again = await s.relay.autoClaim([optIn(alice.address, 1n)]);
    expect(again[0]?.code).toBe('nothingToClaim');
    expect(s.sends()).toBe(2);
  });

  it('a dry run reports what it would claim and sends nothing', async () => {
    const s = await setup();
    const [r] = await s.relay.autoClaim([optIn(bob.address, 250n)], true);
    expect(r).toMatchObject({ code: 'wouldClaim', claimable: '250' });
    expect(s.sends()).toBe(0);
  });

  it('with no opt-ins it claims nothing, and leaves outside the epoch are named', async () => {
    const s = await setup();
    expect(await s.relay.autoClaim([])).toEqual([]);
    const [r] = await s.relay.autoClaim([optIn(mallory.address, 1n)]);
    expect(r?.code).toBe('notInEpoch');
    expect(s.sends()).toBe(0);
  });

  it('a relayer that moves the payment to itself is refused by the contract, not only by the guard', async () => {
    const s = await setup();
    const pool = await readPool(s.f.contracts);
    const funding = (await s.f.provider.getUtxos(relayer.address)).filter((u) => !u.token);
    const plan = planClaim({
      contracts: s.f.contracts,
      pool,
      leaf: leaves[0] as Leaf,
      proof: { index: 0, siblings: epochFile().leaves[0]!.proof.map((h) => Uint8Array.from(Buffer.from(h, 'hex'))) },
      funding: { utxos: funding, signer: relayer.signer, changeAddress: relayer.address },
      paymentSats: BigInt(config.fees.tokenOutputDustSats),
      receiptSats: BigInt(config.fees.receiptDustSats),
      feeRate: config.fees.satsPerByte,
    });
    const leafHex = binToHex(alice.lockingBytecode);
    const i = plan.outputs.findIndex((o: Output) => typeof o.to !== 'string' && binToHex(o.to) === leafHex);
    expect(i).toBe(2);
    expect(() => assembleClaim(plan, s.f.provider).debug()).not.toThrow();
    plan.outputs[i] = { ...(plan.outputs[i] as Output), to: relayer.lockingBytecode };
    expect(() => assembleClaim(plan, s.f.provider).debug()).toThrow(/ClaimPool.cash:\d+ Require statement failed[\s\S]*outputs\[2\]\.lockingBytecode/);
    expect(s.sends()).toBe(0);
  });

  it('reads opt-in files strictly and runs on chipnet only', async () => {
    const ok = parseOptIns({ network: 'chipnet', optIns: [{ address: alice.address, minAmount: '50' }] });
    expect(ok).toEqual([{ address: alice.address, minAmount: 50n }]);
    expect(() => parseOptIns({ network: 'mainnet', optIns: [] })).toThrow(/not chipnet/);
    expect(() => parseOptIns({ network: 'chipnet', optIns: [{ address: alice.address, minAmount: 50 }] })).toThrow(/positive whole number/);
    expect(() => parseOptIns({ network: 'chipnet', optIns: [{ address: alice.address, minAmount: '0' }] })).toThrow(/positive whole number/);
    const twice = [{ address: alice.address, minAmount: '1' }, { address: alice.address.toUpperCase(), minAmount: '2' }];
    expect(() => parseOptIns({ network: 'chipnet', optIns: twice })).toThrow(/listed twice/);
    const lines: string[] = [];
    const rc = await main(['relay', '--network', 'mainnet', '--optins', 'examples/relay-optins.json'], { out: (l) => lines.push(l) });
    expect(rc).toBe(1);
    expect(lines.join('\n')).toMatch(/chipnet only/);
  });
});
