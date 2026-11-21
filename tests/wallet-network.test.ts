import { describe, expect, it } from 'vitest';
import { MockNetworkProvider } from 'cashscript';
import { encodeCashAddress } from '@bitauth/libauth';
import { assertPushAllowed, PushDisabledError } from '../src/cli/commands/push.ts';
import { main } from '../src/cli/main.ts';
import { loadConfig, validateConfig } from '../src/config.ts';
import {
  addWalletClaim, checkFundAmount, FUND_CEILING_SATS, parseWalletClaims, validateThirdPartyWallet, walletNetwork, type WalletClaim,
} from '../src/wallet-driver.ts';

const payload = new Uint8Array(20).fill(0x22);
const MAINNET_ADDR = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload }).address;
const CHIPNET_ADDR = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload }).address;
const claim = (address: string): WalletClaim => ({
  txid: 'cd'.repeat(32), wallet: 'Cashonize v0.15.2', commit: 'c0'.repeat(20), leafIndex: 3, address, height: null,
  at: '2026-11-21T14:00:00.000Z',
});

describe('third-party wallet per network', () => {
  it('lists chipnet and mainnet, each with its own record under deployments/<network>/ and a fund limit within its ceiling', () => {
    const w = loadConfig().thirdPartyWallet;
    expect(validateThirdPartyWallet(w)).toEqual([]);
    for (const n of ['chipnet', 'mainnet'] as const) {
      expect(w.networks[n].recordPath).toBe(`deployments/${n}/wallet-claims.json`);
      expect(w.networks[n].maxFundSats).toBeGreaterThan(0);
      expect(w.networks[n].maxFundSats).toBeLessThanOrEqual(FUND_CEILING_SATS[n]);
    }
    expect(w.networks.chipnet.outputDir).not.toBe(w.networks.mainnet.outputDir);
    const mainnet = w.networks.mainnet;
    const bad = (m: Partial<typeof mainnet>) => validateThirdPartyWallet({ ...w, networks: { ...w.networks, mainnet: { ...mainnet, ...m } } });
    expect(bad({ maxFundSats: FUND_CEILING_SATS.mainnet + 1 })).toEqual([`thirdPartyWallet.networks.mainnet.maxFundSats must be 1..${FUND_CEILING_SATS.mainnet}`]);
    expect(bad({ recordPath: w.networks.chipnet.recordPath })).toHaveLength(1);
    expect(bad({ outputDir: w.networks.chipnet.outputDir })).toEqual(['thirdPartyWallet.networks: each network needs its own outputDir']);
    expect(validateThirdPartyWallet({ ...w, networks: { ...w.networks, regtest: { ...mainnet, outputDir: 'state/w3-regtest' } } as typeof w.networks }))
      .toEqual(['thirdPartyWallet.networks.regtest: the driver runs on chipnet or mainnet only']);
  });

  it('--network picks that network\'s record and folder, chipnet when absent, and refuses one not listed', () => {
    const w = loadConfig().thirdPartyWallet;
    expect(walletNetwork(w, 'mainnet')).toEqual({ ...w.networks.mainnet, network: 'mainnet' });
    expect(walletNetwork(w, undefined)).toEqual({ ...w.networks.chipnet, network: 'chipnet' });
    expect(() => walletNetwork(w, 'testnet4')).toThrow(/--network testnet4/);
    const chipnetOnly = { ...w, networks: { chipnet: w.networks.chipnet } as typeof w.networks };
    expect(() => walletNetwork(chipnetOnly, 'mainnet')).toThrow(/runs on chipnet/);
  });

  it('keeps a mainnet claims record to mainnet addresses and refuses it where a chipnet record is expected', () => {
    const empty = parseWalletClaims(undefined, 'mainnet');
    expect(empty).toEqual({ network: 'mainnet', claims: [] });
    const r = addWalletClaim(empty, claim(MAINNET_ADDR));
    expect(parseWalletClaims(JSON.stringify(r), 'mainnet').claims).toHaveLength(1);
    expect(() => addWalletClaim(empty, claim(CHIPNET_ADDR))).toThrow(/not a mainnet address/);
    expect(() => parseWalletClaims(JSON.stringify(r), 'chipnet')).toThrow(/is for mainnet, not chipnet/);
  });

  it('refuses a wallet funding amount above the network\'s maxFundSats, or zero, before anything is built', () => {
    const mainnet = walletNetwork(loadConfig().thirdPartyWallet, 'mainnet');
    expect(() => checkFundAmount(mainnet, BigInt(mainnet.maxFundSats))).not.toThrow();
    expect(() => checkFundAmount(mainnet, BigInt(mainnet.maxFundSats) + 1n)).toThrow(/thirdPartyWallet\.networks\.mainnet\.maxFundSats/);
    expect(() => checkFundAmount(mainnet, 0n)).toThrow(RangeError);
  });
});

describe('operator pushes on mainnet', () => {
  it('config must keep pushDisabled true on mainnet', () => {
    const c = loadConfig();
    expect(c.networks.mainnet.pushDisabled).toBe(true);
    const off = { ...c, networks: { ...c.networks, mainnet: { ...c.networks.mainnet, pushDisabled: false } } };
    expect(validateConfig(off)).toContain('networks.mainnet.pushDisabled must be true');
  });

  it('arm and push --network mainnet fail with pushDisabledOnMainnet before reading the chain; chipnet is not blocked', async () => {
    const c = loadConfig();
    expect(() => assertPushAllowed({ config: c, network: 'mainnet' })).toThrow(PushDisabledError);
    expect(() => assertPushAllowed({ config: c, network: 'chipnet' })).not.toThrow();
    expect(() => assertPushAllowed({ config: c, network: 'mock' })).not.toThrow();
    const provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
    let reads = 0;
    const counted = new Proxy(provider, {
      get(target, key, receiver) {
        if (key === 'getUtxos' || key === 'getBlockHeight') reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    for (const argv of [['arm', '--network', 'mainnet', '--force'], ['push', MAINNET_ADDR, '--network', 'mainnet', '--epoch', 'deployments/mainnet/epoch-1.json']]) {
      const lines: string[] = [];
      const rc = await main(argv, { provider: counted, out: (l) => lines.push(l) });
      expect(rc).toBe(1);
      expect(lines.join('\n')).toMatch(/pushDisabledOnMainnet/);
    }
    expect(reads).toBe(0);
  });
});
