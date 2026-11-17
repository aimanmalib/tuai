import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { hexToBinChecked } from '../bytes.ts';
import { verifyProof } from '../merkle/proof.ts';
import { manifestHash } from './canonical.ts';
import { applyInputs, inputPath } from './build.ts';
import { leafFromJson, makeEpochFile, readEpochFile, recipientsFromJson, type EpochFile } from './file.ts';

export interface VerifyReport {
  ok: boolean;
  epoch: number;
  root: string;
  leaves: number;
  problems: string[];
}

const PREFIXES = { mainnet: 'bitcoincash', chipnet: 'bchtest', mock: 'bchtest' } as const;

/**
 * Recomputes an epoch from its manifest: input hashes, the previous epoch (recursively), every balance,
 * the root, the inputs hash and every stored proof. Any difference is reported by name.
 */
export function verifyEpoch(path: string, depthLimit = 1000): VerifyReport {
  const problems: string[] = [];
  let file: EpochFile;
  try {
    file = readEpochFile(path);
  } catch (e) {
    return { ok: false, epoch: 0, root: '', leaves: 0, problems: [(e as Error).message] };
  }
  const report = (): VerifyReport => ({ ok: problems.length === 0, epoch: file.epoch, root: file.root, leaves: file.leaves.length, problems });
  const m = file.manifest;
  if (manifestHash(m) !== file.inputsHash) problems.push('inputs hash does not match the manifest');
  if (m.epoch !== file.epoch) problems.push('manifest epoch differs from the file epoch');
  let start = new Map();
  if (m.previous) {
    const prevPath = resolve(dirname(path), m.previous.file);
    const prev = depthLimit > 0 ? verifyEpoch(prevPath, depthLimit - 1) : undefined;
    if (prev && !prev.ok) problems.push(`previous epoch ${m.previous.epoch} fails: ${prev.problems.join('; ')}`);
    const prevFile = readEpochFile(prevPath);
    if (prevFile.root !== m.previous.root || prevFile.epoch !== m.previous.epoch) problems.push('previous epoch root or number differs');
    if (m.epoch !== prevFile.epoch + 1) problems.push('epoch does not follow the previous epoch');
    start = recipientsFromJson(prevFile.recipients);
  } else if (m.epoch !== 1) {
    problems.push('only epoch 1 may have no previous epoch');
  }
  let recomputed: EpochFile;
  try {
    const balances = applyInputs(start, m, (input) => readFileSync(inputPath(path, input)));
    const prefix = PREFIXES[file.network as keyof typeof PREFIXES] ?? 'bitcoincash';
    recomputed = makeEpochFile(file.network, prefix, m, balances);
  } catch (e) {
    problems.push((e as Error).message);
    return report();
  }
  if (recomputed.root !== file.root) problems.push(`root differs: file ${file.root}, recomputed ${recomputed.root}`);
  if (recomputed.leaves.length !== file.leaves.length) problems.push('leaf count differs');
  const expected = new Map(recomputed.leaves.map((l) => [l.lockingBytecode, l]));
  for (const leaf of file.leaves) {
    const want = expected.get(leaf.lockingBytecode);
    if (!want || want.cumulative !== leaf.cumulative || want.method !== leaf.method || want.index !== leaf.index) {
      problems.push(`leaf ${leaf.index} (${leaf.address ?? leaf.lockingBytecode}) differs from the recomputed leaf`);
      continue;
    }
    const proof = { index: leaf.index, siblings: leaf.proof.map((s) => hexToBinChecked(s, 32)) };
    if (!verifyProof(leafFromJson(leaf), proof, hexToBinChecked(file.root, 32), m.maxDepth)) {
      problems.push(`proof for leaf ${leaf.index} does not reach the root`);
    }
  }
  if (JSON.stringify(recomputed.recipients) !== JSON.stringify(file.recipients)) problems.push('carried balances differ');
  return report();
}
