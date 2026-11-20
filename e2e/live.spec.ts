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
  const connect = page.getByRole('button', { name: 'Connect with WizardConnect' });
  await expect(connect.locator('svg.wizard-hat[aria-hidden="true"]')).toHaveCount(1);
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
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-r2-live-activity-${test.info().project.name}.png` });
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

test('the mainnet activity page lists the served mainnet record and checks the claim on chain', async ({ page }) => {
  test.setTimeout(120_000);
  const res = await page.request.get('/epochs/mainnet/transactions.json');
  test.skip(res.status() === 404, 'no mainnet record is served');
  const index = (await res.json()) as { runs: { transactions: { step: string; txid: string | null; height: number | null; error?: string }[] }[] };
  const txs = index.runs.flatMap((r) => r.transactions);
  const claim = txs.find((t) => t.step === 'claim-first' && t.txid !== null && t.height !== null);
  expect(claim, 'a mined mainnet claim in the served record').toBeDefined();
  await page.goto('/#/activity/mainnet');
  await expect(page.locator('#activity-networks a[aria-current="true"]')).toHaveText('Mainnet');
  await expect(page.locator('.run .txs > li')).toHaveCount(txs.length);
  const badge = page.locator(`.chain-check[data-txid="${claim!.txid}"]`).first();
  await expect(badge).toHaveAttribute('data-chain', 'confirmed', { timeout: 60_000 });
  await expect(badge).toHaveText(new RegExp(`^Confirmed on chain, block ${claim!.height} \\(checked by this page via \\S+\\)$`));
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  if (process.env.SCREENSHOT_DIR) {
    await badge.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-mn1-live-${test.info().project.name}.png` });
  }
});

test('the home page shows the hero, live numbers read from chipnet and the demo video files', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  for (const id of ['hero-line', 'push-pull', 'hero-try']) await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
  for (const name of ['leaves', 'claims', 'held', 'cost']) {
    await expect(page.locator(`#stat-${name} .stat-value`)).toHaveText(/\d/, { timeout: 60_000 });
  }
  await expect(page.locator('#stats-line')).toContainText(/\d/);
  const poster = (await page.locator('#video-player').getAttribute('poster')) ?? '';
  const src = (await page.locator('#video-download').getAttribute('href')) ?? '';
  expect(src).toMatch(/^\/assets\/tuai-demo-[\w-]+\.mp4$/);
  const ranged = await page.request.get(src, { headers: { Range: 'bytes=0-99' } });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()['content-type']).toContain('video/mp4');
  expect((await ranged.body()).length).toBe(100);
  expect((await page.request.get(poster)).headers()['content-type']).toContain('image/jpeg');
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  expect(errors).toEqual([]);
  if (process.env.SCREENSHOT_DIR) {
    const shot = `${process.env.SCREENSHOT_DIR}/tuai-p5d1-home-${test.info().project.name}`;
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${shot}.png` });
    await page.locator('#demo-video').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shot}-video.png` });
  }
});

test('the banner serves the slides as a PDF and links the first commit of the repository', async ({ page }) => {
  await page.goto('/');
  const deck = (await page.locator('#banner-deck').getAttribute('href')) ?? '';
  expect(deck).toMatch(/^\/[\w/.-]+\.pdf\?v=[0-9a-f]{12}$/);
  const pdf = await page.request.get(deck);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.locator('#banner-note')).toHaveAttribute('href', /\/commit\/[0-9a-f]{40}$/);
});

test('the home page mainnet card counts the claims in the served mainnet record and names the newest one', async ({ page }) => {
  test.setTimeout(60_000);
  const res = await page.request.get('/epochs/mainnet/transactions.json');
  test.skip(res.status() === 404, 'no mainnet record is served');
  const index = (await res.json()) as { runs: { transactions: { step: string; txid: string | null; height: number | null; error?: string }[] }[] };
  const claims = index.runs.flatMap((r) => r.transactions).filter((t) => t.step.includes('claim') && t.error === undefined && t.txid !== null);
  const newest = claims.reduce((a, b) => ((b.height ?? Infinity) > (a.height ?? Infinity) ? b : a));
  await page.goto('/');
  await expect(page.locator('#mainnet-count .mainnet-number')).toHaveText(String(claims.length), { timeout: 30_000 });
  const shown = (await page.locator('#mainnet-latest code').getAttribute('title')) ?? '';
  expect(claims.filter((t) => t.height === newest.height).map((t) => t.txid)).toContain(shown);
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  if (process.env.SCREENSHOT_DIR) {
    await page.locator('#mainnet').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5d2-mainnet-${test.info().project.name}.png` });
  }
});
