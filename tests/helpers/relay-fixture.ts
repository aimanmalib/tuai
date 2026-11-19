// Shared fixture for the relayer tests: a mock pool with three leaves, a funded relayer key and a send counter.
import { binToHex } from '@bitauth/libauth';
import { randomUtxo } from 'cashscript';
import { loadConfig } from '../../src/config.ts';
import type { EpochFile } from '../../src/epoch/file.ts';
import { leafFromAddress, type Leaf } from '../../src/leaf.ts';
import type { ClaimPlan } from '../../src/tx/claim.ts';
import type { RelayConfig } from '../../src/relay/config.ts';
import { createRelay, type RelayDeps } from '../../src/relay/service.ts';
import { deployPool, stateFor, testKey, treeOf, type PoolFixture } from './pool-fixture.ts';

export const config = loadConfig();
export const alice = testKey('alice');
export const bob = testKey('bob');
export const mallory = testKey('mallory');
export const relayer = testKey('relayer');
export const leaves: Leaf[] = [leafFromAddress(alice.address, 100n), leafFromAddress(bob.address, 250n), leafFromAddress(testKey('c').address, 7n)];

export function epochFile(): EpochFile {
  const { tree, proof } = treeOf(leaves);
  return {
    epoch: 1,
    root: binToHex(tree.root),
    leaves: leaves.map((l, index) => ({
      index,
      address: null,
      method: l.method,
      cumulative: l.cumulative.toString(),
      lockingBytecode: binToHex(l.lockingBytecode),
      proof: proof(index).siblings.map(binToHex),
    })),
  } as unknown as EpochFile;
}

export interface Setup {
  f: PoolFixture;
  relay: ReturnType<typeof createRelay>;
  sends: () => number;
  clock: { ms: number };
}

export async function setup(o: { relay?: Partial<RelayConfig>; fund?: bigint; network?: string; off?: boolean; alterPlan?: (p: ClaimPlan) => void } = {}): Promise<Setup> {
  const file = epochFile();
  const f = await deployPool(stateFor(Uint8Array.from(Buffer.from(file.root, 'hex'))), undefined, undefined, null);
  if (o.fund !== 0n) f.provider.addUtxo(relayer.address, randomUtxo({ satoshis: o.fund ?? 50_000n }));
  let count = 0;
  const send = f.provider.sendRawTransaction.bind(f.provider);
  f.provider.sendRawTransaction = (hex: string) => {
    count += 1;
    return send(hex);
  };
  const clock = { ms: Date.parse('2026-11-19T00:00:00Z') };
  const deps: RelayDeps = {
    network: o.network ?? 'chipnet',
    relay: { ...config.relay, ...o.relay },
    fees: config.fees,
    prefix: 'bchtest',
    contracts: f.contracts,
    epochs: [file],
    key: relayer,
    provider: f.provider,
    now: () => new Date(clock.ms),
    off: o.off ?? false,
    ...(o.alterPlan ? { alterPlan: o.alterPlan } : {}),
  };
  return { f, relay: createRelay(deps), sends: () => count, clock };
}

export const tokensAt = async (f: PoolFixture, address: string) =>
  (await f.provider.getUtxos(address))
    .filter((u) => u.token?.category === f.contracts.params.rewardCategory && !u.token.nft)
    .reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);
