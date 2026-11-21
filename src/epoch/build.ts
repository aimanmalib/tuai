import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { CashAddressPrefix, LinkMethod } from '../leaf.ts';
import { addAllocations, type Balances } from './cumulative.ts';
import { sha256Hex } from './canonical.ts';
import { readStoredInput } from './stored-input.ts';
import { inputKind, toAllocations } from './inputs.ts';
import {
  MANIFEST_FORMAT, makeEpochFile, readEpochFile, recipientsFromJson, type EpochFile, type Manifest, type ManifestInput,
} from './file.ts';

export interface InputSource {
  /** Raw bytes exactly as received; the manifest commits to their hash. */
  bytes: Uint8Array;
  request?: ManifestInput['request'];
}

export interface BuildOptions {
  network: string;
  prefix: CashAddressPrefix;
  /** Where the epoch file will be written; inputs are stored in `inputs/` next to it. */
  outPath: string;
  maxDepth: number;
  defaultMethod: LinkMethod;
  decimals: number;
  previousPath?: string;
  sources: InputSource[];
}

/** Applies a manifest's inputs to the previous balances. Shared by build and verify so both compute the same way. */
export function applyInputs(previous: Balances, manifest: Manifest, readInput: (input: ManifestInput) => Uint8Array): Balances {
  let balances = previous;
  for (const input of manifest.inputs) {
    const bytes = readInput(input);
    if (sha256Hex(bytes) !== input.sha256) throw new Error(`input ${input.file} does not match its hash in the manifest`);
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (inputKind(json) !== input.kind) throw new Error(`input ${input.file} is not of kind ${input.kind}`);
    balances = addAllocations(balances, toAllocations(json, manifest.defaultMethod)).balances;
  }
  return balances;
}

export const inputPath = (epochPath: string, input: ManifestInput): string => resolve(dirname(epochPath), input.file);

/** Builds the next epoch file and stores its inputs under content-addressed names. Returns the file and its path. */
export function buildEpoch(o: BuildOptions): EpochFile {
  const outDir = dirname(resolve(o.outPath));
  const previous = o.previousPath ? readEpochFile(o.previousPath) : undefined;
  const inputs: ManifestInput[] = o.sources.map((s) => {
    const hash = sha256Hex(s.bytes);
    const file = `inputs/${hash}.json`;
    mkdirSync(resolve(outDir, 'inputs'), { recursive: true });
    writeFileSync(resolve(outDir, file), s.bytes);
    const kind = inputKind(JSON.parse(new TextDecoder().decode(s.bytes)));
    return s.request ? { file, sha256: hash, kind, request: s.request } : { file, sha256: hash, kind };
  });
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    epoch: (previous?.epoch ?? 0) + 1,
    maxDepth: o.maxDepth,
    defaultMethod: o.defaultMethod,
    decimals: o.decimals,
    previous:
      previous && o.previousPath
        ? { file: relative(outDir, resolve(o.previousPath)), epoch: previous.epoch, root: previous.root }
        : null,
    inputs,
  };
  const start = previous ? recipientsFromJson(previous.recipients) : new Map();
  const balances = applyInputs(start, manifest, (input) => readStoredInput(resolve(outDir, input.file)));
  const file = makeEpochFile(o.network, o.prefix, manifest, balances);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(o.outPath, `${JSON.stringify(file, null, 1)}\n`);
  return file;
}
