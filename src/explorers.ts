// Block explorers of a network: a named list in the config, the first one primary. A network that still has only the
// older single `explorerTxUrl` reads as one explorer named after its host, so records written before the list stay valid.

export interface Explorer {
  /** Shown on links, e.g. "Open in <name>". */
  name: string;
  /** Transaction page prefix; the txid is appended. */
  txUrl: string;
}

export interface ExplorerLink {
  name: string;
  url: string;
}

const TX_URL = /^https:\/\/[^\s/]+\/(\S*\/)?$/;

/** The explorers configured for a network, primary first; empty when none. */
export function explorersOf(n: { explorers?: readonly Explorer[]; explorerTxUrl?: string } | undefined): Explorer[] {
  if (!n) return [];
  if (n.explorers && n.explorers.length > 0) return n.explorers.map((e) => ({ name: e.name, txUrl: e.txUrl }));
  if (n.explorerTxUrl) return [{ name: new URL(n.explorerTxUrl).hostname, txUrl: n.explorerTxUrl }];
  return [];
}

/** One link per explorer for a transaction, primary first. */
export const explorerLinks = (explorers: readonly Explorer[], txid: string): ExplorerLink[] =>
  explorers.map((e) => ({ name: e.name, url: `${e.txUrl}${txid}` }));

/** Config problems in a network's explorer list (empty when valid). */
export function explorerProblems(name: string, n: { explorers?: unknown; explorerTxUrl?: unknown }): string[] {
  const problems: string[] = [];
  if (n.explorerTxUrl !== undefined && (typeof n.explorerTxUrl !== 'string' || !TX_URL.test(n.explorerTxUrl))) {
    problems.push(`networks.${name}.explorerTxUrl must be an https URL ending in /`);
  }
  if (n.explorers === undefined) return problems;
  if (!Array.isArray(n.explorers)) return [...problems, `networks.${name}.explorers must be a list`];
  n.explorers.forEach((e: unknown, i) => {
    const x = e as Partial<Explorer> | null;
    if (!x || typeof x.name !== 'string' || x.name.trim() === '') problems.push(`networks.${name}.explorers[${i}].name must be a non-empty string`);
    if (!x || typeof x.txUrl !== 'string' || !TX_URL.test(x.txUrl)) problems.push(`networks.${name}.explorers[${i}].txUrl must be an https URL ending in /`);
  });
  return problems;
}

/** Markdown cell for a transaction: the txid linked to the primary explorer, then the others by name. */
export function markdownTxCell(explorers: readonly Explorer[], txid: string): string {
  const [primary, ...rest] = explorerLinks(explorers, txid);
  if (!primary) return `\`${txid}\``;
  return [`[\`${txid}\`](${primary.url})`, ...rest.map((l) => `([${l.name}](${l.url}))`)].join(' ');
}
