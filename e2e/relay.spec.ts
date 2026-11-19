// The Claim button and Try-again through a fake chipnet relayer (ADR 0009); chain reads go to the fake Electrum server.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, epoch, fakeElectrum } from './fake-electrum.ts';

const relay = (config as unknown as { relay: { statusPath: string; claimPath: string } }).relay;
const leaf = epoch.leaves[150]!;
const TXID = 'ab'.repeat(32);

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Answers the relayer routes; returns the claim bodies the page sent. */
async function fakeRelay(page: Page, status: Record<string, unknown>, answer: Record<string, unknown>): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: status }));
  await page.route(`**${relay.claimPath}`, (r) => {
    sent.push(r.request().postDataJSON());
    return r.fulfill({ json: answer });
  });
  return sent;
}

async function checkAddress(page: Page, address: string): Promise<void> {
  await page.getByLabel(/Your address|Alamat anda/).fill(address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
}

test('claims through the relayer and shows the transaction with an explorer link', async ({ page }) => {
  const errors = watchConsole(page);
  await fakeElectrum(page);
  const sent = await fakeRelay(page, { network: 'chipnet', enabled: true }, { code: 'claimed', txid: TXID, paid: leaf.cumulative });
  await page.goto('/');
  await checkAddress(page, leaf.address);
  const button = page.getByRole('button', { name: /Claim now, fee paid by the demo relayer/ });
  await expect(button).toBeVisible();
  await expect(page.locator('#relay-low')).toHaveCount(0);
  await button.click();
  await expect(page.locator('#relay-txid')).toHaveText(TXID);
  await expect(page.locator('#relay-out a')).toHaveAttribute('href', `${config.networks.chipnet.explorerTxUrl}${TXID}`);
  expect(sent).toEqual([{ address: leaf.address }]);
  await expect(page.locator('#claim-command')).toBeVisible();
  await noHorizontalOverflow(page);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r3-claimed-${test.info().project.name}.png`, fullPage: true });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('says about how many claims are left when the relayer reports low', async ({ page }) => {
  await fakeElectrum(page);
  await fakeRelay(page, { network: 'chipnet', enabled: true, claimsLeft: 2, low: true, warnClaimsLeft: 5 }, { code: 'claimed', txid: TXID });
  await page.goto('/');
  await checkAddress(page, leaf.address);
  await expect(page.locator('#relay-low')).toHaveText('About 2 claims left before the demo relayer runs out of test coins.');
  await expect(page.locator('#relay-claim')).toBeEnabled();
});

test('keeps the button in place but off when the relayer is dry, and says what, why and what to do', async ({ page }) => {
  const errors = watchConsole(page);
  await fakeElectrum(page);
  await fakeRelay(page, { network: 'chipnet', enabled: false, reason: 'lowBalance', claimsLeft: 0, low: true }, { code: 'lowBalance' });
  await page.goto('/');
  await page.setViewportSize({ width: 320, height: 720 });
  await checkAddress(page, leaf.address);
  await expect(page.locator('#relay-off')).toContainText('run out of test coins');
  await expect(page.locator('section[aria-labelledby="relay-h"]')).toContainText('does not depend on it');
  await expect(page.locator('section[aria-labelledby="relay-h"]')).toContainText('command below');
  await expect(page.locator('#relay-claim')).toBeVisible();
  await expect(page.locator('#relay-claim')).toBeDisabled();
  await expect(page.locator('#relay-low')).toHaveCount(0);
  await expect(page.locator('#claim-command')).toBeVisible();
  await page.locator('#claim-command').scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: /Bahasa Melayu|Malay/ }).click();
  await expect(page.locator('#relay-off')).toContainText('Syiling ujian geganti demo sudah habis');
  await expect(page.locator('#relay-claim')).toBeDisabled();
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p3a-dry-320-${test.info().project.name}.png`, fullPage: true });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('names other reasons and keeps the button off when the relayer is switched off', async ({ page }) => {
  await fakeElectrum(page);
  await fakeRelay(page, { network: 'chipnet', enabled: false, reason: 'off' }, { code: 'off' });
  await page.goto('/');
  await checkAddress(page, leaf.address);
  await expect(page.locator('#relay-off')).toContainText('switched off');
  await expect(page.locator('#relay-claim')).toBeDisabled();
  await expect(page.locator('#claim-command')).toBeVisible();
});

test('shows both refusals when an already claimed address tries to claim again, in Malay too', async ({ page }) => {
  const errors = watchConsole(page);
  await fakeElectrum(page, { claimed: [{ leaf, amount: BigInt(leaf.cumulative) }] });
  const sent = await fakeRelay(page, { network: 'chipnet', enabled: true }, {
    code: 'refused',
    local: 'Require statement failed at input 0 in contract ClaimPool',
    network: 'mandatory-script-verify-flag-failed',
  });
  await page.goto('/');
  await page.setViewportSize({ width: 320, height: 720 });
  await checkAddress(page, leaf.address);
  await page.locator('#relay-again').click();
  await expect(page.locator('#relay-refused')).toHaveText('Refused, as the rules require.');
  await expect(page.locator('#relay-out')).toContainText('mandatory-script-verify-flag-failed');
  expect(sent).toEqual([{ address: leaf.address, again: true }]);
  await page.locator('#relay-out').scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: /Bahasa Melayu|Malay/ }).click();
  await expect(page.locator('#relay-again')).toHaveText('Cuba tuntut sekali lagi');
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r3-again-320-${test.info().project.name}.png`, fullPage: true });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('picks a demo address that still has tokens to claim', async ({ page }) => {
  await fakeElectrum(page, { claimed: epoch.leaves.slice(1).map((l) => ({ leaf: l, amount: BigInt(l.cumulative) })) });
  await fakeRelay(page, { network: 'chipnet', enabled: true }, { code: 'claimed', txid: TXID });
  await page.goto('/');
  await page.getByRole('button', { name: /Try a demo address/ }).click();
  await expect(page.getByLabel(/Your address/)).toHaveValue(epoch.leaves[0]!.address);
  await expect(page.locator('#relay-claim')).toBeVisible();
});
