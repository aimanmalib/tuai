// Noticing a lost wallet (docs/decisions/0012-wallet-claims.md, "Noticing a lost wallet"): the stub wallet
// (wallet-stub.ts) connects, the page finds its coins and asks the relay to prepare (held here, so the claim is still
// running), and the test then emits the session manager's own events. The page clock jumps over the grace period from
// config, so the test uses the real setting without waiting for it.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, epoch, fakeElectrum } from './fake-electrum.ts';
import { formatUnits } from '../web/src/model.ts';
import { stubModule, walletTable } from './wallet-stub.ts';

const cfg = config as unknown as {
  web: { localeStorageKey: string };
  relay: { statusPath: string; wallet: { preparePath: string; reconnectGraceSeconds: number } };
};
const relay = cfg.relay;
const leaf = epoch.leaves[151]!;
const TEXT = {
  en: { lost: 'Connection to the wallet lost', ended: 'The wallet ended the connection. Connect again to continue.', check: /Check address/, connect: 'Connect with WizardConnect' },
  ms: { lost: 'Sambungan kepada dompet terputus', ended: 'Dompet menamatkan sambungan. Sambung semula untuk meneruskan.', check: /Semak alamat/, connect: 'Sambung dengan WizardConnect' },
};
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const emit = (page: Page, event: string) => page.evaluate((e) => (window as unknown as { __wallet: { emit: (e: string) => void } }).__wallet.emit(e), event);

async function connected(page: Page, seed: string, locale: 'en' | 'ms') {
  const table = walletTable(seed);
  const funded = table.receive[0]!.address;
  await fakeElectrum(page, {
    history: { [funded]: [{ tx_hash: 'e'.repeat(64), height: 398_000 }] } as never,
    unspent: { [funded]: [{ tx_hash: '1'.repeat(64), tx_pos: 0, height: 399_000, value: 8_000 }] },
  });
  const electrumUrl = config.networks.chipnet.electrum.wssUrl;
  await page.routeWebSocket((url) => !url.href.startsWith(electrumUrl), () => undefined);
  await page.route('**/assets/wizardconnect-*.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubModule('connect', 'wiz://fake', table) }));
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  // The prepare request is held, so the claim is still waiting when the wallet goes away.
  const prepared: unknown[] = [];
  await page.route(`**${relay.wallet.preparePath}`, (r) => void prepared.push(r.request().postDataJSON()));
  if (locale === 'ms') await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [cfg.web.localeStorageKey, 'ms']);
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel(/Your address|Alamat anda/).fill(leaf.address);
  await page.getByRole('button', { name: TEXT[locale].check }).click();
  await page.locator('#wallet-connect').scrollIntoViewIfNeeded();
  await page.locator('#wallet-connect').click();
  await expect(page.locator('#wallet-balance-bch')).toHaveText(`${formatUnits(8_000n, 8)} BCH`, { timeout: 30_000 });
  await expect.poll(() => prepared.length, { timeout: 30_000 }).toBe(1);
}

test('a wallet that goes quiet: lost while the page waits, ended after the grace period, and Connect works again', async ({ page }) => {
  await connected(page, 'quiet', 'en');
  const out = page.locator('#wallet-out');
  await emit(page, 'reconnecting');
  await expect(page.locator('#wallet-lost')).toContainText(TEXT.en.lost);
  await expect(page.locator('#wallet-ended')).toHaveCount(0);
  await page.clock.fastForward(relay.wallet.reconnectGraceSeconds * 1000);
  await expect(page.locator('#wallet-ended')).toHaveText(TEXT.en.ended);
  await expect(out).not.toContainText('did not finish');
  await expect(page.locator('#wallet-lost')).toHaveCount(0);
  await expect(page.locator('#wallet-balance')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __wallet: { closed: number } }).__wallet.closed)).toBeGreaterThan(0);
  const again = page.getByRole('button', { name: TEXT.en.connect });
  await expect(again).toBeEnabled();
  if (process.env.SCREENSHOT_DIR) {
    await out.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p8c-ended-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await again.click();
  await expect(page.locator('#wallet-balance-bch')).toBeVisible({ timeout: 30_000 });
});

test('a wallet that comes back within the grace period keeps the session', async ({ page }) => {
  await connected(page, 'back', 'en');
  await emit(page, 'reconnecting');
  await expect(page.locator('#wallet-lost')).toBeVisible();
  await emit(page, 'walletready');
  await expect(page.locator('#wallet-lost')).toHaveCount(0);
  await page.clock.fastForward(relay.wallet.reconnectGraceSeconds * 1000 * 2);
  await expect(page.locator('#wallet-ended')).toHaveCount(0);
  await expect(page.locator('#wallet-balance')).toBeVisible();
});

test('in Malay at 320 px: the lost and ended lines fit and the disconnect message ends the claim at once', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await connected(page, 'ms', 'ms');
  await emit(page, 'reconnecting');
  await expect(page.locator('#wallet-lost')).toContainText(TEXT.ms.lost);
  expect(await fits(page)).toBe(true);
  await emit(page, 'disconnect');
  await expect(page.locator('#wallet-ended')).toHaveText(TEXT.ms.ended);
  expect(await fits(page)).toBe(true);
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('#wallet-out').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p8c-ended-ms-320-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});
