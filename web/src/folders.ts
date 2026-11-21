// How many real Folding@home folders an epoch tree pays, without the DOM. The answer is read from the published files
// only: the epoch file names its inputs in its manifest, and every leaf whose locking script comes from a stored
// response of the sponsor's distribution endpoint is a real folder. Demo keys and carried-over synthetic leaves are
// not counted. Nothing here is fixed in code.
import { distroToAllocations, inputKind, type DistroResponse } from '../../src/epoch/inputs.ts';
import { LinkMethod } from '../../src/leaf.ts';

export interface EpochForFolders {
  epoch: number;
  leaves: ReadonlyArray<{ lockingBytecode: string; method: number }>;
  manifest: { inputs: ReadonlyArray<{ file: string; kind?: string }> };
}

export interface EpochFolders {
  epoch: number;
  /** Leaves paying a recipient of the distribution responses. */
  folders: number;
  /** Of those, leaves paying a legacy BTC address (link method 2). */
  legacy: number;
}

/** The input files of kind `distro` the epoch manifest names, as paths relative to the network folder. */
export function distroInputFiles(epoch: EpochForFolders): string[] {
  return epoch.manifest.inputs.filter((i) => i.kind === 'distro').map((i) => i.file);
}

/** Counts the leaves of `epoch` that pay a recipient of one of the `responses` (the files `distroInputFiles` names). */
export function realFolders(epoch: EpochForFolders, responses: readonly unknown[]): EpochFolders {
  const scripts = new Set<string>();
  for (const r of responses) {
    if (inputKind(r) !== 'distro') throw new Error('an input named as a distribution response is not one');
    for (const a of distroToAllocations(r as DistroResponse, LinkMethod.fahName)) scripts.add(a.lockingBytecode);
  }
  const paid = epoch.leaves.filter((l) => scripts.has(l.lockingBytecode));
  return { epoch: epoch.epoch, folders: paid.length, legacy: paid.filter((l) => l.method === LinkMethod.legacyBtcName).length };
}
