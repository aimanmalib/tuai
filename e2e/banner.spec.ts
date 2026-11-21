// The entry banner: slides served by this site, the source, and the new-project note linked to the first commit.
// It must wrap on a phone without sideways scrolling, also in Bahasa Melayu at 320 px.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, fakeElectrum } from './fake-electrum.ts';

const full = config as unknown as {
  relay: { statusPath: string };
  banner: { deckUrl: string; repoUrl: string; firstCommit: string; prizeAddress: string };
};
const { banner } = full;

async function setUp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fakeElectrum(page);
  await page.route(`**${full.relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  return errors;
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
    b: document.querySelector('.banner')!.scrollWidth,
    bc: document.querySelector('.banner')!.clientWidth,
  }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  expect(o.b).toBeLessThanOrEqual(o.bc);
}

test('links the slides served by this site, the source and the first commit', async ({ page, request }) => {
  const errors = await setUp(page);
  await page.goto('/');
  const deck = page.locator('#banner-deck');
  await expect(deck).toHaveText('Slides');
  const href = (await deck.getAttribute('href'))!;
  expect(href).toMatch(new RegExp(`^${banner.deckUrl.replace(/[.]/g, '\\.')}\\?v=[0-9a-f]{12}$`));
  const pdf = await request.get(href);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await expect(page.locator('#banner-repo')).toHaveAttribute('href', banner.repoUrl);
  await expect(page.locator('#banner-prize')).toHaveText(banner.prizeAddress);
  const note = page.locator('#banner-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveText('New project, first commit after the 14 November start');
  await expect(note).toHaveAttribute('href', `${banner.repoUrl}/commit/${banner.firstCommit}`);
  await expect(note).toHaveAttribute('title', new RegExp(banner.firstCommit.slice(0, 7)));
  await noSidewaysScroll(page);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-a1-banner-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).include('.banner').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Bahasa Melayu at 320 px, after scrolling: translated links and the banner wraps without sideways scroll', async ({ page }) => {
  const errors = await setUp(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.locator('#lang').click();
  await expect(page.locator('#banner-deck')).toHaveText('Slaid');
  await expect(page.locator('#banner-prize')).toHaveText(banner.prizeAddress);
  await expect(page.locator('#banner-note')).toHaveText('Projek baharu, komit pertama selepas permulaan 14 November');
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.evaluate(() => window.scrollTo(0, 0));
  await noSidewaysScroll(page);
  const box = await page.locator('#banner-note').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5e-banner-ms-320-${test.info().project.name}.png` });
  }
  expect(errors).toEqual([]);
});
