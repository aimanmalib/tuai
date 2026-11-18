// The tracked watcher report holds aggregates only: roots, hashes and counts. Addresses and Folding@home names stay
// in untracked state so the public repository never republishes who earned what.
import type { DeploymentWatch, EpochOnChain } from './chain-roots.ts';
import type { LinkReport } from './fah.ts';

export interface FahDownload {
  url: string;
  sha256: string;
  bytes: number;
  fetchedAt: string;
}

export interface WatchReport {
  description: string;
  generatedBy: string;
  network: string;
  generatedAt: string;
  epochs: EpochOnChain[];
  fah: (Omit<FahDownload, 'url'> & { method0Checked: number; method0Matched: number; method0Mismatched: number }) | null;
  replay: { distributions: number; leaves: number; root: string } | null;
  findings: string[];
}

export interface ReplaySummary {
  distributions: number;
  leaves: number;
  root: string;
  links: LinkReport;
}

export function buildWatchReport(chain: DeploymentWatch, fah: FahDownload | null, replay: ReplaySummary | null, now: Date): WatchReport {
  const fahPart =
    fah && replay
      ? {
          sha256: fah.sha256,
          bytes: fah.bytes,
          fetchedAt: fah.fetchedAt,
          method0Checked: replay.links.linked + replay.links.unlinked.length,
          method0Matched: replay.links.linked,
          method0Mismatched: replay.links.unlinked.length,
        }
      : null;
  return {
    description:
      'Watcher run. Epochs: the root and inputs hash in the pool state NFT of each recorded propose and activate ' +
      'transaction, read from chain, next to the values recomputed from the committed epoch files and inputs. Replay: ' +
      'the real push distributions in push-distributions.json rebuilt as one off-chain epoch; fah counts its leaves whose ' +
      'address appears in a name of the public Folding@home daily user summary (link method 0).',
    generatedBy: 'scripts/watch-report.ts',
    network: chain.network,
    generatedAt: now.toISOString(),
    epochs: chain.epochs,
    fah: fahPart,
    replay: replay ? { distributions: replay.distributions, leaves: replay.leaves, root: replay.root } : null,
    findings: chain.findings,
  };
}
