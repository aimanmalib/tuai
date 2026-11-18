import { binToHex } from '@bitauth/libauth';
import { addressToLockingBytecode, LinkMethod } from '../leaf.ts';
import type { EpochFile } from '../epoch/file.ts';

/**
 * Folding@home publishes a daily user summary (tab separated: name, new credit, total credit, team) after a
 * date line and a header line. Users link an address by putting it in their name, usually as `{name}_{address}`.
 * Returns the locking bytecode (hex) of every address found in a name, mapped to the names that carry it.
 */
export function addressesInFahSummary(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) addFahLine(found, line);
  return found;
}

/** Adds the address in one summary line, if any, to `found`. Lets callers stream a large summary line by line. */
export function addFahLine(found: Map<string, string[]>, line: string): void {
  const name = line.split('\t')[0]?.trim();
  if (!name || !line.includes('\t') || name === 'name') return;
  const candidates = new Set([name, name.slice(name.lastIndexOf('_') + 1)]);
  for (const candidate of candidates) {
    const bytecode = tryAddress(candidate);
    if (!bytecode) continue;
    found.set(bytecode, [...(found.get(bytecode) ?? []), name]);
  }
}

function tryAddress(candidate: string): string | undefined {
  if (candidate.length < 34 || candidate.length > 120) return undefined;
  try {
    return binToHex(addressToLockingBytecode(candidate, 'bitcoincash'));
  } catch {
    return undefined;
  }
}

export interface LinkReport {
  /** Method 0 leaves whose address appears in a Folding@home name. */
  linked: number;
  /** Method 0 leaves with no matching name: the link claim cannot be checked from public data. */
  unlinked: Array<{ index: number; address: string | null }>;
  /** Leaves linked by FoldingCash's own mapping (method 1); public stats cannot confirm them. */
  mappingOnly: number;
}

export function checkLinks(epoch: EpochFile, fahAddresses: ReadonlyMap<string, string[]>): LinkReport {
  const report: LinkReport = { linked: 0, unlinked: [], mappingOnly: 0 };
  for (const leaf of epoch.leaves) {
    if (leaf.method !== LinkMethod.fahName) {
      report.mappingOnly += 1;
    } else if (fahAddresses.has(leaf.lockingBytecode)) {
      report.linked += 1;
    } else {
      report.unlinked.push({ index: leaf.index, address: leaf.address });
    }
  }
  return report;
}
