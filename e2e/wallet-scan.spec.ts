// Address discovery on the claim page (docs/decisions/0012-wallet-claims.md, "Address discovery"): a stub wallet
// (wallet-stub.ts) whose coins sit far from index 0, or on the change path, or nowhere, and a fake Electrum server.
// The page must find the coins through the gap limit, send only those addresses to the relay, and, when there are
// none, say where it looked and point to the claim that needs no wallet, without asking for money.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, epoch, fakeElectrum } from './fake-electrum.ts';
import { formatUnits } from '../web/src/model.ts';
import { stubModule, walletTable, type KeyPath, type StubAddress } from './wallet-stub.ts';

const cfg = config as unknown as {
  web: { localeStorageKey: string };
  relay: { statusPath: string; wallet: { preparePath: string; gapLimit: number; maxAddressesPerScan: number; maxAddresses: number } };
};
const relay = cfg.relay;
const leaf = epoch.leaves[151]!;
const ASKS_EN = /\b(send|sending|transfer|deposit|top ?up|fund|funds|needs about)\b/i;
const ASKS_MS = /\b(hantar|menghantar|hantarkan|pindah|pindahkan|deposit|tambah nilai|isikan|perlukan kira-kira)\b/i;

const coin = (n: number, value: number) => ({ tx_hash: n.toString(16).padStart(64, '0'), tx_pos: 0, height: 399_000, value });
const seen = (n: number) => [{ tx_hash: n.toString(16).padStart(64, 'e'), height: 398_000 }];

interface Setup {
  /** Indexes with history but no coins, and indexes with coins (satoshis). */
  history?: [KeyPath, number][];
  coins?: [KeyPath, number, number][];
  locale?: 'ms';
}

async function open(page: Page, seed: string, s: Setup) {
  const table = walletTable(seed);
  const at = (p: KeyPath, i: number): StubAddress => table[p][i]!;
  const history: Record<string, unknown[]> = {};
  const unspent: Record<string, unknown[]> = {};
  for (const [p, i] of s.history ?? []) history[at(p, i).address] = seen(i + 1);
  for (const [p, i, v] of s.coins ?? []) {
    history[at(p, i).address] = seen(i + 100);
    unspent[at(p, i).address] = [coin(i + 1, v)];
  }
  await fakeElectrum(page, { history: history as never, unspent });
  const electrumUrl = config.networks.chipnet.electrum.wssUrl;
  await page.routeWebSocket((url) => !url.href.startsWith(electrumUrl), () => undefined);
  await page.route('**/assets/wizardconnect-*.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubModule('connect', 'wiz://fake', table) }));
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  // The prepare request is recorded and held, so the session stays open while the test reads the page.
  const prepared: { address: string; change: string; wallet: string[] }[] = [];
  await page.route(`**${relay.wallet.preparePath}`, (r) => void prepared.push(r.request().postDataJSON() as (typeof prepared)[number]));
  if (s.locale) await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [cfg.web.localeStorageKey, s.locale]);
  await page.goto('/');
  await page.getByLabel(/Your address|Alamat anda/).fill(leaf.address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
  await page.locator('#wallet-connect').scrollIntoViewIfNeeded();
  await page.locator('#wallet-connect').click();
  return { at, prepared };
}

// The fake Electrum server answers each request through the test runner, so a search of a few dozen addresses
// takes seconds there; a real server answers on one socket in well under that.
const SEARCH = { timeout: 30_000 };
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('finds coins on the 25th receive address and sends that address to the relay', async ({ page }) => {
  const { at, prepared } = await open(page, 'deep', { history: range(0, 24).map((i) => ['receive', i]), coins: [['receive', 24, 9_000]] });
  await expect(page.locator('#wallet-balance-bch')).toHaveText(`${formatUnits(9_000n, 8)} BCH`, SEARCH);
  await expect.poll(() => prepared.length).toBe(1);
  expect(prepared[0]!.wallet).toContain(at('receive', 24).address);
  expect(prepared[0]!.wallet.length).toBeLessThanOrEqual(relay.wallet.maxAddresses);
  // The change address is unused: the first change address, since the change path has no history here.
  expect(prepared[0]!.change).toBe(at('change', 0).address);
});

test('finds coins on the change path and pays change to the first unused change address', async ({ page }) => {
  const { at, prepared } = await open(page, 'change', { history: range(0, 7).map((i) => ['change', i]), coins: [['change', 7, 4_500]] });
  await expect(page.locator('#wallet-balance-bch')).toHaveText(`${formatUnits(4_500n, 8)} BCH`, SEARCH);
  await expect.poll(() => prepared.length).toBe(1);
  expect(prepared[0]!.wallet).toEqual([at('change', 7).address, at('change', 8).address]);
  expect(prepared[0]!.change).toBe(at('change', 8).address);
});

test('an empty wallet: says where the page looked, asks for nothing, and points to Claim now', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const { prepared } = await open(page, 'empty', {});
  const out = page.locator('#wallet-out');
  const gap = relay.wallet.gapLimit;
  await expect(out).toContainText(`No chipnet coins were found on the first ${gap} receive and ${gap} change addresses`, SEARCH);
  await expect(page.locator('#wallet-without')).toBeVisible();
  expect(prepared).toEqual([]);
  expect(await out.innerText()).not.toMatch(ASKS_EN);
  expect(await out.locator('svg.qr').count()).toBe(0);
  expect(await fits(page)).toBe(true);
  if (process.env.SCREENSHOT_DIR) {
    await out.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p7-no-coins-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.locator('#wallet-go-claim').click();
  const claimNow = page.locator('#relay-claim');
  await expect(claimNow).toBeInViewport();
  await expect(claimNow).toBeFocused();
});

test('the empty wallet text in Malay fits 320 px and asks for nothing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await open(page, 'empty-ms', { locale: 'ms' });
  const out = page.locator('#wallet-out');
  await expect(out).toContainText(`Tiada syiling chipnet dijumpai pada ${relay.wallet.gapLimit} alamat terima`, SEARCH);
  expect(await out.innerText()).not.toMatch(ASKS_MS);
  expect(await fits(page)).toBe(true);
});
