// Entry point of the relay container: `node src/relay/main.ts`. Refuses to start without a chipnet key file or
// for any network but chipnet. Reads the pool record and epoch files baked into the image from deployments/.
// The wallet prepare route also serves the networks in relay.wallet.networks; it never receives the key.
import { resolve } from 'node:path';
import { ElectrumNetworkProvider } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../config.ts';
import { RELAY_NETWORK, assertRelayNetwork, type WalletNetwork } from './config.ts';
import { loadRelayDeployment } from './deployment.ts';
import { relayHandler, startRelayServer } from './http.ts';
import { loadRelayKey } from './key.ts';
import { createRelay } from './service.ts';
import { routePrepare, walletPrepares } from './wallet-networks.ts';

const config = loadConfig();
const relay = config.relay;
assertRelayNetwork(RELAY_NETWORK, relay);
const keyFile = process.env[relay.keyFileEnv];
if (!keyFile) throw new Error(`${relay.keyFileEnv} is not set; the relayer does not start without its key file`);
const key = loadRelayKey(keyFile);

const off = process.env[relay.offEnv] === '1';
const net = config.networks[RELAY_NETWORK];
const provider = new ElectrumNetworkProvider(RELAY_NETWORK, { hostname: net.electrum?.hostname ?? '' });
const { poolAddress, contracts, epochs } = loadRelayDeployment(resolve(REPO_ROOT, config.web.deploymentsDir), relay.deployment, provider);

const service = createRelay({
  network: RELAY_NETWORK,
  relay,
  fees: config.fees,
  prefix: net.addressPrefix,
  contracts,
  epochs,
  key,
  provider,
  now: () => new Date(),
  off,
});
const providerFor = (n: WalletNetwork) =>
  n === RELAY_NETWORK ? provider : new ElectrumNetworkProvider(n, { hostname: config.networks[n]?.electrum?.hostname ?? '' });
const wallet = walletPrepares({ config, deploymentsDir: resolve(REPO_ROOT, config.web.deploymentsDir), providerFor, now: () => new Date(), off });
const log = (line: string) => process.stdout.write(`${line}\n`);
startRelayServer(relay.port, relayHandler(relay, { ...service, prepare: routePrepare(wallet) }, log));
log(`relayer on ${RELAY_NETWORK}, pool ${poolAddress}, relayer address ${key.address}, port ${relay.port}`);
log(`wallet claims prepared on ${[...wallet.keys()].join(', ')}`);
