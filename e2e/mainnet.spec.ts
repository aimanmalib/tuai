// The mainnet card on the home page: the claim count and the newest claim come from the published mainnet record, the
// explorer links from the mainnet explorers in the config, and the link opens the mainnet activity view.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, fakeElectrum } from './fake-electrum.ts';
import { servedFolders } from './served-folders.ts';

const full = config as unknown as {
  relay: { statusPath: string };
  web: { epochsPath: string };
  networks: { mainnet: { explorers: { name: string; txUrl: string }[] } };
};
const INDEX = `**${full.web.epochsPath}/mainnet/transactions.json`;
const hex = (c: string) => c.repeat(64);

// A frozen record: three accepted claims over two runs (the newest at block 21), one refusal, and steps that are not claims.
function tx(step: string, txid: string | null, height: number | null, utc: string, error?: string) {
  return { step, epoch: 1, kind: `${step}-epoch-1`, txid, bytes: 1900, feeSats: 1900, height, utc, links: [], ...(error ? { error } : {}) };
}
const FIXTURE = {
  network: 'mainnet',
  runs: [
    {
      run: 'mainnet',
      pool: 'bitcoincash:pool-one',
      epochs: [],
      transactions: [
        tx('deploy', hex('a'), 19, '2026-11-19T17:00:00.000Z'),
        tx('claim-first', hex('b'), 20, '2026-11-19T18:00:00.000Z'),
        tx('claim-first', null, null, '2026-11-19T18:30:00.000Z', 'refused by the node'),
      ],
    },
    {
      run: 'mainnet-two',
      pool: 'bitcoincash:pool-two',
      epochs: [],
      transactions: [tx('claim-first', hex('c'), 21, '2026-11-20T09:15:00.000Z'), tx('claim-first', hex('d'), 20, '2026-11-20T10:00:00.000Z')],
    },
  ],
};

async function setUp(page: Page, index: 'fixture' | 'served' | 'missing' = 'fixture'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fakeElectrum(page);
  await page.route(`**${full.relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true, claimsLeft: 40, low: false } }));
  if (index === 'fixture') await page.route(INDEX, (r) => r.fulfill({ json: FIXTURE }));
  if (index === 'missing') await page.route(INDEX, (r) => r.fulfill({ status: 404, body: 'not found' }));
  return errors;
}

test('shows the claim count, the newest claim with its explorer links, and sits between the numbers and the video', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('/');
  const card = page.locator('#mainnet');
  await expect(card).toBeVisible();
  await expect(page.locator('#mainnet-heading')).toHaveText('Also on mainnet (test token)');
  await expect(page.locator('#mainnet-count')).toHaveText('3 claims accepted on mainnet, 1 refused');
  await expect(page.locator('#mainnet-latest')).toContainText('Latest claim: block 21, 2026-11-20 09:15 UTC');
  await expect(page.locator('#mainnet-latest code')).toHaveAttribute('title', hex('c'));
  const hrefs = await page.locator('#mainnet-latest a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs).toEqual(full.networks.mainnet.explorers.map((e) => `${e.txUrl}${hex('c')}`));
  const order = await page.evaluate(() => [...document.querySelectorAll('#view-claim section')].map((s) => s.id));
  expect(order.indexOf('mainnet')).toBe(order.indexOf('stats') + 1);
  expect(order.indexOf('demo-video')).toBe(order.indexOf('mainnet') + 1);
  if (process.env.SCREENSHOT_DIR) {
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5d-mainnet-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).include('#mainnet').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('reads the committed mainnet record and opens the mainnet activity view', async ({ page }) => {
  const errors = await setUp(page, 'served');
  await page.goto('/');
  await expect(page.locator('#mainnet-count')).toHaveText(/^[1-9]\d* claims accepted on mainnet, \d+ refused$/);
  await expect(page.locator('#mainnet-latest code')).toHaveAttribute('title', /^[0-9a-f]{64}$/);
  await expect(page.locator('#mainnet-latest a')).toHaveCount(full.networks.mainnet.explorers.length);
  const want = await servedFolders(page, full.web.epochsPath);
  await expect(page.locator('#mainnet-folders')).toHaveText(
    `${want.folders} real Folding@home folders in the epoch ${want.epoch} tree, ${want.legacy} of them paid at a legacy BTC address, read from the sponsor's published distribution files`,
    { timeout: 30_000 },
  );
  await page.locator('#mainnet-activity').click();
  await expect(page).toHaveURL(/#\/activity\/mainnet$/);
  await expect(page.locator('#view-activity')).toBeVisible();
  await expect(page.locator('#activity-networks a[aria-current="true"]')).toHaveText('Mainnet');
  expect(errors).toEqual([]);
});

test('says why when the mainnet record cannot be read, and the rest of the page keeps working', async ({ page }) => {
  const errors = await setUp(page, 'missing');
  await page.goto('/');
  await expect(page.locator('#mainnet-count')).toContainText('The mainnet record is not available (404');
  await expect(page.locator('#mainnet-latest')).toBeEmpty();
  await expect(page.locator('#mainnet-activity')).toBeVisible();
  await expect(page.locator('#hero-try')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Bahasa Melayu at 320 px, after scrolling: translated card and no sideways scroll', async ({ page }) => {
  const errors = await setUp(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.locator('#lang').click();
  await page.locator('#mainnet').scrollIntoViewIfNeeded();
  await expect(page.locator('#mainnet-heading')).toHaveText('Juga di mainnet (token ujian)');
  await expect(page.locator('#mainnet-count')).toHaveText('3 tuntutan diterima di mainnet, 1 ditolak');
  await expect(page.locator('#mainnet-activity')).toHaveText('Lihat setiap transaksi mainnet');
  await expect(page.locator('#mainnet-folders')).toHaveText(/^\d+ peserta Folding@home sebenar dalam pokok epoch \d+, \d+ daripadanya dibayar ke alamat BTC lama/, { timeout: 30_000 });
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5d-mainnet-ms-320-${test.info().project.name}.png` });
  }
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  const box = await page.locator('#mainnet').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(errors).toEqual([]);
});
