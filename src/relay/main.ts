// Entry point of the relay container: `node src/relay/main.ts`. Refuses to start without a chipnet key file or
// for any network but chipnet. Reads the pool record and epoch files baked into the image from deployments/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ElectrumNetworkProvider } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../config.ts';
import { readEpochFile } from '../epoch/file.ts';
import { poolContracts, type PoolParams } from '../pool/contracts.ts';
import { RELAY_NETWORK, assertRelayNetwork } from './config.ts';
import { relayHandler, startRelayServer } from './http.ts';
import { loadRelayKey } from './key.ts';
import { createRelay } from './service.ts';

const config = loadConfig();
const relay = config.relay;
assertRelayNetwork(RELAY_NETWORK, relay);
const keyFile = process.env[relay.keyFileEnv];
if (!keyFile) throw new Error(`${relay.keyFileEnv} is not set; the relayer does not start without its key file`);
const key = loadRelayKey(keyFile);

const dir = resolve(REPO_ROOT, config.web.deploymentsDir, relay.deployment);
const record = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8')) as PoolParams & { network: string; contracts: Record<string, string> };
if (record.network !== RELAY_NETWORK) throw new Error(`deployment ${relay.deployment} is not a ${RELAY_NETWORK} pool`);
const net = config.networks[RELAY_NETWORK];
const provider = new ElectrumNetworkProvider(RELAY_NETWORK, { hostname: net.electrum?.hostname ?? '' });
const contracts = poolContracts(record, provider);
if (contracts.pool.tokenAddress !== record.contracts.pool || contracts.vault.tokenAddress !== record.contracts.vault) {
  throw new Error('the pool record does not match the contracts in this build');
}
const epochs = existsSync(dir)
  ? readdirSync(dir)
      .filter((n) => /^epoch-\d+\.json$/.test(n))
      .map((n) => readEpochFile(join(dir, n)))
  : [];

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
log(`relayer on ${RELAY_NETWORK}, pool ${record.contracts.pool}, relayer address ${key.address}, port ${relay.port}`);
