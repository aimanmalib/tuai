// Claim page: reads config, epoch files and chain state, then shows one address's leaf, proof and claim command.
import config from '../../config/tuai.json' with { type: 'json' };
import { applyStatic, getLocale, setLocale, t, type Locale } from './i18n.ts';
import { readChain } from './electrum.ts';
import { chainViewFrom, claimCommand, lookup, openLeaves, parseAddress, pendingBlocksLeft, type ChainView, type EpochFileView, type PoolRecord } from './model.ts';
import { renderClaim, renderGate, renderResult } from './render.ts';
import { getJson } from './fetch-json.ts';
import { epochHistory } from './activity.ts';
import { renderHistory } from './activity-view.ts';
import { showActivity } from './activity-page.ts';
import { relayStatus, type RelayAnswer, type RelayStatus } from './relay.ts';
import { renderNotice, renderRelay } from './relay-view.ts';
import { addressToLockingBytecode, type CashAddressPrefix } from '../../src/leaf.ts';
import { renderWalletClaim } from './wallet-view.ts';
import { formatUnits } from './model.ts';
import { explorersOf, type Explorer } from '../../src/explorers.ts';
import { HERO_COSTS, heroCostLines } from './hero.ts';
import { loadStats } from './stats-load.ts';
import { startStats } from './stats-view.ts';
import { refreshMs } from './stats.ts';
import { isVideoHash, mountVideo } from './video-view.ts';
import { startMainnetCard } from './mainnet-view.ts';
import { mountBanner } from './banner.ts';

type NetworkKey = 'chipnet' | 'mainnet';
const web = config.web;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = byId<HTMLFormElement>('lookup');
const input = byId<HTMLInputElement>('address');
const select = byId<HTMLSelectElement>('network');
const status = byId<HTMLElement>('status');
const result = byId<HTMLElement>('result');
const walletBalanceSlot = byId<HTMLElement>('wallet-balance');
const gate = byId<HTMLElement>('gate');

function networkConfig(n: NetworkKey) {
  return config.networks[n] as { addressPrefix: string; electrum: { wssUrl: string }; sequenceBlockScale?: number; explorerTxUrl?: string; explorers?: Explorer[] };
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
  mountBanner(
    { deck: byId<HTMLAnchorElement>('banner-deck'), source: byId<HTMLAnchorElement>('banner-repo'), note: byId<HTMLAnchorElement>('banner-note'), noteDot: byId('banner-note-dot') },
    config.banner,
    __TUAI_DECK_VERSION__,
    t,
  );
  const costs = heroCostLines(HERO_COSTS, t, localeTag());
  byId('hero-cost-push').textContent = costs.push;
  byId('hero-cost-pull').textContent = costs.pull;
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
  byId<HTMLAnchorElement>('link-source').href = repo;
  byId<HTMLAnchorElement>('link-spec').href = `${repo}/blob/main/docs/SPEC.md`;
  byId<HTMLAnchorElement>('link-measured').href = `${repo}/blob/main/docs/MEASURED.md`;
  byId<HTMLAnchorElement>('hero-costs-link').href = `${repo}/blob/main/docs/COST.md`;
}

let lastQuery: string | undefined;
const relayCfg = config.relay;
const relayOn = (n: NetworkKey) => (relayCfg.networks as string[]).includes(n);
/** Wallet claims are prepared on the networks in relay.wallet.networks; the prepare route never signs or spends. */
const walletOn = (n: NetworkKey) => relayCfg.wallet.enabled && (relayCfg.wallet.networks as string[]).includes(n);
const OFF: RelayStatus = { network: '', enabled: false, reason: 'off' };

/** Pool record, epoch list and chain view of a network, or the message to show instead. */
async function loadPool(network: NetworkKey): Promise<{ record: PoolRecord; index: { epochs: number[] }; chain: ChainView } | string> {
  const net = networkConfig(network);
  const base = `${web.epochsPath}/${network}`;
  let record: PoolRecord;
  let index: { epochs: number[] };
  try {
    [record, index] = await Promise.all([getJson<PoolRecord>(`${base}/pool.json`), getJson<{ epochs: number[] }>(`${base}/index.json`)]);
  } catch (e) {
    return t('error.files', { reason: (e as Error).message });
  }
  try {
    const reads = await readChain(net.electrum.wssUrl, web.electrumTimeoutSeconds * 1000, record.contracts);
    return { record, index, chain: chainViewFrom(record, reads.tip, reads.pool, reads.gate, reads.vault) };
  } catch (e) {
    return t('error.chain', { server: new URL(net.electrum.wssUrl).hostname, reason: (e as Error).message });
  }
}

async function check(query: string, notice?: RelayAnswer): Promise<void> {
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
  const relay = relayOn(network) ? relayStatus(relayCfg.statusPath, web.electrumTimeoutSeconds * 1000) : Promise.resolve(OFF);
  const loaded = await loadPool(network);
  if (typeof loaded === 'string') {
    showStatus(loaded, 'error');
    return;
  }
  const { record, index, chain } = loaded;
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
  if (relayOn(network) && found.fileMatchesChain === 'match') {
    renderRelay(result, {
      status: await relay,
      address,
      claimable: found.claimable,
      claimed: found.claimed,
      claimPath: relayCfg.claimPath,
      timeoutMs: 120_000,
      explorers: explorersOf(net),
      notice,
      onSent: (answer) => void check(query, answer),
    });
  }
  // Without the relayer card (mainnet), the card is read again after a wallet claim with nothing left to claim, so the
  // claim's transaction is shown on its own; otherwise it would vanish as soon as the chain is read again.
  if (!relayOn(network) && notice) renderNotice(result, notice, explorersOf(net));
  const walletCfg = relayCfg.wallet;
  // On the relayer's network the same container answers prepare, so an unreachable or switched-off relayer hides the
  // wallet button there. Elsewhere there is no relayer status to wait for; a switched-off route answers `off` itself.
  const st = relayOn(network) ? await relay : undefined;
  const relayUp = !st || (st.reason !== 'off' && st.reason !== 'unreachable');
  if (walletOn(network) && found.fileMatchesChain === 'match' && found.claimable > 0n && relayUp) {
    renderWalletClaim(result, {
      network,
      relayer: relayOn(network),
      address,
      prefix: net.addressPrefix,
      claimable: found.claimable,
      amountText: formatUnits(found.claimable, config.rewards.decimals, getLocale()),
      check: {
        leaf: parsed.lockingBytecode,
        pool: addressToLockingBytecode(record.contracts.pool),
        vault: addressToLockingBytecode(record.contracts.vault),
        rewardCategory: record.rewardCategory,
        claimable: found.claimable,
        maxSpendSats: BigInt(walletCfg.maxSpendSats),
      },
      preparePath: walletCfg.preparePath,
      scan: { gapLimit: walletCfg.gapLimit, maxAddressesPerScan: walletCfg.maxAddressesPerScan, maxAddresses: walletCfg.maxAddresses },
      relayUrls: walletCfg.relayUrls,
      liveness: { graceMs: walletCfg.reconnectGraceSeconds * 1000, livenessMs: walletCfg.livenessSeconds * 1000 },
      timeoutMs: 120_000,
      explorers: explorersOf(net),
      balance: {
        slot: walletBalanceSlot,
        electrumUrl: net.electrum.wssUrl,
        timeoutMs: web.electrumTimeoutSeconds * 1000,
        decimals: config.rewards.decimals,
        everyMs: web.walletBalanceRefreshSeconds * 1000,
      },
      onSent: (answer) => void check(query, answer),
    });
  }
  if (found.claimable > 0n) renderClaim(result, claimCommand(address, network, file.epoch, web.deploymentsDir));
}

/** Fills in a leaf of the active epoch that still has tokens to claim, then checks it. */
async function pickDemo(): Promise<void> {
  const network = select.value as NetworkKey;
  showStatus(t('checking'));
  const loaded = await loadPool(network);
  if (typeof loaded === 'string') {
    showStatus(loaded, 'error');
    return;
  }
  const { index, chain } = loaded;
  if (!index.epochs.includes(chain.active.epoch)) {
    showStatus(t('error.epochMissing', { epoch: chain.active.epoch }), 'error');
    return;
  }
  const file = await getJson<EpochFileView>(`${web.epochsPath}/${network}/epoch-${chain.active.epoch}.json`);
  const open = openLeaves(file, chain).filter((l) => l.address);
  const leaf = open[Math.floor(Math.random() * open.length)];
  if (!leaf?.address) {
    showStatus(t('relay.demoNone'));
    return;
  }
  input.value = leaf.address;
  await check(leaf.address);
}

byId('demo-pick').addEventListener('click', () => void pickDemo());
// The hero button runs the same demo pick, then brings the claim card (or whatever the check showed) into view.
byId('hero-try').addEventListener('click', () => {
  void pickDemo().then(() => {
    const target = document.getElementById('relay-claim') ?? (result.hidden ? status : result);
    target.scrollIntoView({ block: 'center' });
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void check(input.value);
});

const views = { claim: byId('view-claim'), activity: byId('view-activity') };
const localeTag = () => (getLocale() === 'ms' ? 'ms-MY' : 'en-US');

// The live numbers strip follows the network chosen in the form and reads again on its own timer.
const stats = startStats(
  byId('stats'),
  refreshMs(web.statsRefreshSeconds),
  () => {
    const network = select.value as NetworkKey;
    byId('stats-network').textContent = t(`network.${network}`);
    return loadStats({
      network,
      epochsPath: web.epochsPath,
      wssUrl: networkConfig(network).electrum.wssUrl,
      timeoutMs: web.electrumTimeoutSeconds * 1000,
      relayPath: relayOn(network) ? relayCfg.statusPath : undefined,
      satsPerByte: config.fees.satsPerByte,
    });
  },
  () => ({ locale: localeTag(), decimals: config.rewards.decimals }),
  () => !views.claim.hidden,
);
select.addEventListener('change', () => stats.refresh());

// The mainnet card reads the published mainnet record once; it stays hidden when mainnet is not a configured network.
const mainnetCard = (web.networks as string[]).includes('mainnet')
  ? startMainnetCard(byId('mainnet'), web.epochsPath, explorersOf(networkConfig('mainnet')), localeTag)
  : undefined;

/** Links to each network's record on the activity page, the shown one marked; hidden with a single network. */
function renderNetworkSwitch(shown: NetworkKey): void {
  const nav = byId('activity-networks');
  nav.hidden = web.networks.length < 2;
  nav.replaceChildren(
    ...web.networks.map((n) => {
      const a = document.createElement('a');
      a.href = `#/activity/${n}`;
      a.textContent = t(`network.${n}`);
      if (n === shown) a.setAttribute('aria-current', 'true');
      return a;
    }),
  );
}

/** `#/activity` (or `#/activity/<network>`) shows the transaction record; anything else shows the address check. */
function route(): void {
  const match = /^#\/activity(?:\/([a-z]+))?$/.exec(location.hash);
  const activity = match !== null;
  views.claim.hidden = activity;
  views.activity.hidden = !activity;
  for (const [id, on] of [['nav-claim', !activity], ['nav-activity', activity]] as const) {
    if (on) byId(id).setAttribute('aria-current', 'page');
    else byId(id).removeAttribute('aria-current');
  }
  if (!activity) stats.refresh();
  if (isVideoHash(location.hash)) byId('demo-video').scrollIntoView();
  if (activity) {
    const asked = match[1];
    const key = (asked !== undefined && (web.networks as string[]).includes(asked) ? asked : select.value) as NetworkKey;
    renderNetworkSwitch(key);
    const net = networkConfig(key);
    const target = { key, name: t(`network.${key}`), wssUrl: net.electrum.wssUrl, explorers: explorersOf(net) };
    const limits = { timeoutMs: web.electrumTimeoutSeconds * 1000, concurrency: web.chainCheckConcurrency, attempts: web.chainCheckAttempts };
    void showActivity(byId('activity'), byId('activity-status'), web.epochsPath, target, limits, config.rewards.decimals);
  }
}

byId('lang').addEventListener('click', () => {
  setLocale(getLocale() === 'en' ? 'ms' : 'en');
  localStorage.setItem(web.localeStorageKey, getLocale());
  renderStatic();
  byId('stats-network').textContent = t(`network.${select.value}`);
  stats.redraw();
  mainnetCard?.redraw();
  if (!views.activity.hidden) route();
  else if (lastQuery !== undefined) void check(lastQuery);
});
window.addEventListener('hashchange', route);

setLocale(initialLocale());
setLinks();
mountVideo(byId<HTMLVideoElement>('video-player'), byId<HTMLButtonElement>('video-play'), byId<HTMLAnchorElement>('video-download'));
renderStatic();
select.value = web.defaultNetwork;
route();
const fromUrl = new URLSearchParams(location.search).get('address');
if (fromUrl) {
  input.value = fromUrl;
  void check(fromUrl);
}
