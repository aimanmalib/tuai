// Claim page: reads config, epoch files and chain state, then shows one address's leaf, proof and claim command.
import config from '../../config/tuai.json' with { type: 'json' };
import { applyStatic, getLocale, setLocale, t, type Locale } from './i18n.ts';
import { readChain } from './electrum.ts';
import { chainViewFrom, claimCommand, lookup, parseAddress, pendingBlocksLeft, type ChainView, type EpochFileView, type PoolRecord } from './model.ts';
import { renderClaim, renderGate, renderResult } from './render.ts';
import { getJson } from './fetch-json.ts';
import { epochHistory } from './activity.ts';
import { renderHistory } from './activity-view.ts';
import { showActivity } from './activity-page.ts';
import type { CashAddressPrefix } from '../../src/leaf.ts';

type NetworkKey = 'chipnet' | 'mainnet';
const web = config.web;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = byId<HTMLFormElement>('lookup');
const input = byId<HTMLInputElement>('address');
const select = byId<HTMLSelectElement>('network');
const status = byId<HTMLElement>('status');
const result = byId<HTMLElement>('result');
const gate = byId<HTMLElement>('gate');

function networkConfig(n: NetworkKey) {
  return config.networks[n] as { addressPrefix: string; electrum: { wssUrl: string }; sequenceBlockScale?: number; explorerTxUrl?: string };
}

function showStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  status.className = kind === 'error' ? 'status error' : 'status';
  status.textContent = text;
}

function initialLocale(): Locale {
  const stored = localStorage.getItem(web.localeStorageKey);
  if (stored === 'en' || stored === 'ms') return stored;
  if (navigator.language.toLowerCase().startsWith('ms')) return 'ms';
  return web.defaultLocale as Locale;
}

function renderStatic(): void {
  document.documentElement.lang = getLocale();
  document.title = t('title');
  applyStatic(document);
  byId('banner-entry').textContent = t('bannerEntry', { event: config.banner.event, bounty: config.banner.bounty });
  byId('banner-prize').textContent = config.banner.prizeAddress;
  const lang = byId<HTMLButtonElement>('lang');
  lang.textContent = t('langOther');
  lang.lang = getLocale() === 'en' ? 'ms' : 'en';
  lang.setAttribute('aria-label', `${t('langLabel')}: ${t('langOther')}`);
  const current = select.value;
  select.replaceChildren(...web.networks.map((n) => new Option(t(`network.${n}`), n)));
  if (current) select.value = current;
  byId('network-field').hidden = web.networks.length < 2;
}

function setLinks(): void {
  const repo = config.project.repoUrl;
  byId<HTMLAnchorElement>('banner-repo').href = repo;
  byId<HTMLAnchorElement>('link-source').href = repo;
  byId<HTMLAnchorElement>('link-spec').href = `${repo}/blob/main/docs/SPEC.md`;
  byId<HTMLAnchorElement>('link-measured').href = `${repo}/blob/main/docs/MEASURED.md`;
}

let lastQuery: string | undefined;

async function check(query: string): Promise<void> {
  lastQuery = query;
  const network = select.value as NetworkKey;
  const net = networkConfig(network);
  result.hidden = true;
  const parsed = parseAddress(query, net.addressPrefix as CashAddressPrefix);
  if (!parsed.ok) {
    const text =
      parsed.reason === 'wrongNetwork'
        ? t('error.wrongNetwork', { prefix: parsed.prefix ?? '', network: t(`network.${network}`), expected: net.addressPrefix })
        : t('error.invalid');
    showStatus(text, 'error');
    input.setAttribute('aria-invalid', 'true');
    return;
  }
  input.removeAttribute('aria-invalid');
  showStatus(t('checking'));
  const base = `${web.epochsPath}/${network}`;
  let record: PoolRecord;
  let index: { epochs: number[] };
  try {
    [record, index] = await Promise.all([getJson<PoolRecord>(`${base}/pool.json`), getJson<{ epochs: number[] }>(`${base}/index.json`)]);
  } catch (e) {
    showStatus(t('error.files', { reason: (e as Error).message }), 'error');
    return;
  }
  let chain: ChainView;
  try {
    const reads = await readChain(net.electrum.wssUrl, web.electrumTimeoutSeconds * 1000, record.contracts);
    chain = chainViewFrom(record, reads.tip, reads.pool, reads.gate, reads.vault);
  } catch (e) {
    showStatus(t('error.chain', { server: new URL(net.electrum.wssUrl).hostname, reason: (e as Error).message }), 'error');
    return;
  }
  const scale = net.sequenceBlockScale ?? 1;
  renderGate(gate, chain, pendingBlocksLeft(chain, record, scale), record.activationDelay * scale, config.production.activationDelayBlocks);
  // Show the file for the epoch the pool holds; without one, the newest file, so the mismatch is visible.
  const epoch = index.epochs.includes(chain.active.epoch) ? chain.active.epoch : index.epochs.at(-1);
  if (epoch === undefined) {
    showStatus(t('error.epochMissing', { epoch: chain.active.epoch }), 'error');
    return;
  }
  const file = await getJson<EpochFileView>(`${base}/epoch-${epoch}.json`);
  const found = lookup(file, chain, parsed.lockingBytecode, record.maxDepth);
  if (found === 'notFound' || found === 'badProof') {
    showStatus(found === 'notFound' ? t('error.notFound', { epoch }) : t('error.badProof'), 'error');
    return;
  }
  showStatus('');
  renderResult(result, found, chain, file.epoch, file.root, config.rewards.decimals);
  try {
    const files = await Promise.all(index.epochs.map((e) => getJson<EpochFileView>(`${base}/epoch-${e}.json`)));
    renderHistory(result, epochHistory(files, parsed.lockingBytecode), config.rewards.decimals);
  } catch {
    // The per-epoch history is extra detail; the result above already stands on its own.
  }
  const address = found.leaf.address ?? query.trim();
  if (found.claimable > 0n) renderClaim(result, claimCommand(address, network, file.epoch, web.deploymentsDir));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void check(input.value);
});

const views = { claim: byId('view-claim'), activity: byId('view-activity') };

/** `#/activity` shows the transaction record; anything else shows the address check. */
function route(): void {
  const activity = location.hash === '#/activity';
  views.claim.hidden = activity;
  views.activity.hidden = !activity;
  for (const [id, on] of [['nav-claim', !activity], ['nav-activity', activity]] as const) {
    if (on) byId(id).setAttribute('aria-current', 'page');
    else byId(id).removeAttribute('aria-current');
  }
  if (activity) {
    const key = select.value as NetworkKey;
    const net = networkConfig(key);
    const target = { key, name: t(`network.${key}`), wssUrl: net.electrum.wssUrl, explorerTxUrl: net.explorerTxUrl };
    void showActivity(byId('activity'), byId('activity-status'), web.epochsPath, target, web.electrumTimeoutSeconds * 1000, config.rewards.decimals);
  }
}

byId('lang').addEventListener('click', () => {
  setLocale(getLocale() === 'en' ? 'ms' : 'en');
  localStorage.setItem(web.localeStorageKey, getLocale());
  renderStatic();
  if (!views.activity.hidden) route();
  else if (lastQuery !== undefined) void check(lastQuery);
});
window.addEventListener('hashchange', route);

setLocale(initialLocale());
setLinks();
renderStatic();
select.value = web.defaultNetwork;
route();
const fromUrl = new URLSearchParams(location.search).get('address');
if (fromUrl) {
  input.value = fromUrl;
  void check(fromUrl);
}
