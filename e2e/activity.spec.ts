import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { config, epoch, fakeElectrum, record } from './fake-electrum.ts';

// The record the page must show: every chipnet run's transactions.json, plus the claims made from the page and by
// auto-claim that an operator checked and recorded beside it (page-claims.json, auto-claims.json), read from the repository.
type Tx = { txid: string | null; error?: string; height: number | null };
type Checked = { network: string; claims: { txid: string; height: number | null }[]; refusals: { message: string }[] };
const chipnetRuns = readdirSync('deployments')
  .filter((r) => existsSync(`deployments/${r}/transactions.json`))
  .map((r) => ({ run: r, ...(JSON.parse(readFileSync(`deployments/${r}/transactions.json`, 'utf8')) as { network: string; transactions: Tx[] }) }))
  .filter((r) => r.network === 'chipnet');
const checked = chipnetRuns.flatMap((r) =>
  ['page-claims.json', 'auto-claims.json']
    .filter((f) => existsSync(`deployments/${r.run}/${f}`))
    .map((f) => JSON.parse(readFileSync(`deployments/${r.run}/${f}`, 'utf8')) as Checked),
);
// Claims a third-party wallet signed on the page (wallet-claims.json beside a run).
const walletClaims = chipnetRuns
  .filter((r) => existsSync(`deployments/${r.run}/wallet-claims.json`))
  .flatMap((r) => (JSON.parse(readFileSync(`deployments/${r.run}/wallet-claims.json`, 'utf8')) as { claims: { txid: string; height: number | null; wallet: string }[] }).claims);
const all: Tx[] = [
  ...chipnetRuns.flatMap((r) => r.transactions),
  ...walletClaims.map((x) => ({ txid: x.txid, height: x.height })),
  ...checked.flatMap((c) => [
    ...c.claims.map((x) => ({ txid: x.txid, height: x.height })),
    ...c.refusals.map((x) => ({ txid: null, height: null, error: x.message })),
  ]),
];
const refused = all.filter((t) => t.error !== undefined).length;
const mined = all.filter((t) => t.txid !== null && t.error === undefined);
// A claim someone made after the record was written: in the pool's history, not in any file.
const LATER = 'fe'.repeat(32);
const history = { [record.contracts.pool]: [...mined.slice(0, 3).map((t) => ({ tx_hash: t.txid!, height: t.height ?? 0 })), { tx_hash: LATER, height: 400_001 }] };

// What the fake server says about some recorded transactions: one confirmed at a block other than the recorded one (so
// the badge must come from the server's answer), one still in the mempool, one failing, one unknown.
const SERVER = new URL(config.networks.chipnet.electrum.wssUrl).hostname;
const CHAIN_HEIGHT = 399_990;
const transactions: Record<string, number | 'mempool' | 'error'> = {
  ...Object.fromEntries(mined.slice(4).map((t) => [t.txid!, CHAIN_HEIGHT])),
  [mined[0]!.txid!]: CHAIN_HEIGHT,
  [mined[1]!.txid!]: 'mempool',
  [mined[2]!.txid!]: 'error',
  [LATER]: 'mempool',
};

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
}

test('lists every recorded transaction, refused ones without a link, and a claim seen only on chain', async ({ page }) => {
  const errors = watchConsole(page);
  await fakeElectrum(page, { history });
  await page.goto('/');
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.locator('#nav-activity')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#view-claim')).toBeHidden();
  await expect(page.locator('.run .txs > li')).toHaveCount(all.length);
  await expect(page.locator('.run .tx.refused')).toHaveCount(refused);
  await expect(page.locator('.run .tx.refused a')).toHaveCount(0);
  await expect(page.locator('.run .tx-refused').first()).toHaveText('Refused by the node');
  await expect(page.locator('.run .tx:not(.refused) a')).toHaveCount(mined.length);
  const first = page.locator('.run .tx:not(.refused)').first();
  await expect(first.locator('a')).toHaveAttribute('href', new RegExp(`/tx/${mined[0]!.txid}$`));
  await expect(page.locator('.topup').first()).toContainText('Epoch 2 top-up');
  await expect(page.locator('#seen-list > li')).toHaveCount(1);
  await expect(page.locator('#seen-list code')).toHaveText(LATER);
  for (const w of walletClaims) {
    const row = page.locator('.run .tx', { has: page.locator(`a[href$="/tx/${w.txid}"]`) });
    await expect(row.locator('.tx-step')).toHaveText('Claim signed by a third-party wallet on the claim page, fee paid by the wallet');
    await expect(row).toContainText(w.wallet);
  }
  await noHorizontalOverflow(page);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r1-activity-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('checks every listed transaction on chain itself and shows what the server answered', async ({ page }) => {
  const errors = watchConsole(page);
  await fakeElectrum(page, { history, transactions });
  await page.goto('/#/activity');
  await expect(page.locator('#seen-list > li')).toHaveCount(1);
  await expect(page.locator('.chain-check[data-chain="pending"]')).toHaveCount(0);
  await expect(page.locator('.run .chain-check')).toHaveCount(mined.length);
  const badge = (txid: string) => page.locator(`.chain-check[data-txid="${txid}"]`).first();
  await expect(badge(mined[0]!.txid!)).toHaveText(`Confirmed on chain, block ${CHAIN_HEIGHT} (checked by this page via ${SERVER})`);
  await expect(badge(mined[1]!.txid!)).toHaveText(`Not in a block yet (checked by this page via ${SERVER})`);
  await expect(badge(mined[2]!.txid!)).toHaveText(`Could not check on chain via ${SERVER}: internal error`);
  await expect(badge(mined[3]!.txid!)).toHaveText(`Could not check: ${SERVER} does not know this transaction`);
  await expect(page.locator('#seen-list .chain-check')).toHaveAttribute('data-chain', 'mempool');
  const confirmedTxids = new Set(Object.entries(transactions).filter(([, v]) => typeof v === 'number').map(([k]) => k));
  const confirmedSlots = mined.filter((t) => confirmedTxids.has(t.txid!)).length;
  await expect(page.locator('.chain-check[data-chain="confirmed"]')).toHaveCount(confirmedSlots);
  await expect(page.locator('.run .tx:not(.refused) a').first()).toHaveText(/^Open in \S+/);
  if (process.env.SCREENSHOT_DIR) {
    await badge(mined[0]!.txid!).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p3b-chain-${test.info().project.name}.png` });
  }
  await page.getByRole('button', { name: /Bahasa Melayu/ }).click();
  await expect(badge(mined[0]!.txid!)).toHaveText(`Disahkan di rantaian, blok ${CHAIN_HEIGHT} (disemak oleh halaman ini melalui ${SERVER})`);
  expect(errors).toEqual([]);
});

test('keeps the record when the chain cannot be read, and switches to Malay', async ({ page }) => {
  await page.routeWebSocket(/.*/, (ws) => ws.close());
  await page.goto('/#/activity');
  await expect(page.locator('.run .txs > li')).toHaveCount(all.length);
  await expect(page.locator('#seen .warn')).toContainText('Could not read the pool history');
  await expect(page.locator('.chain-check[data-chain="pending"]')).toHaveCount(0);
  await expect(page.locator('.chain-check[data-chain="confirmed"]')).toHaveCount(0);
  await expect(page.locator('.run .chain-check').first()).toContainText('Could not check on chain');
  await page.getByRole('button', { name: /Bahasa Melayu/ }).click();
  await expect(page.locator('.run .tx-refused').first()).toHaveText('Ditolak nod');
  await expect(page.locator('#nav-activity')).toHaveText('Aktiviti');
});

test('shows the per-epoch history with the top-up on an address result', async ({ page }) => {
  await fakeElectrum(page);
  await page.goto('/');
  const leaf = epoch.leaves[0]!;
  // One amount per published epoch that lists the leaf, counted from the epoch files the page serves.
  const epochsWithLeaf = readdirSync('deployments/chipnet')
    .filter((f) => /^epoch-\d+\.json$/.test(f))
    .filter((f) => (JSON.parse(readFileSync(`deployments/chipnet/${f}`, 'utf8')) as { leaves: { address: string }[] }).leaves.some((l) => l.address === leaf.address)).length;
  await page.getByLabel('Your address').fill(leaf.address);
  await page.getByRole('button', { name: 'Check address' }).click();
  await expect(page.locator('#history .amount')).toHaveCount(epochsWithLeaf);
  await expect(page.locator('#history')).toContainText('top-up');
});

test('fits a 320 px screen with the activity list scrolled to the end', async ({ page }) => {
  const errors = watchConsole(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await fakeElectrum(page, { history });
  await page.goto('/#/activity');
  await expect(page.locator('#seen-list > li')).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await noHorizontalOverflow(page);
  for (const sel of ['.tx-error', '.run .hash', '#seen-list .hash']) {
    const box = await page.locator(sel).first().boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(320);
  }
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r1-320-${test.info().project.name}.png` });
  }
  expect(errors).toEqual([]);
});

// Mainnet runs, read from the repository like the chipnet ones above.
const mainnetRuns = readdirSync('deployments')
  .filter((r) => existsSync(`deployments/${r}/transactions.json`))
  .map((r) => JSON.parse(readFileSync(`deployments/${r}/transactions.json`, 'utf8')) as { network: string; transactions: Tx[] })
  .filter((r) => r.network === 'mainnet');

test('switches the record between networks from the activity page', async ({ page }) => {
  test.skip(mainnetRuns.length === 0, 'no mainnet run is recorded');
  const mainnetTxs = mainnetRuns.flatMap((r) => r.transactions);
  await page.routeWebSocket(/.*/, (ws) => ws.close());
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/#/activity');
  const links = page.locator('#activity-networks a');
  await expect(links).toHaveText(['Chipnet (test network)', 'Mainnet']);
  await expect(links.first()).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.run .txs > li')).toHaveCount(all.length);
  await links.last().click();
  await expect(page).toHaveURL(/#\/activity\/mainnet$/);
  await expect(page.locator('#nav-activity')).toHaveAttribute('aria-current', 'page');
  await expect(links.last()).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.run .txs > li')).toHaveCount(mainnetTxs.length);
  await expect(page.locator('.run h3').first()).toContainText('Mainnet pool');
  const intro = page.locator('p.intro', { hasText: 'Electrum' });
  await expect(intro).toContainText(new URL(config.networks.mainnet.electrum.wssUrl).hostname);
  await expect(intro).not.toContainText('chipnet');
  const firstMined = mainnetTxs.find((t) => t.txid !== null && t.error === undefined)!;
  await expect(page.locator('.run .tx:not(.refused) a').first()).toHaveAttribute('href', new RegExp(`/tx/${firstMined.txid}$`));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await noHorizontalOverflow(page);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-mn1-activity-${test.info().project.name}.png` });
  await links.first().click();
  await expect(page.locator('.run .txs > li')).toHaveCount(all.length);
});
