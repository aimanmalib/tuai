// The recorded demo under the live numbers: hashed asset names, nothing downloaded before the visitor presses play
// (WebKit fetches a video even with preload="none" once it has a source), served as video/mp4 with byte ranges, and
// the banner link reaching it from the activity view.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { config, fakeElectrum } from './fake-electrum.ts';

const relay = (config as unknown as { relay: { statusPath: string } }).relay;

async function setUp(page: Page): Promise<{ errors: string[]; videoRequests: string[] }> {
  const errors: string[] = [];
  const videoRequests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('.mp4')) videoRequests.push(r.url());
  });
  await fakeElectrum(page);
  await page.route(`**${relay.statusPath}`, (r) => r.fulfill({ json: { network: 'chipnet', enabled: true } }));
  return { errors, videoRequests };
}

test('places the video after the live numbers with hashed files and loads nothing before play', async ({ page, request }) => {
  const { errors, videoRequests } = await setUp(page);
  await page.goto('/');
  const order = await page.evaluate(() => {
    const stats = document.getElementById('stats');
    const video = document.getElementById('demo-video');
    return stats && video ? stats.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  expect(order).toBeTruthy();
  const player = page.locator('#video-player');
  await expect(player).toHaveAttribute('preload', 'none');
  await expect(player).toHaveAttribute('playsinline', '');
  await expect(player).toHaveAccessibleName(/Demo video/);
  const poster = await player.evaluate((v: HTMLVideoElement) => v.getAttribute('poster') ?? '');
  expect(poster).toMatch(/^\/assets\/tuai-demo-poster-[\w-]+\.jpg$/);
  const src = (await page.locator('#video-download').getAttribute('href')) ?? '';
  expect(src).toMatch(/^\/assets\/tuai-demo-[\w-]+\.mp4$/);
  expect(await player.evaluate((v: HTMLVideoElement) => v.hasAttribute('src'))).toBe(false);
  await page.locator('#video-play').scrollIntoViewIfNeeded();
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5c-video-${test.info().project.name}.png` });
  }
  await page.waitForTimeout(1500);
  expect(videoRequests).toEqual([]);

  // Pressing play attaches the file and shows the controls. Playback is then stopped and the source detached: decoding
  // 1080p in a test browser takes CPU the tests running beside it need. The file is checked below over plain HTTP.
  await page.locator('#video-play').click();
  await expect(page.locator('#video-play')).toBeHidden();
  const after = await player.evaluate((v: HTMLVideoElement) => {
    const seen = { src: v.getAttribute('src'), controls: v.controls };
    v.pause();
    v.removeAttribute('src');
    v.load();
    return seen;
  });
  expect(after).toEqual({ src, controls: true });

  const ranged = await request.get(src, { headers: { Range: 'bytes=0-99' } });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()['content-type']).toContain('video/mp4');
  expect((await ranged.body()).length).toBe(100);
  expect((await request.get(poster)).headers()['content-type']).toContain('image/jpeg');

  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the banner link opens the home view and brings the video into view, also from the activity view', async ({ page }) => {
  const { errors } = await setUp(page);
  await page.goto('/#/activity');
  await expect(page.locator('#view-activity')).toBeVisible();
  await page.locator('#banner-video').click();
  await expect(page.locator('#view-claim')).toBeVisible();
  await expect(page.locator('#demo-video')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('Bahasa Melayu at 320 px: translated caption and no sideways scroll', async ({ page }) => {
  const { errors } = await setUp(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.locator('#lang').click();
  await expect(page.locator('#video-heading')).toHaveText('Video demo');
  await expect(page.locator('#video-download')).toHaveText('Muat turun video');
  await page.locator('#demo-video').scrollIntoViewIfNeeded();
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p5c-video-ms-320-${test.info().project.name}.png` });
  }
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(o.s).toBeLessThanOrEqual(o.c);
  expect(errors).toEqual([]);
});
