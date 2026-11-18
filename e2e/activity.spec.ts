import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { epoch, fakeElectrum, record } from './fake-electrum.ts';

// The record the page must show: every chipnet run's transactions.json, read from the repository.
const runs = readdirSync('deployments')
  .filter((r) => existsSync(`deployments/${r}/transactions.json`))
  .map((r) => JSON.parse(readFileSync(`deployments/${r}/transactions.json`, 'utf8')) as { network: string; transactions: { txid: string | null; error?: string; height: number | null }[] })
  .filter((r) => r.network === 'chipnet');
const all = runs.flatMap((r) => r.transactions);
const refused = all.filter((t) => t.error !== undefined).length;
const mined = all.filter((t) => t.txid !== null && t.error === undefined);
// A claim someone made after the record was written: in the pool's history, not in any file.
const LATER = 'fe'.repeat(32);
const history = { [record.contracts.pool]: [...mined.slice(0, 3).map((t) => ({ tx_hash: t.txid!, height: t.height ?? 0 })), { tx_hash: LATER, height: 400_001 }] };

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
  await noHorizontalOverflow(page);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r1-activity-${test.info().project.name}.png`, fullPage: true });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('keeps the record when the chain cannot be read, and switches to Malay', async ({ page }) => {
  await page.routeWebSocket(/.*/, (ws) => ws.close());
  await page.goto('/#/activity');
  await expect(page.locator('.run .txs > li')).toHaveCount(all.length);
  await expect(page.locator('#seen .warn')).toContainText('Could not read the pool history');
  await page.getByRole('button', { name: /Bahasa Melayu/ }).click();
  await expect(page.locator('.run .tx-refused').first()).toHaveText('Ditolak nod');
  await expect(page.locator('#nav-activity')).toHaveText('Aktiviti');
});

test('shows the per-epoch history with the top-up on an address result', async ({ page }) => {
  await fakeElectrum(page);
  await page.goto('/');
  const leaf = epoch.leaves[0]!;
  await page.getByLabel('Your address').fill(leaf.address);
  await page.getByRole('button', { name: 'Check address' }).click();
  await expect(page.locator('#history .amount')).toHaveCount(2);
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
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r1-320-${test.info().project.name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
