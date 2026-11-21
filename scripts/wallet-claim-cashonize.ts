/**
 * A claim signed by a third-party wallet on chipnet (docs/decisions/0016-third-party-wallet.md). Cashonize runs in
 * headless Chromium with its own phrase, set to chipnet, and pairs with the public page over WizardConnect; the
 * page prepares the claim, checks it and asks the wallet to sign; this script presses Sign like a person would.
 *
 *   npx tsx scripts/wallet-claim-cashonize.ts --cashonize <dir> --address-only   the wallet's chipnet address, read from its own screen
 *   npx tsx scripts/wallet-claim-cashonize.ts --cashonize <dir> --dry [--leaf A]  pair with the page and stop before any Sign
 *   npx tsx scripts/wallet-claim-cashonize.ts --cashonize <dir> [--leaf A]        claim leaf A (default: the wallet's own address)
 *   npx tsx scripts/wallet-claim-cashonize.ts --refresh                           fill in block heights of recorded claims
 *   npx tsx scripts/wallet-claim-cashonize.ts --record <txid> [--leaf A]          record a claim the wallet already signed
 * Options: --site <url> (default project.siteUrl). Settings: `thirdPartyWallet` in config/tuai.json.
 *
 * <dir> is a Cashonize build: clone https://github.com/cashonize/cashonize-wallet, check out the tag of
 * `thirdPartyWallet.version` (commit `thirdPartyWallet.commit`), `pnpm install --frozen-lockfile`, `pnpm build`;
 * the static site is in dist/spa. It is served on 127.0.0.1 only.
 *
 * The phrase (`thirdPartyWallet.mnemonicEnv` in the .env file) is made here once and never printed, logged or put in
 * a screenshot; nor is the pairing link. Every printed line goes through `redact`. Screenshots (the wallet's dialog and
 * the page after it) go to `thirdPartyWallet.outputDir`; the claim is added to `thirdPartyWallet.recordPath`.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Locator, type Page } from '@playwright/test';
import { generateBip39Mnemonic } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { confirmedHeight, electrumHeightSource } from '../src/tx-height.ts';
import {
  addWalletClaim, firstChipnetAddress, formatWalletClaims, leafIndexOf, parseWalletClaims, readEnvValue, redact, withEnvValue,
} from '../src/wallet-driver.ts';

const config = loadConfig();
const w = config.thirdPartyWallet;
const { values } = parseArgs({
  options: {
    cashonize: { type: 'string' }, site: { type: 'string' }, leaf: { type: 'string' }, record: { type: 'string' },
    'address-only': { type: 'boolean', default: false }, dry: { type: 'boolean', default: false }, refresh: { type: 'boolean', default: false },
  },
});
const SITE = (values.site ?? config.project.siteUrl).replace(/\/$/, '');
const TIMEOUT = w.timeoutSeconds * 1000;
const OUT = resolve(REPO_ROOT, w.outputDir);
const RECORD = resolve(REPO_ROOT, w.recordPath);
const net = config.networks[w.network];
const secrets: string[] = [];
const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${redact(m, secrets)}`);

const provider = (): ElectrumNetworkProvider => {
  if (!net.electrum) throw new Error(`${w.network} has no Electrum server in the config`);
  return new ElectrumNetworkProvider(w.network, { hostname: net.electrum.hostname });
};
const heightOf = (txid: string): Promise<number | null> => confirmedHeight(electrumHeightSource(provider()), txid);
const readRecord = () => parseWalletClaims(existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : undefined);

if (values.refresh) {
  let r = readRecord();
  for (const c of r.claims.filter((x) => x.height === null)) {
    r = addWalletClaim(r, { ...c, height: await heightOf(c.txid) });
    log(`${c.txid} height ${String(r.claims.find((x) => x.txid === c.txid)?.height)}`);
  }
  writeFileSync(RECORD, formatWalletClaims(r));
  process.exit(0);
}

if (values.record) {
  // The wallet's own address as read from its screen by an earlier run, unless --leaf names another leaf.
  const leaf = values.leaf ?? readFileSync(join(OUT, 'address.txt'), 'utf8').trim();
  await recordClaim(values.record, leaf);
  process.exit(0);
}

const SPA = values.cashonize;
if (!SPA || !existsSync(join(SPA, 'index.html'))) {
  console.error('usage: npx tsx scripts/wallet-claim-cashonize.ts --cashonize <built dist/spa dir> [--address-only | --dry] [--leaf A] [--site url]');
  process.exit(2);
}
const envPath = resolve(REPO_ROOT, w.envFile);
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
if (readEnvValue(envText, w.mnemonicEnv) === undefined) {
  writeFileSync(envPath, withEnvValue(envText, w.mnemonicEnv, generateBip39Mnemonic()), { mode: 0o600 });
  log(`${w.mnemonicEnv} made in ${w.envFile} (not printed)`);
}
const phrase = readEnvValue(readFileSync(envPath, 'utf8'), w.mnemonicEnv) ?? '';
secrets.push(phrase);
mkdirSync(OUT, { recursive: true });

const root = resolve(SPA);
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  const inside = file.startsWith(root + sep) && existsSync(file) && !readdirSafe(file);
  res.writeHead(200, { 'content-type': inside ? (types[extname(file)] ?? 'application/octet-stream') : 'text/html' });
  res.end(readFileSync(inside ? file : join(root, 'index.html')));
});
function readdirSafe(p: string): boolean {
  try { readdirSync(p); return true; } catch { return false; }
}
await new Promise<void>((r) => { server.listen(w.port, '127.0.0.1', r); });
const browser = await chromium.launch();

/** Restores the wallet from the phrase and switches it to chipnet; resolves once its chipnet screen shows. */
async function openWallet(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })).newPage();
  await page.goto(`http://127.0.0.1:${w.port}/`);
  await page.getByRole('button', { name: 'Import wallet' }).first().click();
  await page.locator('select').first().selectOption('hd');
  await page.locator('.seed-word-input input').first().fill(phrase);
  await page.getByRole('button', { name: 'Import wallet' }).last().click();
  await page.getByRole('button', { name: 'Finish Setup' }).click();
  await page.locator('nav').waitFor({ timeout: TIMEOUT });
  // Cashonize keeps the network in localStorage and reads it on load; an imported wallet has both networks.
  await page.evaluate((n) => localStorage.setItem('network', n), w.network);
  await page.reload();
  await page.locator('nav').waitFor({ timeout: TIMEOUT });
  return page;
}

async function walletAddress(page: Page): Promise<string> {
  const shown = page.locator('.depositAddr');
  await shown.first().waitFor({ timeout: TIMEOUT });
  const address = firstChipnetAddress(await shown.allInnerTexts());
  if (!address) throw new Error('Cashonize showed no chipnet address; is it on chipnet?');
  return address;
}

/** Approves the wallet's sign dialogs until `done` shows on the page; the first dialog is captured. */
async function signUntil(wallet: Page, site: Page, done: Locator): Promise<void> {
  const dialog = wallet.locator('.q-dialog:visible').last();
  const failed = site.locator('#wallet-out.error');
  for (let n = 0; ; n++) {
    const which = await Promise.race([
      dialog.getByRole('button', { name: 'Sign' }).waitFor({ timeout: TIMEOUT }).then(() => 'sign'),
      done.waitFor({ timeout: TIMEOUT }).then(() => 'done'),
      failed.waitFor({ timeout: TIMEOUT }).then(() => 'failed'),
    ]);
    if (which === 'done') return;
    if (which === 'failed') throw new Error(`the page said: ${await failed.innerText()}`);
    await wallet.waitForTimeout(800);
    if (n === 0) await dialog.screenshot({ path: join(OUT, 'wallet-cashonize-sign.png') });
    await dialog.getByRole('button', { name: 'Sign' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    log(`Cashonize signed (${n + 1})`);
  }
}

try {
  const wallet = await openWallet();
  const address = await walletAddress(wallet);
  writeFileSync(join(OUT, 'address.txt'), `${address}\n`);
  log(`Cashonize ${w.version} on ${w.network}: ${address}`);
  if (!values['address-only']) {
    const leaf = values.leaf ?? address;
    const site = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' })).newPage();
    await site.goto(`${SITE}/`);
    await site.getByLabel(/Your address/).fill(leaf);
    await site.getByRole('button', { name: /Check address/ }).click();
    await site.locator('#wallet-connect').click({ timeout: TIMEOUT });
    const link = (await site.locator('#wallet-open').getAttribute('href', { timeout: TIMEOUT })) ?? '';
    if (!/^wiz:\/\//.test(link)) throw new Error('the page showed no WizardConnect link');
    secrets.push(link);
    await wallet.locator('nav').getByText('Connect', { exact: true }).click();
    await wallet.getByPlaceholder('Connection URI').fill(link);
    await wallet.locator('input.primaryButton[value*="Connect"]').click();
    const consent = wallet.locator('.q-dialog:visible').last();
    await consent.waitFor({ timeout: TIMEOUT });
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    // Paired once the page no longer shows the link: it then prepares the claim and asks the wallet to sign.
    await site.locator('#wallet-open').waitFor({ state: 'detached', timeout: TIMEOUT });
    log(`paired with ${SITE} for leaf ${leaf}`);
    if (values.dry) {
      const said = site.locator('#wallet-out');
      const sign = wallet.locator('.q-dialog:visible').last().getByRole('button', { name: 'Sign' });
      await Promise.race([sign.waitFor({ timeout: TIMEOUT }), said.locator('.error, #wallet-refused').waitFor({ timeout: TIMEOUT }),
        site.locator('#wallet-out.error').waitFor({ timeout: TIMEOUT })]).catch(() => undefined);
      log(`dry run, nothing signed; the page says: ${(await said.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
      await site.screenshot({ path: join(OUT, 'wallet-cashonize-dry.png') });
      await site.locator('#wallet-cancel').click({ timeout: 5_000 }).catch(() => undefined);
    } else {
      await signUntil(wallet, site, site.locator('#relay-txid'));
      const txid = (await site.locator('#relay-txid').innerText()).trim();
      await site.waitForTimeout(1_500);
      await site.screenshot({ path: join(OUT, 'wallet-cashonize-claimed.png'), fullPage: true });
      log(`claimed: ${txid}`);
      await recordClaim(txid, leaf);
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(0);

/** Adds a claim to the record: the leaf index comes from the newest epoch file, the height from Electrum. */
async function recordClaim(txid: string, leaf: string): Promise<void> {
  const epoch = newestEpoch();
  const leafIndex = leafIndexOf((JSON.parse(readFileSync(epoch, 'utf8')) as { leaves: { address?: string }[] }).leaves, leaf);
  const record = addWalletClaim(readRecord(), { txid, wallet: `${w.name} v${w.version}`, commit: w.commit, leafIndex,
    address: leaf, height: await heightOf(txid).catch(() => null), at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z') });
  mkdirSync(resolve(RECORD, '..'), { recursive: true });
  writeFileSync(RECORD, formatWalletClaims(record));
  log(`${txid} (leaf ${leafIndex}) recorded in ${w.recordPath}`);
}

function newestEpoch(): string {
  const dir = resolve(RECORD, '..');
  const files = readdirSync(dir)
    .map((f) => /^epoch-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!files[0]) throw new Error(`no epoch file in ${dir}`);
  return resolve(dir, files[0][0]);
}
