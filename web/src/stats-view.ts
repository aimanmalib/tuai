// Draws the live numbers strip (markup in index.html) and keeps it fresh on a timer. There is no refresh button:
// the strip reads again every few seconds while the page is visible, and pauses while the tab is hidden.
import { t } from './i18n.ts';
import { formatUnits } from './model.ts';
import { computeStats, type Stats, type StatsSources } from './stats.ts';

export interface StatsLabels {
  locale: string;
  decimals: number;
}

const DASH = '\u2014';

function tile(root: HTMLElement, name: string, value: string | null, note: string): void {
  const el = root.querySelector<HTMLElement>(`#stat-${name}`);
  if (!el) return;
  el.dataset.state = value === null ? 'missing' : 'ok';
  el.querySelector('.stat-value')!.textContent = value ?? DASH;
  el.querySelector('.stat-note')!.textContent = note;
}

const missing = (reason: string) => t('stats.missing', { reason: reason || t('stats.noData') });

/** Fills every tile and the small line under them from one computed set of numbers. */
export function renderStats(root: HTMLElement, s: Stats, at: Date, labels: StatsLabels): void {
  const n = new Intl.NumberFormat(labels.locale);
  const sat = (v: number) => t('stats.sats', { sats: n.format(v) });
  if (s.leaves.ok) tile(root, 'leaves', n.format(s.leaves.value.leaves), t('stats.leavesNote', { epoch: s.leaves.value.epoch }));
  else tile(root, 'leaves', null, missing(s.leaves.reason));
  if (s.claims.ok) {
    const c = s.claims.value;
    const note = c.claimedOnChain === null ? t('stats.claimsNote') : t('stats.claimsOnChain', { count: n.format(c.claimedOnChain) });
    tile(root, 'claims', n.format(c.recorded), note);
  } else tile(root, 'claims', null, missing(s.claims.reason));
  if (s.held.ok) {
    const tokens = formatUnits(s.held.value.tokens, labels.decimals, labels.locale);
    tile(root, 'held', sat(s.held.value.sats), t('stats.heldNote', { tokens }));
  } else tile(root, 'held', null, missing(s.held.reason));
  if (s.cost.ok) {
    const c = s.cost.value;
    const note = c.source === 'recorded' ? t('stats.costRecorded', { count: n.format(c.count) }) : t('stats.costEstimated');
    tile(root, 'cost', sat(c.sats), note);
  } else tile(root, 'cost', null, missing(s.cost.reason));

  const parts: string[] = [];
  if (s.claims.ok) parts.push(t('stats.refused', { count: n.format(s.claims.value.refused) }));
  if (s.relay) parts.push(s.relay.ok ? t('stats.relayLeft', { count: n.format(s.relay.value.claimsLeft) }) : t('stats.relayOff', { reason: s.relay.reason }));
  parts.push(s.tip === null ? t('stats.tipMissing') : t('stats.tip', { height: n.format(s.tip) }));
  parts.push(t('stats.checked', { time: at.toLocaleTimeString(labels.locale, { hour12: false }) }));
  root.querySelector('#stats-line')!.textContent = parts.join(' · ');
}

export interface StatsLoop {
  /** Reads now and restarts the timer; a read still in flight is dropped. */
  refresh(): void;
  /** Draws the last numbers again, for a language switch. */
  redraw(): void;
}

/**
 * Reads, draws, then waits `everyMs` and reads again; the first read happens on the first `refresh`. `active` says whether the strip is on screen; when it is not,
 * or the tab is hidden, the timer stops until `refresh` is called or the tab is shown again.
 */
export function startStats(
  root: HTMLElement,
  everyMs: number,
  read: () => Promise<StatsSources>,
  labels: () => StatsLabels,
  active: () => boolean,
): StatsLoop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let round = 0;
  let last: { stats: Stats; at: Date } | undefined;
  const draw = () => last && renderStats(root, last.stats, last.at, labels());
  async function tick(): Promise<void> {
    clearTimeout(timer);
    const mine = ++round;
    if (document.hidden || !active()) return;
    root.setAttribute('aria-busy', 'true');
    const sources = await read();
    if (mine !== round) return;
    last = { stats: computeStats(sources), at: new Date() };
    draw();
    root.removeAttribute('aria-busy');
    timer = setTimeout(() => void tick(), everyMs);
  }
  document.addEventListener('visibilitychange', () => void tick());
  return { refresh: () => void tick(), redraw: draw };
}
