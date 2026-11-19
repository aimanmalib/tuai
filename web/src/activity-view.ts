// DOM output for the activity page and the per-epoch history on an address result. Text only through textContent.
import { getLocale, t } from './i18n.ts';
import { el, explorerAnchors } from './render.ts';
import { explorerLinks, type Explorer } from '../../src/explorers.ts';
import type { ChainCheck } from './chain-check.ts';
import { formatUnits } from './model.ts';
import { refusedCount, topUps, type ActivityIndex, type ActivityRun, type ActivityTx, type EpochEntry } from './activity.ts';

const when = (utc: string) => `${utc.replace('T', ' ').slice(0, 19)} UTC`;
const num = (n: number | bigint, decimals = 0) => formatUnits(BigInt(n), decimals, getLocale());

function label(key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

function copyButton(text: string): HTMLElement {
  const feedback = el('span', { class: 'copy-feedback', role: 'status' });
  const button = el('button', { type: 'button', class: 'secondary small' }, t('activity.copy'));
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(
      () => (feedback.textContent = t('activity.copied')),
      () => (feedback.textContent = t('claim.copyFailed')),
    );
  });
  return el('span', { class: 'copy-row' }, button, feedback);
}

/** Where the page's own on-chain check of a transaction is shown; filled by `showChainCheck`. */
function chainSlot(txid: string): HTMLElement {
  return el('p', { class: 'chain-check', 'data-chain': 'pending', 'data-txid': txid }, t('activity.chain.checking'));
}

/** Txids with an unfilled chain check slot inside `root`. */
export const pendingChecks = (root: ParentNode): string[] =>
  [...root.querySelectorAll<HTMLElement>('.chain-check[data-chain="pending"]')].map((e) => e.dataset.txid ?? '').filter(Boolean);

/** Writes one verdict into every slot for that txid: a confirmation only from an answer the page checked itself. */
export function showChainCheck(root: ParentNode, txid: string, check: ChainCheck, server: string): void {
  const text =
    check.kind === 'confirmed'
      ? t('activity.chain.confirmed', { height: check.height, server })
      : check.kind === 'mempool'
        ? t('activity.chain.mempool', { server })
        : check.kind === 'unknown'
          ? t('activity.chain.unknown', { server })
          : t('activity.chain.failed', { server, reason: check.reason });
  for (const slot of root.querySelectorAll<HTMLElement>('.chain-check')) {
    if (slot.dataset.txid !== txid) continue;
    slot.dataset.chain = check.kind;
    slot.textContent = text;
  }
}

function txItem(tx: ActivityTx): HTMLElement {
  const step = label(`activity.step.${tx.step}`, tx.kind);
  const title = tx.epoch === null ? step : `${step}, ${t('activity.epoch', { epoch: tx.epoch })}`;
  const head = el('div', { class: 'tx-head' }, el('span', { class: 'tx-step' }, title), el('time', { datetime: tx.utc }, when(tx.utc)));
  if (tx.error !== undefined) {
    return el(
      'li',
      { class: 'tx refused' },
      head,
      el('p', { class: 'tx-refused' }, t('activity.refused')),
      el('pre', { class: 'tx-error' }, tx.error),
      tx.note === undefined ? false : el('p', { class: 'tx-meta' }, tx.note),
    );
  }
  const meta = [
    t('activity.size', { bytes: num(tx.bytes), fee: num(tx.feeSats) }),
    tx.height === null ? t('activity.unconfirmed') : t('activity.block', { height: tx.height }),
    tx.note,
  ].filter(Boolean);
  return el(
    'li',
    { class: 'tx' },
    head,
    tx.txid === null ? false : el('code', { class: 'hash' }, tx.txid),
    el('p', { class: 'tx-meta' }, meta.join(' · ')),
    tx.txid === null ? false : chainSlot(tx.txid),
    el('div', { class: 'tx-actions' }, ...explorerAnchors(tx.links, 'activity.explorer'), tx.txid === null ? false : copyButton(tx.txid)),
  );
}

function runSection(run: ActivityRun, decimals: number): HTMLElement {
  const heading = label(`activity.runs.${run.run}`, t('activity.run', { run: run.run }));
  const tops = topUps(run.epochs).map((u) =>
    el(
      'div',
      { class: 'topup' },
      el('h4', {}, t('activity.topup.heading', { epoch: u.epoch })),
      el(
        'p',
        {},
        t('activity.topup.text', {
          leaves: num(u.leaves),
          total: formatUnits(u.total, decimals, getLocale()),
          added: formatUnits(u.added, decimals, getLocale()),
          epoch: u.epoch,
          previous: u.previous,
        }),
      ),
    ),
  );
  const list = el('ol', { class: 'txs' }, ...run.transactions.map(txItem));
  return el(
    'section',
    { class: 'run', 'data-run': run.run },
    el('h3', {}, heading),
    el('p', { class: 'note' }, t('activity.count', { count: run.transactions.length, refused: refusedCount(run) })),
    el('p', { class: 'pool' }, el('span', { class: 'rung-label' }, t('activity.pool')), el('code', { class: 'hash' }, run.pool)),
    ...tops,
    list,
  );
}

/** The recorded transactions of every run on one network, plus an empty slot for what the chain shows beyond them. */
export function renderActivity(target: HTMLElement, index: ActivityIndex, networkName: string, decimals: number): HTMLElement {
  const seen = el('section', { class: 'seen', id: 'seen', 'aria-labelledby': 'seen-h' });
  target.replaceChildren(
    el('h2', {}, t('activity.heading', { network: networkName })),
    el('p', { class: 'intro' }, t('activity.intro')),
    ...(index.runs.length === 0 ? [el('p', { class: 'note' }, t('activity.empty', { network: networkName }))] : index.runs.map((r) => runSection(r, decimals))),
    seen,
  );
  return seen;
}

/** Fills the "seen on chain" slot with unrecorded transactions, or says why the chain could not be read. */
export function renderSeen(target: HTMLElement, items: { txid: string; height: number }[] | { error: string }, explorers: readonly Explorer[]): void {
  const parts: HTMLElement[] = [el('h3', { id: 'seen-h' }, t('activity.seen.heading')), el('p', { class: 'note' }, t('activity.seen.text'))];
  if ('error' in items) parts.push(el('p', { class: 'warn', role: 'status' }, items.error));
  else if (items.length === 0) parts.push(el('p', { id: 'seen-none' }, t('activity.seen.none')));
  else parts.push(el('ol', { class: 'txs', id: 'seen-list' }, ...items.map((s) => seenItem(s, explorers))));
  target.replaceChildren(...parts);
}

function seenItem(s: { txid: string; height: number }, explorers: readonly Explorer[]): HTMLElement {
  return el(
    'li',
    { class: 'tx' },
    el('div', { class: 'tx-head' }, el('span', { class: 'tx-step' }, t('activity.seen.item'))),
    el('code', { class: 'hash' }, s.txid),
    el('p', { class: 'tx-meta' }, s.height > 0 ? t('activity.block', { height: s.height }) : t('activity.unconfirmed')),
    chainSlot(s.txid),
    el('div', { class: 'tx-actions' }, ...explorerAnchors(explorerLinks(explorers, s.txid), 'activity.explorer'), copyButton(s.txid)),
  );
}

/** Cumulative amount per epoch for the looked-up address, with each epoch's top-up. */
export function renderHistory(target: HTMLElement, entries: EpochEntry[], decimals: number): void {
  if (entries.length < 2) return;
  const rows = entries.map((e) =>
    el(
      'div',
      { class: 'amount' },
      el('dt', {}, t('history.epoch', { epoch: e.epoch })),
      el(
        'dd',
        {},
        e.cumulative === null
          ? t('history.absent')
          : el('span', { class: 'num' }, formatUnits(e.cumulative, decimals, getLocale())),
        e.topUp === null || e.cumulative === null ? false : el('span', { class: 'unit' }, ` (${t('history.topUp', { amount: formatUnits(e.topUp, decimals, getLocale()) })})`),
      ),
    ),
  );
  const amounts = target.querySelector('.amounts');
  const section = el('section', { class: 'history', 'aria-labelledby': 'history-h' }, el('h3', { id: 'history-h' }, t('history.heading')), el('dl', { class: 'amounts', id: 'history' }, ...rows));
  if (amounts) amounts.after(section);
  else target.append(section);
}
