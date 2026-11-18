// Demo relayer settings (docs/decisions/0009-chipnet-relayer.md). The relayer exists on chipnet only: the constant
// below is checked in code as well as in config, so a config edit alone cannot point it at another network.

/** The one network the relayer may ever run on. Test coins only. */
export const RELAY_NETWORK = 'chipnet';

export interface RelayConfig {
  enabled: boolean;
  /** Must be exactly ["chipnet"]. */
  networks: string[];
  /** Folder under deployments/ whose pool.json and epoch files the relayer claims against. */
  deployment: string;
  port: number;
  statusPath: string;
  /** Container health check; answers without reading the chain. */
  healthPath: string;
  claimPath: string;
  /** Global limit; no per-client limit because a client address cannot be trusted behind the proxies. */
  maxClaimsPerHour: number;
  /** Below this balance the button is switched off with a named reason. */
  minBalanceSats: number;
  /** A planned claim whose fee is higher is refused before it is sent. */
  maxFeeSatsPerClaim: number;
  maxBodyBytes: number;
  electrumTimeoutSeconds: number;
  /** Environment variable naming the key file, mounted read-only into the relay container. */
  keyFileEnv: string;
  /** Environment variable that switches the relayer off when set to 1. */
  offEnv: string;
  /** Role written into a key file made by `tuai relay-key`. */
  keyRole: string;
}

const isPositiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/** Throws unless the network is the relay network and config lists it as the only one. */
export function assertRelayNetwork(network: string, config: Pick<RelayConfig, 'networks'>): void {
  if (network !== RELAY_NETWORK) throw new Error(`the relayer runs on ${RELAY_NETWORK} only, not ${network}`);
  if (config.networks.length !== 1 || config.networks[0] !== RELAY_NETWORK) {
    throw new Error(`relay.networks must be exactly ["${RELAY_NETWORK}"]`);
  }
}

export function validateRelay(r: RelayConfig | undefined): string[] {
  if (!r) return ['relay is missing'];
  const out: string[] = [];
  if (typeof r.enabled !== 'boolean') out.push('relay.enabled must be true or false');
  if (!Array.isArray(r.networks) || r.networks.length !== 1 || r.networks[0] !== RELAY_NETWORK) {
    out.push(`relay.networks must be exactly ["${RELAY_NETWORK}"]`);
  }
  if (!/^chipnet(-[a-z0-9-]+)?$/.test(r.deployment ?? '')) out.push('relay.deployment must be a chipnet deployment folder');
  if (!isPositiveInt(r.port) || r.port > 65535) out.push('relay.port must be 1..65535');
  for (const k of ['statusPath', 'healthPath', 'claimPath'] as const) {
    if (!/^\/api\/relay\/[a-z]+$/.test(r[k] ?? '')) out.push(`relay.${k} must be under /api/relay/`);
  }
  for (const k of ['maxClaimsPerHour', 'minBalanceSats', 'maxFeeSatsPerClaim', 'maxBodyBytes', 'electrumTimeoutSeconds'] as const) {
    if (!isPositiveInt(r[k])) out.push(`relay.${k} must be > 0`);
  }
  for (const k of ['keyFileEnv', 'offEnv'] as const) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(r[k] ?? '')) out.push(`relay.${k} must be an environment variable name`);
  }
  if (!/^relay-chipnet[a-z0-9-]*$/.test(r.keyRole ?? '')) out.push('relay.keyRole must start with relay-chipnet');
  return out;
}
