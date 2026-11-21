// Wallet claims on mainnet (docs/decisions/0012-wallet-claims.md, "Mainnet wallet claims"): with mainnet chosen, the
// card offers the wallet claim without the chipnet relayer, says the reward is a test token, and the prepare request
// names mainnet with mainnet wallet addresses. A stub wallet (wallet-stub.ts) and a fake mainnet Electrum server.
import { test, expect, type Page } from '@playwright/test';
import { binToHex, encodeTransaction, hashTransactionUiOrder, hexToBin } from '@bitauth/libauth';
import { addressToLockingBytecode } from '../src/leaf.ts';
import AxeBuilder from '@axe-core/playwright';
import { config, fakeElectrum, mainnet } from './fake-electrum.ts';
import { stubModule, walletTable } from './wallet-stub.ts';

const cfg = config as unknown as {
  web: { localeStorageKey: string };
  relay: { statusPath: string; wallet: { preparePath: string; gapLimit: number } };
};
const wallet = cfg.relay.wallet;
const leaf = mainnet.epoch.leaves[0]!;
const ASKS_EN = /\b(send|sending|transfer|deposit|top ?up|fund|funds|needs about)\b/i;
const ASKS_MS = /\b(hantar|menghantar|hantarkan|pindah|pindahkan|deposit|tambah nilai|isikan|perlukan kira-kira)\b/i;
const SEARCH = { timeout: 30_000 };
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** What a wallet that signed and sent the claim hands back; the page only hashes it to show the transaction id. */
const SIGNED = '02'.repeat(80);

/**
 * A prepared mainnet claim the page's own check accepts: the pool's input and the wallet's coin in; the pool, the
 * leaf's reward tokens and the wallet's change out.
 */
function preparedClaim(walletHex: string, changeAddress: string) {
  const pool = addressToLockingBytecode(mainnet.record.contracts.pool);
  const input = (n: number, unlocking: Uint8Array) => ({
    outpointTransactionHash: new Uint8Array(32).fill(n), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: unlocking,
  });
  const tx = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [input(1, Uint8Array.of(0x51)), input(2, new Uint8Array())],
    outputs: [
      { lockingBytecode: pool, valueSatoshis: 1000n },
      { lockingBytecode: hexToBin(leaf.lockingBytecode), valueSatoshis: 1000n,
        token: { category: hexToBin(mainnet.record.rewardCategory), amount: BigInt(leaf.cumulative) } },
      { lockingBytecode: addressToLockingBytecode(changeAddress), valueSatoshis: 8000n },
    ],
  });
  return {
    code: 'prepared',
    tx: binToHex(tx),
    sourceOutputs: [{ lockingBytecode: binToHex(pool), valueSatoshis: '1000' }, { lockingBytecode: walletHex, valueSatoshis: '9000' }],
  };
}

async function open(page: Page, seed: string, o: { coins?: boolean; locale?: 'ms'; sign?: boolean } = {}) {
  const table = walletTable(seed, {}, [], 'bitcoincash');
  const funded = table.receive[0]!.address;
  const coin = { tx_hash: '5a'.repeat(32), tx_pos: 0, height: 399_000, value: 9_000 };
  await fakeElectrum(page, {
    network: 'mainnet',
    history: (o.coins ? { [funded]: [{ tx_hash: coin.tx_hash, height: coin.height }] } : {}) as never,
    unspent: o.coins ? { [funded]: [coin] } : {},
  });
  const electrumUrl = config.networks.mainnet.electrum.wssUrl;
  await page.routeWebSocket((url) => !url.href.startsWith(electrumUrl), () => undefined);
  await page.route('**/assets/wizardconnect-*.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stubModule('connect', 'wiz://fake', table, o.sign ? SIGNED : undefined) }));
  const prepared: { network?: string; address: string; change: string; wallet: string[] }[] = [];
  await page.route(`**${wallet.preparePath}`, (r) => {
    const asked = r.request().postDataJSON() as (typeof prepared)[number];
    prepared.push(asked);
    const coinHex = table.receive[0]!.hex;
    void r.fulfill({ json: o.sign ? preparedClaim(coinHex, asked.change) : { code: 'walletEmpty', needSats: 6000 } });
  });
  if (o.locale) await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [cfg.web.localeStorageKey, o.locale]);
  await page.goto('/');
  await page.locator('#network').selectOption('mainnet');
  await page.getByLabel(/Your address|Alamat anda/).fill(leaf.address);
  await page.getByRole('button', { name: /Check address|Semak alamat/ }).click();
  const connect = page.locator('#wallet-connect');
  await connect.scrollIntoViewIfNeeded();
  return { connect, prepared, funded };
}

test('offers the wallet claim on mainnet and the prepare request names mainnet with mainnet addresses', async ({ page }) => {
  const { connect, prepared, funded } = await open(page, 'mainnet coins', { coins: true });
  await expect(page.locator('#wallet-network-note')).toHaveText('The reward is a test token of this project, with no value, not FLDCH.');
  await expect(page.locator('#wallet-h + p')).toContainText('Connect a WizardConnect wallet on mainnet.');
  // No keyed relayer serves mainnet, so the card has no Claim now button.
  await expect(page.locator('#relay-claim')).toHaveCount(0);
  await connect.click();
  await expect.poll(() => prepared.length, SEARCH).toBe(1);
  expect(prepared[0]!.network).toBe('mainnet');
  expect(prepared[0]!.address).toBe(leaf.address);
  expect(prepared[0]!.wallet).toContain(funded);
  for (const a of [...prepared[0]!.wallet, prepared[0]!.change]) expect(a.startsWith('bitcoincash:')).toBe(true);
  await expect(page.locator('#wallet-out')).toContainText('no spendable mainnet coins');
  await expect(page.locator('#wallet-without')).toContainText('run the claim from a clone of the repository');
  await expect(page.locator('#wallet-go-claim')).toHaveCount(0);
});

test('an empty mainnet wallet in Malay at 320 px: says where it looked, asks for nothing, fits, and passes axe', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const { connect, prepared } = await open(page, 'mainnet empty', { locale: 'ms' });
  await connect.click();
  const out = page.locator('#wallet-out');
  await expect(out).toContainText(`Tiada syiling mainnet dijumpai pada ${wallet.gapLimit} alamat terima`, SEARCH);
  await expect(out).toContainText('BCH dompet itu sendiri');
  await expect(page.locator('#wallet-go-claim')).toHaveCount(0);
  expect(prepared).toEqual([]);
  const text = await out.innerText();
  expect(text).not.toMatch(ASKS_MS);
  expect(text).not.toMatch(ASKS_EN);
  expect(await fits(page)).toBe(true);
  if (process.env.SCREENSHOT_DIR) {
    await out.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/tuai-p8b-mainnet-wallet-${test.info().project.name}.png` });
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test('after a mainnet wallet claim the page reads the chain again and still shows the claim transaction', async ({ page }) => {
  const { connect } = await open(page, 'mainnet signs', { coins: true, sign: true });
  await connect.click();
  const txid = binToHex(hashTransactionUiOrder(hexToBin(SIGNED)));
  // The claim makes the page read the chain again and draw the card anew; the claim's transaction must survive that.
  await expect(page.locator('#claim-notice #relay-txid')).toHaveText(txid, SEARCH);
  await expect(page.locator('#claim-notice')).toContainText('Claim sent.');
  await expect(page.locator('#claim-notice a').first()).toHaveAttribute('href', new RegExp(txid));
  expect(await fits(page)).toBe(true);
});
