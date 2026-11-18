import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { epoch, fakeElectrum } from './fake-electrum.ts';

const leaf = epoch.leaves[150]!;

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

async function checkAddress(page: Page, address: string): Promise<void> {
  await page.getByLabel(/Your address|Alamat anda/).fill(address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
}

test('shows the leaf, the proof verified against the chain root, and the claim command', async ({ page }) => {
  const errors = watchConsole(page);
  await fakeElectrum(page, { claimed: [{ leaf, amount: 1n }] });
  await page.goto('/');
  await expect(page.getByRole('note')).toContainText('BCH BLAZE 2026');
  await checkAddress(page, leaf.address.split(':')[1]!);
  await expect(page.locator('#proof-ok')).toBeVisible();
  await expect(page.locator('#warn-root')).toHaveCount(0);
  await expect(page.locator('.ladder .rung')).toHaveCount(epoch.depth + 1);
  await expect(page.locator('.root.ok')).toHaveCount(2);
  await expect(page.locator('#claim-command')).toContainText(`claim ${leaf.address} --network chipnet --epoch deployments/chipnet/epoch-${epoch.epoch}.json`);
  await expect(page.locator('#gate-pending')).toHaveText('No new root is waiting.');
  await noHorizontalOverflow(page);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-f6-result-${test.info().project.name}.png`, fullPage: true });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('warns by name when the chain root differs from the epoch file root', async ({ page }) => {
  await fakeElectrum(page, { root: 'ab'.repeat(32) });
  await page.goto('/');
  await checkAddress(page, leaf.address);
  await expect(page.locator('#warn-root')).toContainText('Root mismatch');
  await expect(page.locator('#warn-root')).toContainText('ab'.repeat(32));
  await expect(page.locator('#proof-ok')).toHaveCount(0);
  await expect(page.locator('.root.bad')).toHaveCount(1);
});

test('shows a pending root, switches to Malay, and keeps the result', async ({ page }) => {
  await fakeElectrum(page, { tip: 400_000, pendingHeight: 399_990 });
  await page.goto('/');
  await checkAddress(page, leaf.address);
  await expect(page.locator('#gate-pending')).toContainText(`Epoch ${epoch.epoch + 1} is in its audit window`);
  await page.getByRole('button', { name: /Bahasa Melayu/ }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ms');
  await expect(page.locator('#gate-pending')).toContainText('dalam tempoh audit');
  await expect(page.locator('#proof-ok')).toContainText('Tuntutan dengan bukti ini akan dibayar');
  await page.reload();
  await expect(page.getByRole('button', { name: /Semak alamat/ })).toBeVisible();
});

test('explains an invalid address, a mainnet address and an address without a leaf', async ({ page }) => {
  await fakeElectrum(page);
  await page.goto('/');
  await checkAddress(page, 'bchtest:qqqq');
  await expect(page.getByRole('status').first()).toContainText('not a valid CashAddr');
  await expect(page.getByLabel('Your address')).toHaveAttribute('aria-invalid', 'true');
  await checkAddress(page, 'bitcoincash:qpmhwamhwamhwamhwamhwamhwamhwamhwuyssjyglm');
  await expect(page.getByRole('status').first()).toContainText('This is a bitcoincash address');
  await checkAddress(page, 'bchtest:qpmhwamhwamhwamhwamhwamhwamhwamhwuqz54xlc8');
  await expect(page.getByRole('status').first()).toContainText(`No leaf for this address in epoch ${epoch.epoch}`);
});

test('fits a 320 px screen with a result and the full claim command', async ({ page }) => {
  const errors = watchConsole(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await fakeElectrum(page);
  await page.goto('/');
  await noHorizontalOverflow(page);
  await checkAddress(page, leaf.address);
  await expect(page.locator('#claim-command')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await noHorizontalOverflow(page);
  for (const sel of ['#claim-command', '.ladder', '.banner']) {
    const box = await page.locator(sel).boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(320);
  }
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-f6-320-${test.info().project.name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
