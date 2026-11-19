// The wallet claim section (ADR 0012): pairing code, cancel, layout and accessibility. Nostr sockets are held open
// by a stub that never answers, so no wallet connects and nothing leaves the machine; the claim itself, with a fake
// wallet that signs, is tested in process (tests/wallet-claim.test.ts).
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, epoch, fakeElectrum } from './fake-electrum.ts';

const relay = (config as unknown as { relay: { statusPath: string } }).relay;
const leaf = epoch.leaves[151]!;
const electrumUrl = config.networks.chipnet.electrum.wssUrl;

async function silentNostr(page: Page): Promise<string[]> {
  const opened: string[] = [];
  await page.routeWebSocket((url) => url.href !== electrumUrl && !url.href.startsWith(electrumUrl), (ws) => {
    opened.push(ws.url());
  });
  return opened;
}

test('shows a pairing code for a wallet, fits a narrow screen, and cancels without signing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fakeElectrum(page);
  const opened = await silentNostr(page);
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.getByLabel(/Your address|Alamat anda/).fill(leaf.address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
  const connect = page.getByRole('button', { name: 'Connect a wallet (WizardConnect)' });
  await connect.scrollIntoViewIfNeeded();
  await connect.click();
  await expect(page.getByRole('img', { name: 'WizardConnect pairing code' })).toBeVisible();
  await expect(page.locator('#wallet-open')).toHaveAttribute('href', /^wiz/);
  expect(opened.length).toBeGreaterThan(0);
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('#wallet-h').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-s1-wallet-pairing-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.locator('#wallet-cancel').click();
  await expect(page.locator('#wallet-out')).toHaveText('Cancelled. Nothing was signed.');
  await expect(connect).toBeEnabled();
  // The Nostr pool inside the library may still write to a socket it has just closed; that one message is its
  // own teardown noise. Any other page error fails the test.
  expect(errors.filter((e) => !/WebSocket is already in CLOSING or CLOSED state/.test(e))).toEqual([]);
});

test('offers no wallet claim when the server is unreachable', async ({ page }) => {
  await fakeElectrum(page);
  await page.route(`**${relay.statusPath}`, (r) => r.abort());
  await page.goto('/');
  await page.getByLabel(/Your address|Alamat anda/).fill(leaf.address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
  await expect(page.locator('#claim-command')).toBeVisible();
  await expect(page.locator('#wallet-connect')).toHaveCount(0);
});
