// Finds the sponsor's live push distributions on mainnet and measures them; writes reports/push-distributions.json.
// Needs the network (public indexer, Electrum, price API); the offline gate only reads the committed report.
// Run with `npm run push-measure`.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectrumNetworkProvider, Network } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { decodeTx, hasDistributionShape, inputTxids, measureDistribution, type DistributionMeasurement } from '../src/cost/distributions.ts';
import type { PushDistributionReport } from '../src/cost/report.ts';

const config = loadConfig();
const k = config.cost;
const dust = BigInt(config.fees.tokenOutputDustSats);
const TIMEOUT_MS = 170_000;

interface Candidate {
  txid: string;
  height: number;
  time: number;
}

/**
 * Transactions with a dust-valued P2PKH output of the sponsor category after output 0, from the public indexer.
 * This only narrows the search; measureDistribution decides from the Electrum copy of each transaction.
 */
async function candidates(): Promise<Candidate[]> {
  const query = `{ output(where: { token_category: { _eq: "\\\\x${k.sponsorCategory}" }, value_satoshis: { _eq: "${dust}" } }) {
    transaction_hash output_index locking_bytecode transaction { block_inclusions { block { height timestamp } } } } }`;
  const res = await fetch(k.indexerGraphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`indexer returned HTTP ${res.status}`);
  type Row = { transaction_hash: string; output_index: string; locking_bytecode: string; transaction: { block_inclusions: Array<{ block: { height: string; timestamp: string } }> } };
  const body = (await res.json()) as { data?: { output: Row[] }; errors?: unknown };
  if (!body.data) throw new Error(`indexer error: ${JSON.stringify(body.errors)}`);
  const seen = new Map<string, Candidate>();
  for (const r of body.data.output) {
    const block = r.transaction.block_inclusions[0]?.block;
    if (!block || r.output_index === '0' || !/^\\x76a914[0-9a-f]{40}88ac$/.test(r.locking_bytecode)) continue;
    const txid = r.transaction_hash.replace(/^\\x/, '');
    seen.set(txid, { txid, height: Number(block.height), time: Number(block.timestamp) });
  }
  return [...seen.values()].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
}

async function usdPerBch(): Promise<number> {
  const res = await fetch(k.priceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`price API returned HTTP ${res.status}`);
  const usd = ((await res.json()) as Record<string, { usd?: number }>)['bitcoin-cash']?.usd;
  if (typeof usd !== 'number' || !(usd > 0)) throw new Error('price API returned no BCH price');
  return usd;
}

async function main(): Promise<void> {
  const hostname = config.networks.mainnet.electrum?.hostname;
  if (!hostname) throw new Error('networks.mainnet.electrum.hostname is not set');
  const found = await candidates();
  // One connection for every request; the provider otherwise connects and disconnects around each call.
  const electrum = new ElectrumNetworkProvider(Network.MAINNET, { hostname, manualConnectionManagement: true });
  await electrum.connect();
  const distributions: Array<DistributionMeasurement & { blockHeight: number; blockTimeUtc: string }> = [];
  try {
    for (const [i, c] of found.entries()) {
      console.error(`${i + 1}/${found.length} ${c.txid}`);
      const hex = await electrum.getRawTransaction(c.txid);
      const tx = decodeTx(hex);
      if (!hasDistributionShape(tx, k.sponsorCategory, dust)) continue;
      const spent = [];
      for (const [i, prevTxid] of inputTxids(tx).entries()) {
        const prev = decodeTx(await electrum.getRawTransaction(prevTxid));
        const out = prev.outputs[tx.inputs[i]!.outpointIndex];
        if (!out) throw new Error(`missing output ${prevTxid}:${tx.inputs[i]!.outpointIndex}`);
        spent.push(out);
      }
      const m = measureDistribution(c.txid, hex, spent, k.sponsorCategory, dust);
      if (m) distributions.push({ ...m, blockHeight: c.height, blockTimeUtc: new Date(c.time * 1000).toISOString() });
    }
  } finally {
    await electrum.disconnect();
  }
  const report: PushDistributionReport = {
    description:
      'Live push distributions of the sponsor reward token on mainnet: output 0 is BCH change to the distributor and every ' +
      'other output carries the dust amount and tokens to one P2PKH recipient. Candidates come from the public indexer; ' +
      'every transaction and every spent output is fetched from Electrum and measured here.',
    generatedBy: 'scripts/push-measure.ts',
    measuredAtUtc: new Date().toISOString(),
    indexer: k.indexerGraphqlUrl,
    electrum: hostname,
    category: k.sponsorCategory,
    candidatesChecked: found.length,
    price: { usdPerBch: await usdPerBch(), source: k.priceUrl, measuredAtUtc: new Date().toISOString() },
    distributions,
  };
  const path = resolve(REPO_ROOT, k.reportPath);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`checked ${found.length} candidates, ${distributions.length} push distributions; wrote ${path}`);
}

await main();
