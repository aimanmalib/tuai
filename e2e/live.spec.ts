// Read-only checks against a deployed claim page (E2E_BASE_URL): the page, the proof endpoint headers, and one real
// lookup whose proof is checked against the root read from chipnet. Run by deploy/deploy.sh after each deploy.
import { test, expect, type Page } from '@playwright/test';

interface EpochFile {
  epoch: number;
  leaves: { address: string }[];
}

async function latestEpoch(page: Page): Promise<{ file: EpochFile; url: string }> {
  const index = (await (await page.request.get('/epochs/chipnet/index.json')).json()) as { epochs: number[] };
  const url = `/epochs/chipnet/epoch-${Math.max(...index.epochs)}.json`;
  return { file: (await (await page.request.get(url)).json()) as EpochFile, url };
}

test('health and proof endpoint headers', async ({ page }) => {
  const health = await page.request.get('/healthz');
  expect(health.status()).toBe(200);
  const { url } = await latestEpoch(page);
  const res = await page.request.get(url, { headers: { Origin: 'https://example.org' } });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['access-control-allow-origin']).toBe('*');
  expect(res.headers()['cache-control']).toContain('no-transform');
  expect((await page.request.get('/epochs/chipnet/epoch-999999.json')).status()).toBe(404);
});

test('a demo address is found and its proof matches the chipnet root', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const { file } = await latestEpoch(page);
  await page.goto('/');
  await expect(page.getByRole('note')).toContainText('BCH BLAZE 2026');
  await page.getByLabel(/Your address|Alamat anda/).fill(file.leaves[0]!.address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
  await expect(page.locator('#proof-ok')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('#warn-root')).toHaveCount(0);
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-f7-live-${test.info().project.name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
