/**
 * Checks a claim made from the public page through the chipnet demo relayer, on chain, and records it; or records
 * the node's refusal shown by "Try to claim again". Then rewrites deployments/<deployment>/page-claims.json and the
 * generated "Chipnet claims from the page" block in docs/MEASURED.md (also with no arguments, to refresh heights).
 * Usage:
 *   npx tsx scripts/page-claims.ts claim <txid> --address <leaf address> --relay <relayer address> --utc <ISO time>
 *   npx tsx scripts/page-claims.ts refused --address <leaf address> --message <node message> --utc <ISO time>
 *   npx tsx scripts/page-claims.ts
 * With --kind auto the same checks record a claim made by `tuai relay` auto-claim instead (auto-claims.json and the
 * "chipnet-auto" block); --paid then gives the amount the relayer read from the leaf's receipt on chain, and the
 * check fails unless the leaf received exactly that and no more than its cumulative amount.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider } from 'cashscript';
import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { addressToLockingBytecode } from '../src/leaf.ts';
import { replaceGenerated } from '../src/demo/report.ts';
import { checkPageClaim, renderPageClaims, type PageClaimsRecord } from '../src/demo/page-claims.ts';

const NET = 'chipnet';
const config = loadConfig();
const n = config.networks[NET];
if (!n?.electrum || !n.explorerTxUrl) throw new Error(`${NET} has no Electrum server or explorer URL in the config`);
const dir = resolve(REPO_ROOT, 'deployments', config.relay.deployment);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    address: { type: 'string' },
    relay: { type: 'string' },
    message: { type: 'string' },
    utc: { type: 'string' },
    kind: { type: 'string', default: 'page' },
    paid: { type: 'string' },
  },
});
if (values.kind !== 'page' && values.kind !== 'auto') throw new Error('--kind is page or auto');
const auto = values.kind === 'auto';
const recordPath = resolve(dir, auto ? 'auto-claims.json' : 'page-claims.json');
const record: PageClaimsRecord = existsSync(recordPath)
  ? (JSON.parse(readFileSync(recordPath, 'utf8')) as PageClaimsRecord)
  : { network: NET, claims: [], refusals: [] };
const provider = new ElectrumNetworkProvider(NET, { hostname: n.electrum.hostname });
const tip = await provider.getBlockHeight();

const [mode, txid] = positionals;

async function rawTx(id: string) {
  const tx = decodeTransaction(hexToBin((await provider.getRawTransaction(id)) as string));
  if (typeof tx === 'string') throw new Error(`${id}: ${tx}`);
  return tx;
}

async function heightOf(id: string): Promise<number | null> {
  const v = (await provider.performRequest('blockchain.transaction.get', id, true)) as { confirmations?: number };
  return v.confirmations ? tip - v.confirmations + 1 : null;
}

const utc = (): string => {
  if (!values.utc || Number.isNaN(Date.parse(values.utc))) throw new Error('--utc <ISO time> is required');
  return new Date(values.utc).toISOString();
};

if (mode === 'claim') {
  if (!txid || !/^[0-9a-f]{64}$/.test(txid) || !values.address || !values.relay) throw new Error('usage: claim <txid> --address A --relay R --utc T');
  if (record.claims.some((c) => c.txid === txid)) throw new Error(`${txid} is already recorded`);
  const pool = JSON.parse(readFileSync(resolve(dir, 'pool.json'), 'utf8')) as { rewardCategory: string; contracts: Record<string, string> & { pool: string } };
  const epochFile = newestEpoch();
  const epoch = JSON.parse(readFileSync(epochFile, 'utf8')) as { leaves: { address: string; cumulative: string }[] };
  const leaf = epoch.leaves.find((l) => l.address === values.address);
  if (!leaf) throw new Error(`${values.address} is not a leaf of ${epochFile}`);
  const tx = await rawTx(txid);
  // Tokens paid before this claim: the receipt is not readable here, so the expected amount comes from the
  // cumulative amount minus earlier page claims of the same leaf (the page only offers leaves with nothing claimed).
  const before = record.claims.filter((c) => c.address === values.address).reduce((s, c) => s + BigInt(c.paid), 0n);
  const amount = auto ? BigInt(values.paid ?? '0') : BigInt(leaf.cumulative) - before;
  if (amount <= 0n || amount > BigInt(leaf.cumulative)) throw new Error(`the amount to check, ${amount}, is not within the leaf's cumulative amount`);
  const problems = checkPageClaim(tx.outputs, {
    pool: addressToLockingBytecode(pool.contracts.pool, 'bchtest'),
    contracts: Object.values(pool.contracts).map((a) => addressToLockingBytecode(a, 'bchtest')),
    leaf: addressToLockingBytecode(values.address, 'bchtest'),
    relay: addressToLockingBytecode(values.relay, 'bchtest'),
    rewardCategory: pool.rewardCategory,
    amount,
  });
  if (problems.length > 0) throw new Error(`${txid} does not match the claim rules: ${problems.join('; ')}`);
  let inSats = 0n;
  for (const i of tx.inputs) {
    const prev = await rawTx(Buffer.from(i.outpointTransactionHash).toString('hex'));
    inSats += prev.outputs[i.outpointIndex]!.valueSatoshis;
  }
  const outSats = tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  const bytes = (await provider.getRawTransaction(txid)).length / 2;
  record.claims.push({ utc: utc(), address: values.address, txid, bytes, feeSats: Number(inSats - outSats), height: null, paid: amount.toString() });
} else if (mode === 'refused') {
  if (!values.address || !values.message) throw new Error('usage: refused --address A --message M --utc T');
  record.refusals.push({ utc: utc(), address: values.address, message: values.message });
} else if (mode !== undefined) throw new Error(`unknown mode ${mode}`);

for (const c of record.claims) c.height = await heightOf(c.txid);
writeFileSync(recordPath, `${JSON.stringify(record, null, 1)}\n`);
const measured = resolve(REPO_ROOT, 'docs', 'MEASURED.md');
writeFileSync(measured, replaceGenerated(readFileSync(measured, 'utf8'), `${NET}-${values.kind}`, renderPageClaims(record, n.explorerTxUrl)));
console.log(`${record.claims.length} claims, ${record.refusals.length} refusals, tip ${tip}`);
process.exit(0);

function newestEpoch(): string {
  // The relayer serves the active epoch, the newest one in its deployment; the same file decides the expected amount.
  const files = readdirSync(dir)
    .map((f) => /^epoch-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!files[0]) throw new Error(`no epoch file in ${dir}`);
  return resolve(dir, files[0][0]);
}
