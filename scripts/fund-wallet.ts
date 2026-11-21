/**
 * Sends the third-party wallet (scripts/wallet-claim-cashonize.ts) a small amount from the project payer so it can pay
 * the fee of the claim it signs. The amount is refused outside 1..`thirdPartyWallet.networks.<network>.maxFundSats`
 * before anything is built; on mainnet the shared broadcast path also checks `budget.mainnetMaxSats` first and adds the
 * spend to the ledger as kind `fund-wallet`.
 *
 *   npx tsx scripts/fund-wallet.ts --network chipnet|mainnet --sats N          show the wallet's balance, send nothing
 *   npx tsx scripts/fund-wallet.ts --network chipnet|mainnet --sats N --send   send N sats to the wallet
 *
 * The wallet's address is the one it showed on its own screen in the last driver run (`<outputDir>/address.txt`).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeCashAddress } from '@bitauth/libauth';
import { TransactionBuilder } from 'cashscript';
import { broadcast } from '../src/cli/broadcast.ts';
import { loadKey, makeContext, payerRole } from '../src/cli/context.ts';
import { plainUtxos, selectFunding } from '../src/cli/wallet.ts';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { checkFundAmount, walletNetwork } from '../src/wallet-driver.ts';

/** Fee headroom for the one-input, two-output funding transaction, in satoshis. */
const FEE_HEADROOM_SATS = 2_000n;

const { values } = parseArgs({ options: { network: { type: 'string' }, sats: { type: 'string' }, send: { type: 'boolean', default: false } } });
const config = loadConfig();
const wn = walletNetwork(config.thirdPartyWallet, values.network);
if (!/^\d+$/.test(values.sats ?? '')) {
  console.error('usage: npx tsx scripts/fund-wallet.ts --network chipnet|mainnet --sats N [--send]');
  process.exit(2);
}
const sats = BigInt(values.sats ?? '0');
checkFundAmount(wn, sats);

const ctx = makeContext(wn.network, { config });
const to = readFileSync(join(resolve(REPO_ROOT, wn.outputDir), 'address.txt'), 'utf8').trim();
const decoded = decodeCashAddress(to);
if (typeof decoded === 'string' || decoded.prefix !== config.networks[wn.network].addressPrefix)
  throw new Error(`${to} is not a ${wn.network} address`);
const have = await ctx.provider.getUtxos(to);
console.log(`wallet ${to} holds ${have.reduce((s, u) => s + u.satoshis, 0n)} sats on ${wn.network}`);
if (!values.send) process.exit(0);

const payer = loadKey(ctx, payerRole(wn.network));
const funding = selectFunding(await plainUtxos(ctx, payer), sats + FEE_HEADROOM_SATS);
const builder = new TransactionBuilder({ provider: ctx.provider })
  .addInputs(funding, payer.signer.unlockP2PKH())
  .addOutput({ to, amount: sats })
  .addBchChangeOutputIfNeeded({ to: payer.address, feeRate: config.fees.satsPerByte });
const sent = await broadcast(ctx, builder, { kind: 'fund-wallet', ownInputs: funding, ownLockingBytecode: payer.lockingBytecode });
console.log(`txid ${sent.txid} bytes ${sent.bytes} fee ${sent.feeSats}`);
process.exit(0);
