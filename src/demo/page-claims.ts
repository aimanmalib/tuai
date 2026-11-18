/**
 * Record of claims made from the public claim page through the chipnet demo relayer (docs/decisions/0009-chipnet-relayer.md).
 * The relayer does not write files: an operator checks each claim on chain with scripts/page-claims.ts, which uses
 * `checkPageClaim` here and keeps the result in deployments/<deployment>/page-claims.json.
 */
import { binToHex } from '../bytes.ts';

export interface ClaimOutput {
  lockingBytecode: Uint8Array;
  valueSatoshis: bigint;
  token?: { category: Uint8Array; amount: bigint; nft?: unknown };
}

export interface PageClaimExpectation {
  pool: Uint8Array;
  /** The deployment's other contracts (vault with the reward tokens and receipts, gate): their outputs are kept by the contract rules. */
  contracts: readonly Uint8Array[];
  leaf: Uint8Array;
  relay: Uint8Array;
  /** Reward token category, hex in the order explorers show (libauth decodes it in that order). */
  rewardCategory: string;
  /** Tokens the leaf should receive: cumulative amount minus the amount claimed before. */
  amount: bigint;
}

export interface PageClaim {
  utc: string;
  address: string;
  txid: string;
  bytes: number;
  feeSats: number;
  height: number | null;
  paid: string;
}

export interface PageRefusal {
  utc: string;
  address: string;
  message: string;
}

export interface PageClaimsRecord {
  network: string;
  claims: PageClaim[];
  refusals: PageRefusal[];
}

/**
 * Problems with a claim transaction's outputs, empty when it is as the pool rules and the relayer guard intend:
 * the reward tokens for the leaf go to the leaf's locking bytecode only, in the expected amount, and every output
 * that is neither a contract of the deployment nor the leaf's is the relayer's own change.
 */
export function checkPageClaim(outputs: readonly ClaimOutput[], e: PageClaimExpectation): string[] {
  const problems: string[] = [];
  const pool = binToHex(e.pool);
  const leaf = binToHex(e.leaf);
  const relay = binToHex(e.relay);
  const contracts = new Set(e.contracts.map((c) => binToHex(c)));
  let paid = 0n;
  outputs.forEach((o, i) => {
    const to = binToHex(o.lockingBytecode);
    const reward = o.token !== undefined && binToHex(o.token.category) === e.rewardCategory ? o.token.amount : 0n;
    if (to === leaf) paid += reward;
    else if (to === pool || contracts.has(to)) return;
    else if (to === relay) {
      if (o.token !== undefined) problems.push(`output ${i} gives tokens to the relayer`);
    } else problems.push(`output ${i} pays ${to}, which is not a contract of the deployment, the leaf or the relayer`);
  });
  if (paid !== e.amount) problems.push(`the leaf received ${paid} tokens, expected ${e.amount}`);
  if (!outputs.some((o) => binToHex(o.lockingBytecode) === pool)) problems.push('no output returns to the pool');
  return problems;
}

/** Markdown for the "Chipnet claims from the page" section. */
export function renderPageClaims(r: PageClaimsRecord, explorerTxUrl: string): string {
  const lines = ['| # | When (UTC) | Leaf address | Transaction | Bytes | Fee (sat) | Block | Tokens paid |', '|---|---|---|---|---|---|---|---|'];
  r.claims.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.utc.replace('T', ' ').slice(0, 19)} | \`${c.address}\` | [\`${c.txid}\`](${explorerTxUrl}${c.txid}) | ${c.bytes} | ${c.feeSats} | ${c.height ?? '-'} | ${c.paid} |`,
    );
  });
  if (r.refusals.length > 0) {
    lines.push('', '"Try to claim again" on a claimed leaf, answered by the node and shown on the page:', '');
    for (const f of r.refusals) {
      lines.push(`- ${f.utc.replace('T', ' ').slice(0, 19)} UTC, \`${f.address}\`: refused, \`${f.message.replace(/\s+/g, ' ').replace(/`/g, "'").slice(0, 300)}\``);
    }
  }
  return lines.join('\n');
}
