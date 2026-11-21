// The wallet connect button and the balance chip, with a fake WizardConnect session: the page's lazily loaded
// wallet module is answered by a stub module (wallet-stub.ts), so no Nostr relay is contacted. The stub shows a
// pairing link and, in "connect" mode, connects a wallet whose addresses the fake Electrum server knows.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, epoch, fakeElectrum, record } from './fake-electrum.ts';
import { formatUnits } from '../web/src/model.ts';
import { stubModule, walletTable } from './wallet-stub.ts';

const relay = (config as unknown as { relay: { statusPath: string; wallet: { preparePath: string } } }).relay;
const leaf = epoch.leaves[151]!;
const PAIRING = 'wiz://fake-pairing-link';
// Two funded wallet addresses: receive 0 and 1, and the wallet reuses the first one as change 0, as a wallet might.
// The other addresses are unused, so the page's search stops after the gap limit.
const [a, b] = [epoch.leaves[10]!, epoch.leaves[11]!];
const asStub = (l: typeof a) => ({ address: l.address, hex: l.lockingBytecode });
const table = walletTable('balance', { receive: { 0: asStub(a), 1: asStub(b) }, change: { 0: asStub(a) } });

const coin = (n: number, value: number, tokens?: string) => ({
  tx_hash: n.toString(16).padStart(64, '0'),
  tx_pos: 0,
  height: 399_000,
  value,
  ...(tokens ? { token_data: { category: record.rewardCategory, amount: tokens } } : {}),
});

async function open(page: Page, mode: 'pair' | 'connect', unspent: Record<string, unknown[]> = {}): Promise<{ release: () => Promise<void> }> {
  // Every address with coins has history, as on a real chain; the page's search reads history first.
  const history = Object.fromEntries(Object.keys(unspent).map((addr, i) => [addr, [{ tx_hash: (i + 1).toString(16).padStart(64, 'e'), height: 398_000 }]]));
  await fakeElectrum(page, { unspent, history });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (s: string) => void ((window as unknown as { __copied: string }).__copied = s) },
    });
  });
  // Any other socket (a real Nostr relay included) is held silent.
  const electrumUrl = config.networks.chipnet.electrum.wssUrl;
  await page.routeWebSocket((url) => !url.href.startsWith(electrumUrl), () => undefined);
  await page.route('**/assets/wizardconnect-*.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubModule(mode, PAIRING, table) }));
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  // The prepare request is held, so the session stays open while the test watches the chip.
  const held: (() => Promise<void>)[] = [];
  await page.route(`**${relay.wallet.preparePath}`, (r) => void held.push(() => r.fulfill({ json: { code: 'off' } })));
  await page.goto('/');
  await page.getByLabel(/Your address|Alamat anda/).fill(leaf.address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
  return { release: async () => void (await Promise.all(held.map((h) => h()))) };
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('the connect button carries the hat, and pressing the pairing code copies the link', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await open(page, 'pair');
  const connect = page.getByRole('button', { name: 'Connect with WizardConnect' });
  await expect(connect.locator('svg.wizard-hat[aria-hidden="true"]')).toHaveCount(1);
  await connect.scrollIntoViewIfNeeded();
  await connect.click();
  const qr = page.locator('#wallet-qr');
  await expect(qr.getByRole('img', { name: 'WizardConnect pairing code' })).toBeVisible();
  await qr.click();
  await expect(page.locator('#wallet-copied')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(PAIRING);
  // The Copy button stays below the code.
  const copy = page.getByRole('button', { name: /^(Copy link|Copied)$/ });
  await expect(copy).toBeVisible();
  expect((await copy.boundingBox())!.y).toBeGreaterThan((await qr.boundingBox())!.y);
  expect(await fits(page)).toBe(true);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5f-pairing-${test.info().project.name}.png` });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.locator('#wallet-cancel').click();
  await expect(page.locator('#wallet-out')).toHaveText('Cancelled. Nothing was signed.');
});

test('a connected wallet shows its balance, which follows the chain without a click until Disconnect', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const unspent: Record<string, unknown[]> = {
    [a.address]: [coin(1, 50_000), coin(2, 1_000, '125000000000')],
    [b.address]: [coin(3, 1_800)],
  };
  const { release } = await open(page, 'connect', unspent);
  await page.getByRole('button', { name: 'Connect with WizardConnect' }).click();
  const chip = page.locator('#wallet-balance');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#wallet-balance-bch')).toHaveText(`${formatUnits(52_800n, 8)} BCH`);
  await expect(page.locator('#wallet-balance-tokens')).toHaveText(`${formatUnits(125_000_000_000n, 8)} test reward tokens`);
  // A claim lands in the wallet: the chip reads again on its own.
  unspent[a.address] = [...unspent[a.address]!, coin(4, 1_000, '50000000000')];
  const everyMs = (config as unknown as { web: { walletBalanceRefreshSeconds: number } }).web.walletBalanceRefreshSeconds * 1000;
  await expect(page.locator('#wallet-balance-tokens')).toHaveText(`${formatUnits(175_000_000_000n, 8)} test reward tokens`, { timeout: everyMs + 10_000 });
  await expect(page.locator('#wallet-balance-bch')).toHaveText(`${formatUnits(53_800n, 8)} BCH`);
  expect(await fits(page)).toBe(true);
  if (process.env.SCREENSHOT_DIR) {
    await chip.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5f-balance-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.locator('#wallet-disconnect').click();
  await expect(chip).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __wallet: { closed: number } }).__wallet.closed)).toBeGreaterThan(0);
  await release();
});

test('the chip goes away when the wallet ends the session', async ({ page }) => {
  const { release } = await open(page, 'connect', { [a.address]: [coin(1, 2_000)] });
  await page.getByRole('button', { name: 'Connect with WizardConnect' }).click();
  await expect(page.locator('#wallet-balance-bch')).toHaveText(`${formatUnits(2_000n, 8)} BCH`, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __wallet: { end: () => void } }).__wallet.end());
  await expect(page.locator('#wallet-balance')).toBeHidden();
  await release();
});
