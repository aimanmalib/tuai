// The hero above the address form: visible without scrolling, measured numbers filled in, and the demo button
// leading straight to the Claim card. Chain reads go to the fake Electrum server, the relayer is answered here.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, fakeElectrum } from './fake-electrum.ts';

const relay = (config as unknown as { relay: { statusPath: string } }).relay;

async function setUp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await fakeElectrum(page);
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  return errors;
}

test('shows the sentence, the drawing, both costs and the demo button above the fold', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('/');
  await expect(page.locator('#hero-cost-pull')).not.toBeEmpty();
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5a-hero-${test.info().project.name}.png` });
  }
  for (const id of ['hero-line', 'push-pull', 'hero-try']) await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#hero-line')).toHaveText(/Folders claim their own FLDCH/);
  for (const id of ['hero-cost-push', 'hero-cost-pull']) {
    const text = await page.locator(`#${id}`).innerText();
    expect(text).toMatch(/\d/);
    expect(text).not.toMatch(/[{}]/);
  }
  await expect(page.locator('#push-pull')).toHaveAccessibleName('Push compared with pull');
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the demo button fills a demo address and brings the Claim card into view', async ({ page }) => {
  await setUp(page);
  await page.goto('/');
  await page.locator('#hero-try').click();
  await expect(page.locator('#address')).toHaveValue(/^bchtest:/);
  await expect(page.locator('#relay-claim')).toBeInViewport();
});

test('switches to Malay and stays inside a 320 px screen', async ({ page }) => {
  await setUp(page);
  await page.goto('/');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator('#lang').click();
  await expect(page.locator('#hero-line')).toHaveText(/Pelipat menuntut/);
  await expect(page.locator('#hero-cost-pull')).toHaveText(/^Tarik: [\d,.]+ sat/);
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
});

test('holds the drawing still when reduced motion is asked for', async ({ page }) => {
  await setUp(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const names = await page.locator('#push-pull .pp-paid circle, #push-pull .pp-claims path').evaluateAll((els) =>
    els.map((e) => getComputedStyle(e).animationName),
  );
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names)).toEqual(new Set(['none']));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const moving = await page.locator('#push-pull .pp-claims path').first().evaluate((e) => getComputedStyle(e).animationName);
  expect(moving).toBe('pp-claim');
});
