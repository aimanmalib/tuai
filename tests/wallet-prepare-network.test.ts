// Wallet claims on mainnet (docs/decisions/0012-wallet-claims.md, "Mainnet wallet claims"): the prepare route picks
// the network the request names and reads only that network's chain and deployments/<folder>/ record. The keyed
// relayer stays on chipnet; nothing on this path loads or receives the relay key.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCashAddress } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { validateRelay, validateWallet, type WalletNetwork } from '../src/relay/config.ts';
import { addressToLockingBytecode } from '../src/leaf.ts';
import { createPrepare } from '../src/relay/prepare.ts';
import { routePrepare, walletPrepares } from '../src/relay/wallet-networks.ts';

const config = loadConfig();
const W = config.relay.wallet;
const deploymentsDir = resolve(REPO_ROOT, config.web.deploymentsDir);
const payload = new Uint8Array(20).fill(0x5a);
const walletAddr = (prefix: 'bitcoincash' | 'bchtest') => encodeCashAddress({ prefix, type: 'p2pkh', payload }).address;
const leafOf = (network: string) =>
  (JSON.parse(readFileSync(resolve(deploymentsDir, network, 'epoch-1.json'), 'utf8')) as { leaves: { address: string }[] }).leaves[0]!.address;
const body = (network: string | undefined, prefix: 'bitcoincash' | 'bchtest', leaf: string) => ({
  ...(network === undefined ? {} : { network }),
  address: leaf,
  change: walletAddr(prefix),
  wallet: [walletAddr(prefix)],
});

/** A chain reader that records every address it is asked about and then fails, so a test sees which chain was read. */
function recordingProvider(network: WalletNetwork) {
  const asked: string[] = [];
  const fail = (what: string) => Promise.reject(new Error(`fake ${network} chain: ${what}`));
  const provider = {
    network,
    getUtxos: (address: string) => (asked.push(address), fail('getUtxos')),
    getBlockHeight: () => fail('getBlockHeight'),
    getRawTransaction: () => fail('getRawTransaction'),
    sendRawTransaction: () => fail('sendRawTransaction'),
  } as unknown as NetworkProvider;
  return { provider, asked };
}

function world() {
  const chains = { chipnet: recordingProvider('chipnet'), mainnet: recordingProvider('mainnet') };
  const keyEnv = config.relay.keyFileEnv;
  const saved = process.env[keyEnv];
  delete process.env[keyEnv];
  try {
    const routes = walletPrepares({ config, deploymentsDir, providerFor: (n) => chains[n].provider, now: () => new Date(), off: false });
    return { chains, routes, prepare: routePrepare(routes) };
  } finally {
    if (saved !== undefined) process.env[keyEnv] = saved;
  }
}

const script = (address: string) => Buffer.from(addressToLockingBytecode(address)).toString('hex');
/** Locking script of a network's published pool, so the token and plain address forms compare equal. */
const poolOf = (network: string) =>
  script((JSON.parse(readFileSync(resolve(deploymentsDir, network, 'pool.json'), 'utf8')) as { contracts: { pool: string } }).contracts.pool);

describe('wallet claims per network', () => {
  it('config serves chipnet and mainnet wallet claims while the keyed relayer stays on chipnet', () => {
    expect(config.relay.networks).toEqual(['chipnet']);
    expect([...W.networks].sort()).toEqual(['chipnet', 'mainnet']);
    expect(W.deployments).toMatchObject({ chipnet: 'chipnet', mainnet: 'mainnet' });
    expect(validateRelay(config.relay)).toEqual([]);
    expect(validateWallet({ ...W, networks: ['chipnet', 'regtest'] }).join()).toMatch(/relay\.wallet\.networks/);
    expect(validateWallet({ ...W, networks: ['chipnet', 'chipnet'] }).join()).toMatch(/each once/);
    expect(validateWallet({ ...W, deployments: { chipnet: 'chipnet', mainnet: 'chipnet' } }).join()).toMatch(/deployments\.mainnet must be a mainnet/);
    expect(validateWallet({ ...W, deployments: { chipnet: 'chipnet' } }).join()).toMatch(/deployments\.mainnet/);
  });

  it('a mainnet request reads the mainnet pool on the mainnet chain only, with no relay key loaded', async () => {
    const { chains, routes, prepare } = world();
    expect([...routes.keys()].sort()).toEqual(['chipnet', 'mainnet']);
    const err = await prepare(body('mainnet', 'bitcoincash', leafOf('mainnet'))).catch((e: Error) => e);
    expect(String(err)).toMatch(/fake mainnet chain/);
    expect(chains.mainnet.asked.map(script)).toContain(poolOf('mainnet'));
    expect(chains.chipnet.asked).toEqual([]);
  });

  it('a request without a network name goes to chipnet, as before mainnet was served', async () => {
    const { chains, prepare } = world();
    const err = await prepare(body(undefined, 'bchtest', leafOf('chipnet'))).catch((e: Error) => e);
    expect(String(err)).toMatch(/fake chipnet chain/);
    expect(chains.chipnet.asked.map(script)).toContain(poolOf('chipnet'));
    expect(chains.mainnet.asked).toEqual([]);
  });

  it('refuses a network that is not served and addresses of the other network, before reading any chain', async () => {
    const { chains, prepare } = world();
    for (const n of ['regtest', 'mock', 42]) {
      const r = await prepare({ ...body('mainnet', 'bitcoincash', leafOf('mainnet')), network: n });
      expect(r).toMatchObject({ status: 400, body: { code: 'wrongNetwork' } });
    }
    expect((await prepare(body('mainnet', 'bchtest', leafOf('chipnet')))).body.code).toBe('wrongNetwork');
    expect((await prepare(body('chipnet', 'bitcoincash', leafOf('mainnet')))).body.code).toBe('wrongNetwork');
    expect(chains.chipnet.asked).toEqual([]);
    expect(chains.mainnet.asked).toEqual([]);
  });

  it('a route is only built for a network config lists, and the off switch closes mainnet too', async () => {
    const chipnetOnly = { ...config, relay: { ...config.relay, wallet: { ...W, networks: ['chipnet'] } } };
    const routes = walletPrepares({ config: chipnetOnly, deploymentsDir, providerFor: (n) => recordingProvider(n).provider, now: () => new Date(), off: false });
    expect([...routes.keys()]).toEqual(['chipnet']);
    expect((await routePrepare(routes)(body('mainnet', 'bitcoincash', leafOf('mainnet')))).body.code).toBe('wrongNetwork');
    const mainnet = recordingProvider('mainnet');
    expect(() =>
      createPrepare({
        network: 'mainnet', relay: chipnetOnly.relay, fees: config.fees, prefix: 'bitcoincash',
        contracts: {} as never, epochs: [], provider: mainnet.provider, now: () => new Date(), off: false,
      }),
    ).toThrow(/not served on mainnet/);
    const off = walletPrepares({ config, deploymentsDir, providerFor: (n) => recordingProvider(n).provider, now: () => new Date(), off: true });
    expect((await routePrepare(off)(body('mainnet', 'bitcoincash', leafOf('mainnet')))).status).toBe(503);
  });
});
