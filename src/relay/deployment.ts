// The pool record and epoch files a relayer claims against: deployments/<relay.deployment>/ (pool.json, epoch-N.json).
// Shared by the relay container and `tuai relay`, so both check the record against the contracts of this build.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NetworkProvider } from 'cashscript';
import { readEpochFile, type EpochFile } from '../epoch/file.ts';
import { poolContracts, type PoolContracts, type PoolParams } from '../pool/contracts.ts';
import { RELAY_NETWORK } from './config.ts';

export interface RelayDeployment {
  poolAddress: string;
  contracts: PoolContracts;
  epochs: EpochFile[];
}

/** `network` is the network the record must name: chipnet for the relayer, the chosen one for wallet claims. */
export function loadRelayDeployment(deploymentsDir: string, deployment: string, provider: NetworkProvider, network: string = RELAY_NETWORK): RelayDeployment {
  const dir = resolve(deploymentsDir, deployment);
  const record = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8')) as PoolParams & { network: string; contracts: Record<string, string> };
  if (record.network !== network) throw new Error(`deployment ${deployment} is not a ${network} pool`);
  const contracts = poolContracts(record, provider);
  if (contracts.pool.tokenAddress !== record.contracts.pool || contracts.vault.tokenAddress !== record.contracts.vault) {
    throw new Error('the pool record does not match the contracts in this build');
  }
  const epochs = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^epoch-\d+\.json$/.test(n))
        .map((n) => readEpochFile(join(dir, n)))
    : [];
  return { poolAddress: record.contracts.pool ?? '', contracts, epochs };
}
