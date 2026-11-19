// DOM output for one lookup. Text only through textContent; no HTML strings.
import { t, getLocale } from './i18n.ts';
import { formatUnits, type ChainView, type LookupResult } from './model.ts';
import { binToHex } from '@bitauth/libauth';

type Child = Node | string | false | undefined;

export function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== false && c !== undefined) node.append(c);
  return node;
}

const hash = (hex: string) => el('code', { class: 'hash' }, hex);

function amountRow(label: string, value: bigint, decimals: number, cls: string): HTMLElement {
  return el(
    'div',
    { class: `amount ${cls}` },
    el('dt', {}, label),
    el('dd', {}, el('span', { class: 'num' }, formatUnits(value, decimals, getLocale())), ' ', el('span', { class: 'unit' }, t('result.unit'))),
  );
}

/** Amounts, the proof ladder and the chain comparison for one leaf. */
export function renderResult(target: HTMLElement, r: LookupResult, chain: ChainView, fileEpoch: number, fileRoot: string, decimals: number): void {
  const chainRoot = binToHex(chain.active.root);
  const trusted = r.proofMatchesFile && r.fileMatchesChain === 'match';
  const amounts = el(
    'dl',
    { class: 'amounts' },
    amountRow(t('result.claimable'), r.claimable, decimals, 'lead'),
    amountRow(t('result.cumulative'), r.cumulative, decimals, ''),
    amountRow(t('result.claimed'), r.claimed, decimals, ''),
  );
  const warnings: HTMLElement[] = [];
  if (!r.proofMatchesFile) warnings.push(el('p', { class: 'warn', role: 'alert', id: 'warn-proof' }, t('proof.fileMismatch')));
  if (r.fileMatchesChain === 'mismatch') {
    warnings.push(
      el(
        'p',
        { class: 'warn', role: 'alert', id: 'warn-root' },
        t('proof.rootMismatch', { fileRoot, fileEpoch, chainRoot, chainEpoch: chain.active.epoch }),
      ),
    );
  }
  const ladder = el('ol', { class: 'ladder' });
  ladder.append(el('li', { class: 'rung leaf' }, el('span', { class: 'rung-label' }, t('proof.leaf', { index: r.leaf.index })), hash(r.path.leafHash)));
  for (const s of r.path.steps) {
    ladder.append(
      el(
        'li',
        { class: `rung ${s.side}` },
        el('span', { class: 'rung-label' }, `${t('proof.level', { level: s.level + 1 })}: ${t(`proof.${s.side}`)}`),
        hash(s.result),
      ),
    );
  }
  const roots = el(
    'dl',
    { class: 'roots' },
    el('div', { class: r.proofMatchesFile ? 'root ok' : 'root bad' }, el('dt', {}, t('proof.fileRoot')), el('dd', {}, hash(fileRoot))),
    el(
      'div',
      { class: r.fileMatchesChain === 'match' ? 'root ok' : 'root bad' },
      el('dt', {}, t('proof.chainRoot', { epoch: chain.active.epoch })),
      el('dd', {}, hash(chainRoot)),
    ),
  );
  const parts: Child[] = [
    el('h2', {}, t('result.heading', { epoch: fileEpoch })),
    ...warnings,
    amounts,
    r.claimable === 0n ? el('p', { class: 'note' }, t('result.allClaimed')) : false,
    el(
      'section',
      { class: 'proof', 'aria-labelledby': 'proof-h' },
      el('h3', { id: 'proof-h' }, t('proof.heading')),
      ladder,
      roots,
      trusted ? el('p', { class: 'ok-note', id: 'proof-ok' }, t('proof.match')) : false,
    ),
  ];
  target.replaceChildren(...parts.filter((p): p is Node | string => p !== false && p !== undefined));
  target.hidden = false;
}

/** The claim command with a copy button. */
export function renderClaim(target: HTMLElement, command: string): void {
  const code = el('code', { id: 'claim-command' }, command);
  const button = el('button', { type: 'button', class: 'secondary', id: 'copy' }, t('claim.copy'));
  const feedback = el('span', { class: 'copy-feedback', role: 'status' });
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(command).then(
      () => (feedback.textContent = t('claim.copied')),
      () => (feedback.textContent = t('claim.copyFailed')),
    );
  });
  target.append(
    el(
      'section',
      { class: 'claim', 'aria-labelledby': 'claim-h' },
      el('h3', { id: 'claim-h' }, t('claim.heading')),
      el('p', {}, t('claim.text')),
      el('pre', {}, code),
      el('div', { class: 'copy-row' }, button, feedback),
    ),
  );
}

/** Active epoch, any pending root and the audit window. */
export function renderGate(target: HTMLElement, chain: ChainView, blocksLeft: number | undefined, windowBlocks: number, production: number): void {
  const lines: HTMLElement[] = [el('p', {}, t('gate.active', { epoch: chain.active.epoch, tip: formatUnits(BigInt(chain.tip), 0, getLocale()) }))];
  if (!chain.pending) lines.push(el('p', { id: 'gate-pending' }, t('gate.none')));
  else {
    const epoch = chain.pending.state.epoch;
    const key = blocksLeft === undefined ? 'gate.unconfirmed' : blocksLeft > 0 ? 'gate.waiting' : 'gate.ready';
    lines.push(el('p', { id: 'gate-pending', class: 'pending' }, t(key, { epoch, blocks: blocksLeft ?? 0 })));
  }
  lines.push(el('p', { class: 'note' }, t('gate.window', { blocks: windowBlocks, production })));
  target.replaceChildren(el('h2', {}, t('gate.heading')), ...lines);
  target.hidden = false;
}

/** One link per explorer, each named: "Open in <name>" from the given lang key. */
export function explorerAnchors(links: readonly { name: string; url: string }[], key: string): HTMLElement[] {
  return links.map((l) => el('a', { href: l.url, rel: 'noopener', target: '_blank', class: 'explorer-link' }, t(key, { name: l.name })));
}
