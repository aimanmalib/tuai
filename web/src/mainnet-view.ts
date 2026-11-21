// Draws the mainnet card on the home page (markup in index.html) from the published mainnet record. The record is read
// once per page load; a language switch draws the last answer again.
import { t } from './i18n.ts';
import { el, explorerAnchors } from './render.ts';
import { getJson } from './fetch-json.ts';
import { mainnetSummary, shortTxid, type MainnetSummary } from './mainnet.ts';
import type { ActivityIndex } from './activity.ts';
import type { Explorer } from '../../src/explorers.ts';
import { distroInputFiles, realFolders, type EpochFolders, type EpochForFolders } from './folders.ts';

export interface MainnetCard {
  /** Draws the last answer again, for a language switch. */
  redraw(): void;
}

/** The activity view of the mainnet record (see the router in main.ts). */
export const MAINNET_ACTIVITY_HASH = '#/activity/mainnet';

type Answer = { ok: true; summary: MainnetSummary } | { ok: false; reason: string };
type FoldersAnswer = { ok: true; folders: EpochFolders } | { ok: false; reason: string };

/** Reads the newest mainnet epoch and the distribution responses its manifest names, then counts the real folders. */
async function readFolders(base: string): Promise<EpochFolders> {
  const { epochs } = await getJson<{ epochs: number[] }>(`${base}/index.json`);
  if (epochs.length === 0) throw new Error('no epoch is served');
  const epoch = await getJson<EpochForFolders>(`${base}/epoch-${Math.max(...epochs)}.json`);
  const responses = await Promise.all(distroInputFiles(epoch).map((f) => getJson<unknown>(`${base}/${f}`)));
  return realFolders(epoch, responses);
}

function drawFolders(p: HTMLElement, answer: FoldersAnswer | undefined, locale: string): void {
  if (answer === undefined) {
    p.textContent = '';
    return;
  }
  if (!answer.ok) {
    p.textContent = t('mainnet.foldersFailed', { reason: answer.reason });
    return;
  }
  const n = new Intl.NumberFormat(locale);
  const f = answer.folders;
  p.replaceChildren(
    el('strong', { class: 'mainnet-number' }, n.format(f.folders)),
    ' ',
    t('mainnet.folders', { epoch: n.format(f.epoch), legacy: n.format(f.legacy) }),
  );
}

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
  let folders: FoldersAnswer | undefined;
  const foldersLine = root.querySelector<HTMLElement>('#mainnet-folders')!;
  root.querySelector<HTMLAnchorElement>('#mainnet-activity')!.href = MAINNET_ACTIVITY_HASH;
  root.hidden = false;
  draw(root, answer, locale());
  getJson<ActivityIndex>(`${epochsPath}/mainnet/transactions.json`).then(
    (index) => void (answer = { ok: true, summary: mainnetSummary(index, explorers) }),
    (e: unknown) => void (answer = { ok: false, reason: e instanceof Error ? e.message : String(e) }),
  ).finally(() => draw(root, answer, locale()));
  drawFolders(foldersLine, folders, locale());
  readFolders(`${epochsPath}/mainnet`).then(
    (f) => void (folders = { ok: true, folders: f }),
    (e: unknown) => void (folders = { ok: false, reason: e instanceof Error ? e.message : String(e) }),
  ).finally(() => drawFolders(foldersLine, folders, locale()));
  return {
    redraw: () => {
      draw(root, answer, locale());
      drawFolders(foldersLine, folders, locale());
    },
  };
}
