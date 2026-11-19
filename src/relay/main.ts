// Entry point of the relay container: `node src/relay/main.ts`. Refuses to start without a chipnet key file or
// for any network but chipnet. Reads the pool record and epoch files baked into the image from deployments/.
import { resolve } from 'node:path';
import { ElectrumNetworkProvider } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../config.ts';
import { RELAY_NETWORK, assertRelayNetwork } from './config.ts';
import { loadRelayDeployment } from './deployment.ts';
import { relayHandler, startRelayServer } from './http.ts';
import { loadRelayKey } from './key.ts';
import { createRelay } from './service.ts';

const config = loadConfig();
const relay = config.relay;
assertRelayNetwork(RELAY_NETWORK, relay);
const keyFile = process.env[relay.keyFileEnv];
if (!keyFile) throw new Error(`${relay.keyFileEnv} is not set; the relayer does not start without its key file`);
const key = loadRelayKey(keyFile);

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
  off: process.env[relay.offEnv] === '1',
});
const log = (line: string) => process.stdout.write(`${line}\n`);
startRelayServer(relay.port, relayHandler(relay, service, log));
log(`relayer on ${RELAY_NETWORK}, pool ${poolAddress}, relayer address ${key.address}, port ${relay.port}`);
