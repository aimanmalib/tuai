// Wallet claims on more than one network (docs/decisions/0012-wallet-claims.md, "Mainnet wallet claims"). The prepare
// route reads coins and plans an unsigned claim; it never signs or spends, so it may serve mainnet. Nothing here
// loads or receives the relay key: the keyed relayer (service.ts) stays on chipnet only.
import type { NetworkProvider } from 'cashscript';
import type { TuaiConfig } from '../config.ts';
import type { CashAddressPrefix } from '../leaf.ts';
import { RELAY_NETWORK, assertWalletNetwork, type WalletNetwork } from './config.ts';
import { loadRelayDeployment } from './deployment.ts';
import { reply, type RelayReply } from './lookup.ts';
import { createPrepare, type Prepare } from './prepare.ts';

export interface WalletPrepareOptions {
  config: Pick<TuaiConfig, 'relay' | 'fees' | 'networks'>;
  deploymentsDir: string;
  /** The chain reader of one network; called once per network listed in relay.wallet.networks. */
  providerFor: (network: WalletNetwork) => NetworkProvider;
  now: () => Date;
  off: boolean;
}

/** One prepare route per network in relay.wallet.networks, each reading its own deployments/<folder>/ record. */
export function walletPrepares(o: WalletPrepareOptions): Map<string, Prepare> {
  const w = o.config.relay.wallet;
  const out = new Map<string, Prepare>();
  for (const network of w.networks) {
    assertWalletNetwork(network, w);
    const name = network as WalletNetwork;
    const provider = o.providerFor(name);
    const { contracts, epochs } = loadRelayDeployment(o.deploymentsDir, w.deployments[network] ?? '', provider, network);
    const prefix = o.config.networks[name]?.addressPrefix as CashAddressPrefix;
    out.set(network, createPrepare({ network, relay: o.config.relay, fees: o.config.fees, prefix, contracts, epochs, provider, now: o.now, off: o.off }));
  }
  return out;
}

/** Sends a prepare request to the route of the network it names; no name means chipnet, as before mainnet was served. */
export function routePrepare(byNetwork: ReadonlyMap<string, Prepare>): (body: unknown) => Promise<RelayReply> {
  return async (body) => {
    const asked = body && typeof body === 'object' && 'network' in body ? (body as { network: unknown }).network : RELAY_NETWORK;
    const route = typeof asked === 'string' ? byNetwork.get(asked) : undefined;
    if (!route) return reply(400, 'wrongNetwork', { network: typeof asked === 'string' ? asked.slice(0, 20) : '' });
    return route.prepare(body);
  };
}
