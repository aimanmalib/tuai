import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { encodeReceipt, encodeState, receiptKey, END_KEY } from '../src/pool/encoding.ts';
import {
  chainViewFrom,
  claimCommand,
  formatUnits,
  lookup,
  parseAddress,
  pendingBlocksLeft,
  proofPath,
  type ElectrumUtxo,
  type EpochFileView,
  type PoolRecord,
} from '../web/src/model.ts';

// Committed chipnet deployment files are the fixtures: their roots are what the pool holds on chain.
const file = JSON.parse(readFileSync('deployments/chipnet/epoch-2.json', 'utf8')) as EpochFileView;
const record = JSON.parse(readFileSync('deployments/chipnet/pool.json', 'utf8')) as PoolRecord;
const nft = (capability: string, commitment: string, height = 100): ElectrumUtxo => ({
  tx_hash: '00'.repeat(32),
  tx_pos: 0,
  height,
  value: 1000,
  token_data: { category: record.poolCategory, amount: '0', nft: { capability, commitment } },
});
const stateHex = (root: string, epoch: number, inputsHash = file.inputsHash) =>
  binToHex(encodeState({ root: hexToBin(root), epoch, inputsHash: hexToBin(inputsHash) }));
const leaf = file.leaves[150]!;
const locking = hexToBin(leaf.lockingBytecode);
const chainWith = (opts: { root?: string; epoch?: number; claimed?: bigint; gate?: ElectrumUtxo[] } = {}) =>
  chainViewFrom(
    record,
    500,
    [nft('minting', stateHex(opts.root ?? file.root, opts.epoch ?? file.epoch))],
    opts.gate ?? [nft('mutable', stateHex(opts.root ?? file.root, opts.epoch ?? file.epoch))],
    opts.claimed === undefined
      ? []
      : [nft('none', binToHex(encodeReceipt({ key: receiptKey(locking), next: END_KEY, claimed: opts.claimed })))],
  );

describe('claim page address parsing', () => {
  const encode = (tokenSupport: boolean) => {
    const r = lockingBytecodeToCashAddress({ bytecode: locking, prefix: 'bchtest', tokenSupport });
    if (typeof r === 'string') throw new Error(r);
    return r.address;
  };
  const plain = encode(false);
  const token = encode(true);
  it('accepts q and z forms, with and without the prefix, to the same locking bytecode', () => {
    for (const a of [plain, token, plain.split(':')[1]!, token.split(':')[1]!.toUpperCase(), `  ${plain} `]) {
      const r = parseAddress(a, 'bchtest');
      expect(r.ok && binToHex(r.lockingBytecode)).toBe(leaf.lockingBytecode);
    }
    expect(token).not.toBe(plain);
  });
  it('names a mainnet address on chipnet and rejects a damaged one', () => {
    const r = lockingBytecodeToCashAddress({ bytecode: locking, prefix: 'bitcoincash' });
    if (typeof r === 'string') throw new Error(r);
    expect(parseAddress(r.address, 'bchtest')).toEqual({ ok: false, reason: 'wrongNetwork', prefix: 'bitcoincash' });
    expect(parseAddress(`${plain.slice(0, -1)}x`, 'bchtest')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseAddress('', 'bchtest')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('claim page lookup', () => {
  it('recomputes the root step by step from the leaf', () => {
    const path = proofPath(leaf, record.maxDepth)!;
    expect(path.steps).toHaveLength(file.depth);
    expect(path.root).toBe(file.root);
    expect(path.steps.at(-1)!.result).toBe(file.root);
  });
  it('reports a match and the full amount when nothing was claimed', () => {
    const r = lookup(file, chainWith(), locking, record.maxDepth);
    if (typeof r === 'string') throw new Error(r);
    expect(r.proofMatchesFile).toBe(true);
    expect(r.fileMatchesChain).toBe('match');
    expect(r.claimed).toBe(0n);
    expect(r.claimable).toBe(BigInt(leaf.cumulative));
  });
  it('subtracts the receipt held in the vault', () => {
    const r = lookup(file, chainWith({ claimed: 1000n }), locking, record.maxDepth);
    if (typeof r === 'string') throw new Error(r);
    expect(r.claimable).toBe(BigInt(leaf.cumulative) - 1000n);
    const all = lookup(file, chainWith({ claimed: BigInt(leaf.cumulative) }), locking, record.maxDepth);
    if (typeof all === 'string') throw new Error(all);
    expect(all.claimable).toBe(0n);
  });
  it('flags a chain root that differs from the file root', () => {
    const r = lookup(file, chainWith({ root: 'ab'.repeat(32) }), locking, record.maxDepth);
    if (typeof r === 'string') throw new Error(r);
    expect(r.proofMatchesFile).toBe(true);
    expect(r.fileMatchesChain).toBe('mismatch');
    const older = lookup(file, chainWith({ epoch: file.epoch - 1 }), locking, record.maxDepth);
    expect(typeof older !== 'string' && older.fileMatchesChain).toBe('mismatch');
  });
  it('flags a tampered amount: the proof no longer reaches the file root', () => {
    const tampered = { ...file, leaves: file.leaves.map((l) => (l === leaf ? { ...l, cumulative: (BigInt(l.cumulative) + 1n).toString() } : l)) };
    const r = lookup(tampered, chainWith(), locking, record.maxDepth);
    expect(typeof r !== 'string' && r.proofMatchesFile).toBe(false);
  });
  it('returns notFound for an address without a leaf and badProof for a malformed proof', () => {
    expect(lookup(file, chainWith(), hexToBin(`76a914${'11'.repeat(20)}88ac`), record.maxDepth)).toBe('notFound');
    const bad = { ...file, leaves: file.leaves.map((l) => (l === leaf ? { ...l, proof: [...l.proof.slice(1), 'zz'] } : l)) };
    expect(lookup(bad, chainWith(), locking, record.maxDepth)).toBe('badProof');
  });
});

describe('claim page chain view', () => {
  it('shows a pending root only when its epoch is ahead, with scaled blocks left', () => {
    expect(chainWith().pending).toBeUndefined();
    const pending = chainWith({ gate: [nft('mutable', stateHex('cd'.repeat(32), file.epoch + 1), 490)] });
    expect(pending.pending?.state.epoch).toBe(file.epoch + 1);
    // Confirmed at 490, tip 500: activation is possible from height 490 + delay * scale.
    expect(pendingBlocksLeft(pending, record, 10)).toBe(490 + record.activationDelay * 10 - 501);
    expect(pendingBlocksLeft(pending, record, 1)).toBe(0);
    const unconfirmed = chainWith({ gate: [nft('mutable', stateHex('cd'.repeat(32), file.epoch + 1), 0)] });
    expect(pendingBlocksLeft(unconfirmed, record)).toBeUndefined();
  });
  it('refuses a deployment without exactly one state NFT', () => {
    expect(() => chainViewFrom(record, 1, [], [], [])).toThrow(/one pool state NFT/);
  });
});

describe('claim page formatting', () => {
  it('formats base units with grouping and trimmed decimals', () => {
    expect(formatUnits(125000000000n, 8)).toBe('1,250');
    expect(formatUnits(123456789n, 8, 'ms')).toBe('1.23456789');
    expect(formatUnits(0n, 8)).toBe('0');
  });
  it('builds the CLI claim command for the epoch file', () => {
    expect(claimCommand('bchtest:qq', 'chipnet', 2, 'deployments')).toBe(
      'npx tsx bin/tuai.ts claim bchtest:qq --network chipnet --epoch deployments/chipnet/epoch-2.json',
    );
  });
});
