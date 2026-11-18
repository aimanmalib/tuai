// Host script (network): writes the watcher report. Reads the recorded deployment's roots from chain, downloads the
// public Folding@home daily user summary once, replays the measured push distributions as an off-chain epoch and
// checks every replay leaf's method 0 link. Raw data stays in untracked state; the tracked report holds aggregates.
// Usage: npx tsx scripts/watch-report.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ElectrumNetworkProvider, Network } from 'cashscript';
import { sha256Hex } from '../src/epoch/canonical.ts';
import { buildEpoch } from '../src/epoch/build.ts';
import { REPO_ROOT, loadConfig, type NetworkName } from '../src/config.ts';
import type { PushDistributionReport } from '../src/cost/report.ts';
import { watchDeployment } from '../src/watch/chain-roots.ts';
import { addFahLine, checkLinks } from '../src/watch/fah.ts';
import { replayAllocations } from '../src/watch/replay.ts';
import { buildWatchReport, type FahDownload, type ReplaySummary } from '../src/watch/report.ts';

const config = loadConfig();
const w = config.watch;
const stateDir = resolve(REPO_ROOT, w.stateDir);
const fahDir = resolve(REPO_ROOT, w.fahDir);
const NETWORKS: Record<string, Network> = { chipnet: Network.CHIPNET, mainnet: Network.MAINNET };

/** Opens one Electrum connection and caches every raw transaction under `state/`, so reruns fetch nothing twice. */
async function withElectrum<T>(network: NetworkName, run: (getRaw: (txid: string) => Promise<string>) => Promise<T>): Promise<T> {
  const hostname = config.networks[network].electrum?.hostname;
  if (!hostname || !NETWORKS[network]) throw new Error(`no Electrum server for ${network}`);
  const cache = join(stateDir, `tx-${network}`);
  mkdirSync(cache, { recursive: true });
  let electrum: ElectrumNetworkProvider | undefined;
  const getRaw = async (txid: string): Promise<string> => {
    const path = join(cache, `${txid}.hex`);
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    if (!electrum) {
      electrum = new ElectrumNetworkProvider(NETWORKS[network], { hostname, manualConnectionManagement: true });
      await electrum.connect();
    }
    const hex = await electrum.getRawTransaction(txid);
    writeFileSync(path, hex);
    return hex;
  };
  try {
    return await run(getRaw);
  } finally {
    await electrum?.disconnect();
  }
}

/** Downloads the summary once; a recorded download is reused. Two failed attempts return null. */
async function fahSummary(): Promise<{ download: FahDownload; path: string } | null> {
  mkdirSync(fahDir, { recursive: true });
  const path = join(fahDir, 'daily_user_summary.txt.bz2');
  const record = join(fahDir, 'download.json');
  if (existsSync(path) && existsSync(record)) return { download: JSON.parse(readFileSync(record, 'utf8')) as FahDownload, path };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(w.fahSummaryUrl, { signal: AbortSignal.timeout(w.downloadTimeoutSeconds * 1000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const download: FahDownload = { url: w.fahSummaryUrl, sha256: sha256Hex(bytes), bytes: bytes.length, fetchedAt: new Date().toISOString() };
      writeFileSync(path, bytes);
      writeFileSync(record, `${JSON.stringify(download, null, 2)}\n`);
      return { download, path };
    } catch (e) {
      console.error(`Folding@home summary download attempt ${attempt} failed: ${(e as Error).message}`);
    }
  }
  return null;
}

/** Streams the decompressed summary (`bzip2 -dc`) into the address map without holding the text in memory. */
async function fahAddresses(bz2Path: string): Promise<Map<string, string[]>> {
  const child = spawn('bzip2', ['-dc', bz2Path], { stdio: ['ignore', 'pipe', 'inherit'] });
  const found = new Map<string, string[]>();
  for await (const line of createInterface({ input: child.stdout })) addFahLine(found, line);
  const code = await new Promise<number | null>((done) => child.on('close', done));
  if (code !== 0) throw new Error(`bzip2 exited with ${code}`);
  return found;
}

async function replay(fahPath: string): Promise<ReplaySummary> {
  const pushes = JSON.parse(readFileSync(resolve(REPO_ROOT, config.cost.reportPath), 'utf8')) as PushDistributionReport;
  const hexes = await withElectrum('mainnet', async (getRaw) => {
    const out: string[] = [];
    for (const d of pushes.distributions) out.push(await getRaw(d.txid));
    return out;
  });
  const allocations = replayAllocations(hexes, pushes.category);
  const epoch = buildEpoch({
    network: 'mainnet',
    prefix: 'bitcoincash',
    outPath: join(stateDir, 'replay', 'epoch-1.json'),
    maxDepth: config.tree.maxDepth,
    defaultMethod: 0,
    decimals: config.rewards.decimals,
    sources: [{ bytes: new TextEncoder().encode(JSON.stringify(allocations)) }],
  });
  const links = checkLinks(epoch, await fahAddresses(fahPath));
  writeFileSync(join(stateDir, 'replay-links.json'), `${JSON.stringify(links, null, 2)}\n`);
  return { distributions: pushes.distributions.length, leaves: epoch.leaves.length, root: epoch.root, links };
}

async function main(): Promise<void> {
  const chain = await withElectrum(w.network, (getRaw) => watchDeployment(resolve(REPO_ROOT, w.deploymentDir), getRaw));
  const fah = await fahSummary();
  const replayed = fah ? await replay(fah.path) : null;
  const report = buildWatchReport(chain, fah?.download ?? null, replayed, new Date());
  const out = resolve(REPO_ROOT, w.reportPath);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const e of report.epochs) {
    console.log(`epoch ${e.epoch}: root ${e.rootOnChain === e.rootRecomputed ? 'matches' : 'DIFFERS'}, inputs hash ${e.inputsHashOnChain === e.inputsHashRecomputed ? 'matches' : 'DIFFERS'}`);
  }
  if (report.fah) console.log(`replay ${report.replay?.leaves} leaves; method 0 linked ${report.fah.method0Matched} of ${report.fah.method0Checked}`);
  console.log(`findings: ${report.findings.length}; wrote ${out}`);
  if (report.findings.length > 0) process.exitCode = 1;
}

await main();
