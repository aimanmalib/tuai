// Works out the real-folder count of the newest served mainnet epoch from the served files, independently of
// web/src/folders.ts, so the mainnet card can be checked against it (local and live specs).
import type { Page } from '@playwright/test';
import { binToHex } from '@bitauth/libauth';
import { addressToLockingBytecode } from '../src/leaf.ts';
import { legacyBtcToLockingBytecode } from '../src/leaf-legacy.ts';

const scriptOf = (address: string): string => binToHex(addressToLockingBytecode(address, 'bitcoincash'));

/** The folder count of the newest served mainnet epoch, worked out here from the served files the way the page should. */
export async function servedFolders(page: Page, epochsPath: string): Promise<{ epoch: number; folders: number; legacy: number }> {
  const base = `${epochsPath}/mainnet`;
  const { epochs } = (await (await page.request.get(`${base}/index.json`)).json()) as { epochs: number[] };
  const epoch = Math.max(...epochs);
  const file = (await (await page.request.get(`${base}/epoch-${epoch}.json`)).json()) as {
    leaves: { lockingBytecode: string; method: number }[];
    manifest: { inputs: { file: string; kind?: string }[] };
  };
  const scripts = new Set<string>();
  for (const input of file.manifest.inputs.filter((i) => i.kind === 'distro')) {
    const r = (await (await page.request.get(`${base}/${input.file}`)).json()) as { distro: { cashTokensAddress?: string | null; bitcoinAddress?: string | null }[] };
    for (const u of r.distro) {
      const lb = u.cashTokensAddress ? scriptOf(u.cashTokensAddress) : u.bitcoinAddress ? legacyBtcToLockingBytecode(u.bitcoinAddress) : null;
      if (lb) scripts.add(lb);
    }
  }
  const paid = file.leaves.filter((l) => scripts.has(l.lockingBytecode));
  return { epoch, folders: paid.length, legacy: paid.filter((l) => l.method === 2).length };
}
