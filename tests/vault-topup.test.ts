// A sponsor release sent to the vault address later must be claimable like the deploy-time funding (docs/INTEGRATION.md).
import { describe, expect, it } from 'vitest';
import { randomUtxo } from 'cashscript';
import { leafFromAddress } from '../src/leaf.ts';
import { poolBalance, readPool } from '../src/pool/utxos.ts';
import { REWARD_SUPPLY, SATS, claim, deployPool, stateFor, testKey, treeOf } from './helpers/pool-fixture.ts';

describe('vault top-up', () => {
  it('pays a claim larger than the deploy funding from reward tokens sent to the vault afterwards', async () => {
    const alice = testKey('alice');
    const due = REWARD_SUPPLY + 10n;
    const leaves = [leafFromAddress(alice.address, due), leafFromAddress(testKey('b').address, 1n)];
    const { tree, proof } = treeOf(leaves);
    const f = await deployPool(stateFor(tree.root));
    const category = f.contracts.params.rewardCategory;

    await expect(claim(f, leaves[0]!, proof(0), alice)).rejects.toThrow();

    const topUp = 2n * REWARD_SUPPLY;
    f.provider.addUtxo(f.contracts.vault.tokenAddress, randomUtxo({ satoshis: SATS, token: { category, amount: topUp } }));
    const before = poolBalance((await readPool(f.contracts)).rewards);
    expect(before).toBe(REWARD_SUPPLY + topUp);

    await claim(f, leaves[0]!, proof(0), alice);
    const paid = (await f.provider.getUtxos(alice.address))
      .filter((u) => u.token?.category === category && !u.token.nft)
      .reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);
    expect(paid).toBe(due);
    expect(poolBalance((await readPool(f.contracts)).rewards)).toBe(before - due);
  });
});
