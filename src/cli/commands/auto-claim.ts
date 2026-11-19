import { resolve } from 'node:path';
import { assertRelayNetwork } from '../../relay/config.ts';
import { loadRelayDeployment } from '../../relay/deployment.ts';
import { loadRelayKey } from '../../relay/key.ts';
import { readOptIns } from '../../relay/optins.ts';
import { createRelay } from '../../relay/service.ts';
import { flag, has, requireFlag, type ParsedArgs } from '../args.ts';
import type { Context } from '../context.ts';

/**
 * `relay --network chipnet --optins <file> [--key <file>] [--dry-run]`: one pass of relayer auto-claims
 * (docs/decisions/0010-relayer-auto-claim.md). For each opted-in leaf whose claimable amount reached its threshold,
 * the relayer key pays fee and dust and the contracts pay the reward to the leaf. Chipnet only, like the relayer.
 */
export async function relayAutoClaim(ctx: Context, a: ParsedArgs) {
  const relay = ctx.config.relay;
  assertRelayNetwork(ctx.network, relay);
  const optIns = readOptIns(resolve(requireFlag(a, 'optins')));
  const keyFile = flag(a, 'key') ?? process.env[relay.keyFileEnv] ?? resolve(ctx.stateDir, 'keys', `${relay.keyRole}.json`);
  const key = loadRelayKey(resolve(keyFile));
  const { contracts, epochs } = loadRelayDeployment(resolve(ctx.repoRoot, ctx.config.web.deploymentsDir), relay.deployment, ctx.provider);
  const service = createRelay({
    network: ctx.network,
    relay,
    fees: ctx.config.fees,
    prefix: ctx.prefix,
    contracts,
    epochs,
    key,
    provider: ctx.provider,
    now: ctx.now,
    off: process.env[relay.offEnv] === '1',
  });
  const dryRun = has(a, 'dry-run');
  const results = await service.autoClaim(optIns, dryRun);
  return { network: ctx.network, deployment: relay.deployment, relayer: key.address, dryRun, utc: ctx.now().toISOString(), results };
}
