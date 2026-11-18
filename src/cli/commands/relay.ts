import { resolve } from 'node:path';
import { assertRelayNetwork } from '../../relay/config.ts';
import { createRelayKey } from '../../relay/key.ts';
import type { ParsedArgs } from '../args.ts';
import type { Context } from '../context.ts';

/**
 * `relay-key --network chipnet`: makes the demo relayer's own key in state/keys/ (mode 0600, never overwritten) and
 * prints its address only. Refused on every network but chipnet (docs/decisions/0009-chipnet-relayer.md).
 */
export function relayKey(ctx: Context, _a: ParsedArgs) {
  assertRelayNetwork(ctx.network, ctx.config.relay);
  const role = ctx.config.relay.keyRole;
  const made = createRelayKey(resolve(ctx.stateDir, 'keys', `${role}.json`), role);
  return { network: ctx.network, role, address: made.address };
}
