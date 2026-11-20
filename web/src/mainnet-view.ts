// Draws the mainnet card on the home page (markup in index.html) from the published mainnet record. The record is read
// once per page load; a language switch draws the last answer again.
import { t } from './i18n.ts';
import { el, explorerAnchors } from './render.ts';
import { getJson } from './fetch-json.ts';
import { mainnetSummary, shortTxid, type MainnetSummary } from './mainnet.ts';
import type { ActivityIndex } from './activity.ts';
import type { Explorer } from '../../src/explorers.ts';

export interface MainnetCard {
  /** Draws the last answer again, for a language switch. */
  redraw(): void;
}

type Answer = { ok: true; summary: MainnetSummary } | { ok: false; reason: string };

function draw(root: HTMLElement, answer: Answer | undefined, locale: string): void {
  const count = root.querySelector<HTMLElement>('#mainnet-count')!;
  const latest = root.querySelector<HTMLElement>('#mainnet-latest')!;
  root.setAttribute('aria-busy', String(answer === undefined));
  if (answer === undefined) {
    count.textContent = t('mainnet.loading');
    latest.replaceChildren();
    return;
  }
  if (!answer.ok) {
    count.textContent = t('mainnet.failed', { reason: answer.reason });
    latest.replaceChildren();
    return;
  }
  const n = new Intl.NumberFormat(locale);
  const s = answer.summary;
  count.replaceChildren(el('strong', { class: 'mainnet-number' }, n.format(s.claims)), ' ', t('mainnet.count', { refused: n.format(s.refused) }));
  const c = s.latest;
  if (c === null) {
    latest.textContent = t('mainnet.none');
    return;
  }
  const where = c.height === null ? t('mainnet.unmined') : t('mainnet.block', { height: n.format(c.height) });
  latest.replaceChildren(
    el('span', {}, t('mainnet.latest', { where, time: `${c.utc.replace('T', ' ').slice(0, 16)} UTC` })),
    el('code', { class: 'hash', title: c.txid }, shortTxid(c.txid)),
    el('span', { class: 'explorer-links' }, ...explorerAnchors(c.links, 'activity.explorer')),
  );
}

/** Shows the card and reads the mainnet record; `explorers` are the configured mainnet explorers. */
export function startMainnetCard(root: HTMLElement, epochsPath: string, explorers: readonly Explorer[], locale: () => string): MainnetCard {
  let answer: Answer | undefined;
  root.hidden = false;
  draw(root, answer, locale());
  getJson<ActivityIndex>(`${epochsPath}/mainnet/transactions.json`).then(
    (index) => void (answer = { ok: true, summary: mainnetSummary(index, explorers) }),
    (e: unknown) => void (answer = { ok: false, reason: e instanceof Error ? e.message : String(e) }),
  ).finally(() => draw(root, answer, locale()));
  return { redraw: () => draw(root, answer, locale()) };
}
