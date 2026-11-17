import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binToHex } from '@bitauth/libauth';
import { sha256 } from '../src/bytes.ts';
import { buildEpoch } from '../src/epoch/build.ts';
import { readEpochFile, type EpochFile } from '../src/epoch/file.ts';
import { verifyEpoch } from '../src/epoch/verify.ts';
import { lockingBytecodeToAddress } from '../src/leaf.ts';
import { addressesInFahSummary, checkLinks } from '../src/watch/fah.ts';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const p2pkh = (label: string): string => `76a914${binToHex(sha256(new TextEncoder().encode(label))).slice(0, 40)}88ac`;
const RECIPIENTS = ['alice', 'bob', 'carol', 'dave', 'erin'].map(p2pkh);
const FRANK = p2pkh('frank');
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function twoEpochs(): { e1: string; e2: string } {
  dir = mkdtempSync(join(tmpdir(), 'tuai-epoch-'));
  const common = { network: 'mainnet', prefix: 'bitcoincash' as const, maxDepth: 24, defaultMethod: 0 as const, decimals: 8 };
  const e1 = join(dir, 'epoch-1.json');
  buildEpoch({ ...common, outPath: e1, sources: [{ bytes: enc({ allocations: RECIPIENTS.map((l, i) => ({ lockingBytecode: l, amount: (i + 1) * 100 })) }) }] });
  const e2 = join(dir, 'epoch-2.json');
  buildEpoch({ ...common, outPath: e2, previousPath: e1, sources: [{ bytes: enc({ allocations: [{ lockingBytecode: RECIPIENTS[0], amount: 7 }, { lockingBytecode: FRANK, amount: 9, method: 1 }] }) }] });
  return { e1, e2 };
}

const edit = (path: string, change: (f: EpochFile) => void) => {
  const f = readEpochFile(path);
  change(f);
  writeFileSync(path, JSON.stringify(f));
};

describe('epoch files and the watcher', () => {
  it('recomputes a two-epoch chain from manifests and inputs', () => {
    const { e2 } = twoEpochs();
    const r = verifyEpoch(e2);
    expect(r).toMatchObject({ ok: true, epoch: 2, leaves: 6, problems: [] });
  });

  it('rejects an epoch where one leaf amount was raised', () => {
    const { e2 } = twoEpochs();
    edit(e2, (f) => {
      (f.leaves[2] as EpochFile['leaves'][number]).cumulative = '999999';
    });
    expect(verifyEpoch(e2).problems.join(' ')).toMatch(/leaf 2 .* differs/);
  });

  it('rejects an epoch whose root was replaced', () => {
    const { e2 } = twoEpochs();
    edit(e2, (f) => {
      f.root = '11'.repeat(32);
    });
    expect(verifyEpoch(e2).problems.join(' ')).toMatch(/root differs/);
  });

  it('rejects an input file changed after the manifest was hashed', () => {
    const { e1, e2 } = twoEpochs();
    const input = join(dir, readEpochFile(e1).manifest.inputs[0]?.file as string);
    writeFileSync(input, readFileSync(input, 'utf8').replace('"amount":100', '"amount":101'));
    const r = verifyEpoch(e2);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/previous epoch 1 fails: input .* does not match its hash/);
  });

  it('rejects a manifest change that the inputs hash does not cover', () => {
    const { e1 } = twoEpochs();
    edit(e1, (f) => {
      f.manifest.maxDepth = 23;
    });
    expect(verifyEpoch(e1).problems).toContain('inputs hash does not match the manifest');
  });

  it('refuses a recipient that changes link method between epochs', () => {
    twoEpochs();
    const e3 = join(dir, 'epoch-3.json');
    expect(() =>
      buildEpoch({
        network: 'mainnet', prefix: 'bitcoincash', maxDepth: 24, defaultMethod: 0, decimals: 8, outPath: e3,
        previousPath: join(dir, 'epoch-2.json'),
        sources: [{ bytes: enc({ allocations: [{ lockingBytecode: RECIPIENTS[1], amount: 1, method: 1 }] }) }],
      }),
    ).toThrow(/changed link method/);
  });

  it('reports method 0 leaves whose address is missing from the Folding@home names', () => {
    const { e2 } = twoEpochs();
    const addr = (l: string) => lockingBytecodeToAddress(Buffer.from(l, 'hex'), 'bitcoincash', false);
    const summary = [
      'Tue Nov 17 00:00:00 GMT 2026',
      'name\tnewcredit\tsum(total)\tteam',
      `someone_${addr(RECIPIENTS[1] as string)}\t100\t5\t1`,
      `${addr(RECIPIENTS[2] as string).replace('bitcoincash:', '')}\t50\t2\t1`,
      `folder_${addr(RECIPIENTS[3] as string).replace('bitcoincash:', '')}\t50\t2\t1`,
      'Anonymous\t1\t1\t0',
    ].join('\n');
    const report = checkLinks(readEpochFile(e2), addressesInFahSummary(summary));
    expect(report.linked).toBe(3);
    expect(report.mappingOnly).toBe(1);
    const tokenAddr = (l: string) => lockingBytecodeToAddress(Buffer.from(l, 'hex'), 'bitcoincash');
    expect(report.unlinked.map((u) => u.address).sort()).toEqual([RECIPIENTS[0], RECIPIENTS[4]].map((l) => tokenAddr(l as string)).sort());
  });
});
