// The live numbers strip under the hero: four tiles with numbers from the published record, the fake Electrum server
// and the relayer, and fresh numbers after the data changes, with no click.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fakeElectrum, type FakeChain } from './fake-electrum.ts';

const full = JSON.parse(readFileSync('config/tuai.json', 'utf8')) as {
  relay: { statusPath: string };
  web: { statsRefreshSeconds: number; epochsPath: string };
};
// One refresh period plus room for the reads themselves on a loaded machine.
const AFTER_REFRESH = (full.web.statsRefreshSeconds + 20) * 1000;

async function setUp(page: Page, chain: FakeChain, relay: { claimsLeft: number; off?: boolean }): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fakeElectrum(page, chain);
  await page.route(`**${full.relay.statusPath}`, (r) =>
    r.fulfill({
      json: relay.off
        ? { network: 'chipnet', enabled: false, reason: 'off' }
        : { network: 'chipnet', enabled: true, claimsLeft: relay.claimsLeft, balanceSats: relay.claimsLeft * 6000, low: false },
    }),
  );
  return errors;
}

const values = (page: Page) => page.locator('#stats .stat-value').allInnerTexts();

test('shows four numbered tiles and the line under them', async ({ page }) => {
  const errors = await setUp(page, { tip: 400_000 }, { claimsLeft: 40 });
  await page.goto('/');
  await expect(page.locator('#stats-line')).toContainText('400,000');
  const v = await values(page);
  expect(v).toHaveLength(4);
  for (const text of v) expect(text).toMatch(/\d/);
  await expect(page.locator('#stat-leaves .stat-value')).toHaveText(/^\d[\d,]*$/);
  await expect(page.locator('#stats-line')).toContainText('about 40 more claims');
  await expect(page.locator('#stats-line')).toContainText(/checked \d{1,2}:\d{2}:\d{2}/);
  await expect(page.locator('#stats-network')).toHaveText(/^Chipnet/);
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('#stats').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5b-stats-${test.info().project.name}.png` });
  }
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  const axe = await new AxeBuilder({ page }).include('#stats').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('changes its numbers after the data changes, without a click', async ({ page }) => {
  const chain: FakeChain = { tip: 400_000 };
  const relay = { claimsLeft: 40 };
  await setUp(page, chain, relay);
  await page.goto('/');
  await expect(page.locator('#stats-line')).toContainText('400,000');
  await expect(page.locator('#stats-line')).toContainText('about 40 more');
  chain.tip = 400_001;
  relay.claimsLeft = 39;
  await expect(page.locator('#stats-line')).toContainText('400,001', { timeout: AFTER_REFRESH });
  await expect(page.locator('#stats-line')).toContainText('about 39 more');
});

test('keeps the other tiles when one source fails, and fits 320 px in Malay', async ({ page }) => {
  await setUp(page, { tip: 400_000 }, { claimsLeft: 0, off: true });
  await page.route(`**${full.web.epochsPath}/chipnet/transactions.json`, (r) => r.fulfill({ status: 404, body: 'gone' }));
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.locator('#lang').click();
  await expect(page.locator('#stat-claims .stat-value')).toHaveText('\u2014');
  await expect(page.locator('#stat-claims .stat-note')).toContainText('Tiada: 404');
  await expect(page.locator('#stat-leaves .stat-value')).toHaveText(/\d/);
  await expect(page.locator('#stat-held .stat-value')).toHaveText(/\d/);
  await expect(page.locator('#stats-line')).toContainText('Relayer demo tidak tersedia (off)');
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('#stats').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5b-stats-ms-320-${test.info().project.name}.png` });
  }
});
