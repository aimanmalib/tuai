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

test('the activity page lists every transaction in the served record, and sampled explorer links resolve', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const res = await page.request.get('/epochs/chipnet/transactions.json');
  expect(res.status()).toBe(200);
  const index = (await res.json()) as { runs: { transactions: { txid: string | null; error?: string }[] }[] };
  const all = index.runs.flatMap((r) => r.transactions);
  const refused = all.filter((t) => t.error !== undefined).length;
  await page.goto('/#/activity');
  await expect(page.locator('.run .txs > li')).toHaveCount(all.length, { timeout: 30_000 });
  await expect(page.locator('.run .tx.refused')).toHaveCount(refused);
  await expect(page.locator('.run .tx.refused a')).toHaveCount(0);
  const links = page.locator('.run .tx:not(.refused) a');
  await expect(links).toHaveCount(all.length - refused);
  // First, middle and last mined transaction: the explorer the page links to must know each one.
  const n = all.length - refused;
  for (const i of [...new Set([0, Math.floor(n / 2), n - 1])]) {
    const href = await links.nth(i).getAttribute('href');
    expect(href).toMatch(/^https:\/\/.+\/[0-9a-f]{64}$/);
    const explorer = await page.request.get(href!, { timeout: 60_000 });
    expect(explorer.status(), href!).toBe(200);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r2-live-activity-${test.info().project.name}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('the relayer status names the network and says when it is running low', async ({ page }) => {
  const res = await page.request.get('/api/relay/status');
  expect(res.status()).toBe(200);
  const s = (await res.json()) as { network: string; reason?: string; claimsLeft?: number; low?: boolean; warnClaimsLeft?: number };
  expect(s.network).toBe('chipnet');
  // Switched off on the host: nginx answers for it, and there is no balance to judge.
  if (s.reason === 'off' && s.claimsLeft === undefined) return;
  expect(typeof s.low).toBe('boolean');
  expect(Number.isInteger(s.warnClaimsLeft)).toBe(true);
  expect(s.low).toBe(s.claimsLeft! <= s.warnClaimsLeft!);
});

test('the activity page checks the recorded deploy transaction on chain itself and shows its block', async ({ page }) => {
  test.setTimeout(120_000);
  const res = await page.request.get('/epochs/chipnet/transactions.json');
  const index = (await res.json()) as { runs: { run: string; transactions: { step: string; txid: string | null; height: number | null; error?: string }[] }[] };
  const deploy = index.runs.flatMap((r) => r.transactions).find((t) => t.step === 'deploy' && t.txid !== null && t.error === undefined && t.height !== null);
  expect(deploy, 'a mined deploy transaction in the served record').toBeDefined();
  await page.goto('/#/activity');
  const badge = page.locator(`.chain-check[data-txid="${deploy!.txid}"]`).first();
  await expect(badge).toHaveAttribute('data-chain', 'confirmed', { timeout: 60_000 });
  await expect(badge).toHaveText(new RegExp(`^Confirmed on chain, block ${deploy!.height} \\(checked by this page via \\S+\\)$`));
  await expect(page.locator('.chain-check[data-chain="pending"]')).toHaveCount(0, { timeout: 60_000 });
  if (process.env.SCREENSHOT_DIR) {
    await badge.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p3b-live-chain-${test.info().project.name}.png` });
  }
});
