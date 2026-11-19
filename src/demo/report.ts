import { markdownTxCell, type Explorer } from '../explorers.ts';
/** Public record of one network's demonstration transactions, written from the operator's run log. */
export interface PublicTx {
  kind: string;
  txid: string | null;
  bytes: number;
  feeSats: number;
  utc: string;
  /** Block height, or null while unconfirmed or when the network refused the transaction. */
  height: number | null;
  error?: string;
  note?: string;
}

const MARK = (net: string, end = false) => `<!-- ${net}-transactions:${end ? 'end' : 'start'} -->`;

const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** Markdown table of every attempt, refused ones included, in the order they were made. */
export function renderTransactions(rows: readonly PublicTx[], explorers: readonly Explorer[]): string {
  const lines = ['| # | When (UTC) | Step | Transaction | Bytes | Fee (sat) | Block | Result |', '|---|---|---|---|---|---|---|---|'];
  rows.forEach((r, i) => {
    const tx = r.txid ? markdownTxCell(explorers, r.txid) : 'not mined';
    const result = r.error ? `refused: ${cell(r.error).slice(0, 200)}` : r.note ? `accepted (${cell(r.note)})` : 'accepted';
    const when = r.utc.replace('T', ' ').slice(0, 19);
    lines.push(`| ${i + 1} | ${when} | ${r.kind} | ${tx} | ${r.bytes} | ${r.feeSats} | ${r.height ?? '-'} | ${result} |`);
  });
  return lines.join('\n');
}

/** Replaces the generated block for `net` inside a Markdown document; the block must already be marked. */
export function replaceGenerated(doc: string, net: string, body: string): string {
  const start = doc.indexOf(MARK(net));
  const end = doc.indexOf(MARK(net, true));
  if (start < 0 || end < start) throw new Error(`the document has no ${net} transaction markers`);
  return `${doc.slice(0, start)}${MARK(net)}\n${body}\n${doc.slice(end)}`;
}
