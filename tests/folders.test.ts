// The real-folder count on the mainnet card (web/src/folders.ts). The frozen fixture uses addresses generated from test
// hashes; the committed mainnet epoch is checked against its own leaves, not against a fixed number.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { binToHex, encodeBase58Address, hexToBin } from '@bitauth/libauth';
import { sha256 } from '../src/bytes.ts';
import { LinkMethod, lockingBytecodeToAddress } from '../src/leaf.ts';
import { distroInputFiles, realFolders, type EpochForFolders } from '../web/src/folders.ts';

const hash = (label: string): Uint8Array => sha256(new TextEncoder().encode(label)).slice(0, 20);
const script = (label: string): string => `76a914${binToHex(hash(label))}88ac`;
const legacy = (label: string): string => encodeBase58Address('p2pkh', hash(label));
const cash = (label: string): string => lockingBytecodeToAddress(hexToBin(script(label)));

const leaf = (label: string, method: number) => ({ lockingBytecode: script(label), method });
const EPOCH: EpochForFolders = {
  epoch: 4,
  leaves: [leaf('demo', LinkMethod.fahName), leaf('cash folder', LinkMethod.fahName), leaf('old folder', LinkMethod.legacyBtcName),
    leaf('both months', LinkMethod.fahName), leaf('carried', LinkMethod.fahName)],
  manifest: {
    inputs: [{ file: 'inputs/a.json', kind: 'distro' }, { file: 'inputs/b.json', kind: 'distro' }, { file: 'inputs/c.json', kind: 'allocations' }],
  },
};
const OCT = { distro: [{ amount: 1, cashTokensAddress: cash('cash folder') }, { amount: 2, bitcoinAddress: legacy('old folder') },
  { amount: 3, cashTokensAddress: cash('both months') }] };
const NOV = { distro: [{ amount: 1, cashTokensAddress: cash('both months') }, { amount: 5, cashTokensAddress: cash('not in this tree') }] };

describe('real folders in an epoch tree', () => {
  it('names only the distribution inputs of the manifest', () => {
    expect(distroInputFiles(EPOCH)).toEqual(['inputs/a.json', 'inputs/b.json']);
  });

  it('counts each leaf paying a distribution recipient once, legacy BTC leaves apart, and leaves out demo and carried leaves', () => {
    expect(realFolders(EPOCH, [OCT, NOV])).toEqual({ epoch: 4, folders: 3, legacy: 1 });
  });

  it('refuses a file that is not a distribution response', () => {
    expect(() => realFolders(EPOCH, [{ allocations: [] }])).toThrow(/not one/);
  });

  it('on the committed mainnet epoch, every legacy BTC leaf comes from the distribution files and is counted', () => {
    const dir = 'deployments/mainnet';
    const epochs = readdirSync(dir).map((n) => /^epoch-(\d+)\.json$/.exec(n)?.[1]).filter((n) => n !== undefined).map(Number);
    const epoch = JSON.parse(readFileSync(join(dir, `epoch-${Math.max(...epochs)}.json`), 'utf8')) as EpochForFolders;
    const responses = distroInputFiles(epoch).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown);
    const got = realFolders(epoch, responses);
    expect(got.legacy).toBe(epoch.leaves.filter((l) => l.method === LinkMethod.legacyBtcName).length);
    expect(got.folders).toBeGreaterThan(got.legacy);
    expect(got.folders).toBeLessThan(epoch.leaves.length);
  });
});
