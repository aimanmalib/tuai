/**
 * Writes deployments/<name>/transactions.json and the generated table in docs/MEASURED.md from the operator's
 * run log (state/runs/<name>.json), reading each transaction's block height from Electrum. The name is the network,
 * or `<network>-<run>` for a pool deployed with `--run <run>`.
 * Usage: npx tsx scripts/chain-report.ts [chipnet|mainnet] [run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectrumNetworkProvider } from 'cashscript';
import { explorersOf } from '../src/explorers.ts';
import { REPO_ROOT, loadConfig, type NetworkName } from '../src/config.ts';
import { renderTransactions, replaceGenerated, type PublicTx } from '../src/demo/report.ts';
import type { RunLog } from '../src/cli/runs.ts';
import { deploymentName } from '../src/cli/context.ts';

const net = (process.argv[2] ?? 'chipnet') as Exclude<NetworkName, 'mock'>;
const name = deploymentName(net, process.argv[3]);
const config = loadConfig();
const n = config.networks[net];
if (!n?.electrum || explorersOf(n).length === 0) throw new Error(`${net} has no Electrum server or explorer URL in the config`);
const log = JSON.parse(readFileSync(resolve(REPO_ROOT, 'state', 'runs', `${name}.json`), 'utf8')) as RunLog;
const provider = new ElectrumNetworkProvider(net, { hostname: n.electrum.hostname });
const tip = await provider.getBlockHeight();

const rows: PublicTx[] = [];
for (const t of log.txs) {
  let height: number | null = null;
  if (t.txid) {
    const tx = (await provider.performRequest('blockchain.transaction.get', t.txid, true)) as { confirmations?: number; size?: number };
    if (tx.confirmations) height = tip - tx.confirmations + 1;
    if (tx.size !== undefined && tx.size !== t.bytes) throw new Error(`${t.txid}: logged ${t.bytes} bytes, network reports ${tx.size}`);
  }
  rows.push({
    kind: t.kind,
    txid: t.txid,
    bytes: t.bytes,
    feeSats: t.feeSats,
    utc: t.utc,
    height,
    ...(t.error ? { error: t.error } : {}),
    ...(t.note ? { note: t.note } : {}),
  });
}
const out = resolve(REPO_ROOT, 'deployments', name, 'transactions.json');
writeFileSync(out, `${JSON.stringify({ network: net, ...(name === net ? {} : { deployment: name }), tipHeight: tip, transactions: rows }, null, 1)}\n`);
const measured = resolve(REPO_ROOT, 'docs', 'MEASURED.md');
writeFileSync(measured, replaceGenerated(readFileSync(measured, 'utf8'), name, renderTransactions(rows, explorersOf(n))));
console.log(`${rows.length} rows, tip ${tip}, ${rows.filter((r) => r.height !== null).length} confirmed`);
process.exit(0);
