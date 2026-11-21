// Collects the public epoch files the claim page serves: <epochsPath>/<network>/{index.json,pool.json,epoch-<n>.json,inputs/*}.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEX_SUFFIX, readStoredInput } from '../src/epoch/stored-input.ts';

export interface ServedFile {
  /** Path under the epochs URL path, e.g. `chipnet/epoch-1.json`. */
  path: string;
  body: string;
}

const EPOCH_FILE = /^epoch-(\d+)\.json$/;

/** Every file to serve for the given networks, plus one `index.json` per network listing its epochs. */
export function collectEpochFiles(repoRoot: string, deploymentsDir: string, networks: readonly string[]): ServedFile[] {
  const out: ServedFile[] = [];
  for (const network of networks) {
    const dir = join(repoRoot, deploymentsDir, network);
    if (!existsSync(join(dir, 'pool.json'))) continue;
    const names = readdirSync(dir);
    const epochs = names
      .map((n) => EPOCH_FILE.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    for (const name of ['pool.json', ...epochs.map((e) => `epoch-${e}.json`)]) {
      out.push({ path: `${network}/${name}`, body: readFileSync(join(dir, name), 'utf8') });
    }
    const inputs = join(dir, 'inputs');
    if (existsSync(inputs)) {
      const names = readdirSync(inputs).filter((n) => n.endsWith('.json') || n.endsWith(`.json${HEX_SUFFIX}`));
      for (const name of [...new Set(names.map((n) => n.replace(/\.hex$/, '')))].sort()) {
        const body = new TextDecoder().decode(readStoredInput(join(inputs, name)));
        out.push({ path: `${network}/inputs/${name}`, body });
      }
    }
    out.push({ path: `${network}/index.json`, body: `${JSON.stringify({ network, epochs })}\n` });
  }
  return out;
}
