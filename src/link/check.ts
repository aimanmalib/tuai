import { readFileSync } from 'node:fs';
import { LinkMethod } from '../leaf.ts';
import type { EpochFile } from '../epoch/file.ts';
import { verifyLink, type LinkClaim } from './message.ts';

/** Published next to the epoch inputs: one signed claim per compatibility user (docs/SPEC.md section 8). */
export interface LinksFile {
  links: LinkClaim[];
}

export function readLinksFile(path: string): LinksFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LinksFile>;
  if (!Array.isArray(raw.links)) throw new Error(`${path} has no "links" array`);
  return { links: raw.links };
}

export interface CompatLinkReport {
  /** Method 1 leaves with at least one valid signed link from their address. */
  verified: Array<{ index: number; names: string[] }>;
  /** Method 1 leaves nobody can check: no link names their address, or every link that does fails. */
  unverified: Array<{ index: number; address: string | null }>;
  /** Links that fail on their own (bad signature, wrong key, malformed), whatever leaf they name. */
  invalid: Array<{ entry: number; reason: string }>;
}

/** Checks every method 1 leaf of an epoch against signed links. Method 0 leaves are the Folding@home name check's job. */
export function checkCompatLinks(epoch: EpochFile, file: LinksFile, domain: string): CompatLinkReport {
  const report: CompatLinkReport = { verified: [], unverified: [], invalid: [] };
  const valid = new Map<string, string[]>();
  file.links.forEach((claim, entry) => {
    const r = verifyLink(domain, claim);
    if (r.ok) valid.set(r.lockingBytecode, [...(valid.get(r.lockingBytecode) ?? []), claim.name]);
    else report.invalid.push({ entry, reason: r.reason });
  });
  for (const leaf of epoch.leaves) {
    if (leaf.method !== LinkMethod.compatibilityMapping) continue;
    const names = valid.get(leaf.lockingBytecode);
    if (names) report.verified.push({ index: leaf.index, names });
    else report.unverified.push({ index: leaf.index, address: leaf.address });
  }
  return report;
}
