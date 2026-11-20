import { binToHex } from '@bitauth/libauth';
import { addressToLockingBytecode, LinkMethod } from '../leaf.ts';
import { LegacyBtcAddressError, legacyBtcToLockingBytecode, lockingBytecodeToLegacyBtc } from '../leaf-legacy.ts';
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

/**
 * Legacy BTC links (method 2): a `1...` address that is the whole name or any `_` separated part of it, as in
 * `{name}_ALL_{address}`. Indexed by the P2PKH locking bytecode (hex) the leaf pays. Kept apart from CashAddr links
 * so a method 2 leaf is only confirmed by its Base58 form.
 */
export function addLegacyFahLine(found: Map<string, string[]>, line: string): void {
  const name = line.split('\t')[0]?.trim();
  if (!name || !line.includes('\t') || name === 'name' || !name.includes('1')) return;
  for (const part of new Set([name, ...name.split('_')])) {
    if (part[0] !== '1' || part.length < 25 || part.length > 35) continue;
    try {
      const bytecode = legacyBtcToLockingBytecode(part);
      found.set(bytecode, [...(found.get(bytecode) ?? []), name]);
    } catch (e) {
      if (!(e instanceof LegacyBtcAddressError)) throw e;
    }
  }
}

export function legacyAddressesInFahSummary(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) addLegacyFahLine(found, line);
  return found;
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
  /** Method 2 leaves: how many were checked, how many carry their `1...` address in a name, and which do not. */
  legacy: { checked: number; found: number; missing: Array<{ index: number; address: string | null }> };
}

export function checkLinks(
  epoch: EpochFile,
  fahAddresses: ReadonlyMap<string, string[]>,
  legacyAddresses: ReadonlyMap<string, string[]> = new Map(),
): LinkReport {
  const report: LinkReport = { linked: 0, unlinked: [], mappingOnly: 0, legacy: { checked: 0, found: 0, missing: [] } };
  for (const leaf of epoch.leaves) {
    if (leaf.method === LinkMethod.legacyBtcName) {
      report.legacy.checked += 1;
      if (legacyAddresses.has(leaf.lockingBytecode)) report.legacy.found += 1;
      else report.legacy.missing.push({ index: leaf.index, address: lockingBytecodeToLegacyBtc(leaf.lockingBytecode) ?? null });
    } else if (leaf.method !== LinkMethod.fahName) {
      report.mappingOnly += 1;
    } else if (fahAddresses.has(leaf.lockingBytecode)) {
      report.linked += 1;
    } else {
      report.unlinked.push({ index: leaf.index, address: leaf.address });
    }
  }
  return report;
}
