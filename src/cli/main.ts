import { t } from '../i18n.ts';
import { RateLimitedError } from '../api/distro.ts';
import { BudgetExceededError } from './budget.ts';
import { parseArgs, flag, has, type ParsedArgs } from './args.ts';
import { makeContext, parseNetwork, type Context, type ContextOverrides } from './context.ts';
import { claim } from './commands/claim.ts';
import { deploy, tokenGenesis } from './commands/deploy.ts';
import { demoAllocations, demoDoubleClaim, fund } from './commands/demo.ts';
import { epochBuild, epochVerify } from './commands/epoch.ts';
import { NotYetError, activate, propose } from './commands/root.ts';
import { arm, push } from './commands/push.ts';
import { linkSign, linkVerify } from './commands/link.ts';
import { relayKey } from './commands/relay.ts';
import { relayAutoClaim } from './commands/auto-claim.ts';
import { budget, status } from './commands/status.ts';
import { watch } from './commands/watch.ts';

type Handler = (ctx: Context, a: ParsedArgs) => unknown;

const COMMANDS: Record<string, Handler> = {
  'epoch build': epochBuild,
  'epoch verify': epochVerify,
  'token genesis': tokenGenesis,
  watch,
  'link sign': linkSign,
  'link verify': linkVerify,
  deploy,
  propose,
  activate,
  claim,
  arm,
  push,
  status,
  budget,
  fund,
  'relay-key': relayKey,
  relay: relayAutoClaim,
  'demo allocations': demoAllocations,
  'demo double-claim': demoDoubleClaim,
};

/** Exit codes: 0 done, 1 failed or a check found a difference, 2 usage error, 3 not yet possible (retry later). */
export const EXIT = { ok: 0, failed: 1, usage: 2, notYet: 3 } as const;

const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 1);

function findCommand(a: ParsedArgs): [string, Handler] | undefined {
  const two = a.positional.slice(0, 2).join(' ');
  if (COMMANDS[two]) return [two, COMMANDS[two]];
  const one = a.positional[0] ?? '';
  return COMMANDS[one] && !one.includes(' ') ? [one, COMMANDS[one]] : undefined;
}

const failedCheck = (result: unknown): boolean =>
  typeof result === 'object' && result !== null && 'ok' in result && (result as { ok: unknown }).ok === false;

/** Runs one CLI command. Tests call this directly with a shared mock network. */
export async function main(argv: readonly string[], overrides: ContextOverrides = {}): Promise<number> {
  const out = overrides.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  let a: ParsedArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    out(t('cli.error', { message: (e as Error).message }));
    return EXIT.usage;
  }
  const found = findCommand(a);
  if (!found || has(a, 'help')) {
    out([t('cli.usage'), ...Object.keys(COMMANDS).map((c) => `  tuai ${c}`), t('cli.networks'), t('cli.runs')].join('\n'));
    return found || has(a, 'help') ? EXIT.ok : EXIT.usage;
  }
  const [name, handler] = found;
  try {
    const run = flag(a, 'run');
    const ctx = makeContext(parseNetwork(flag(a, 'network')), { ...overrides, out, ...(run === undefined ? {} : { run }) });
    const result = await handler(ctx, a);
    if (has(a, 'json')) out(toJson(result));
    else out(`${t('cli.done', { command: name, network: ctx.network })}\n${toJson(result)}`);
    return failedCheck(result) ? EXIT.failed : EXIT.ok;
  } catch (e) {
    const err = e as Error;
    if (err instanceof NotYetError || err instanceof RateLimitedError) {
      out(t('cli.notYet', { message: err.message }));
      return EXIT.notYet;
    }
    if (err instanceof BudgetExceededError) {
      out(t('budget.exceeded', { spent: err.spent, next: err.next, limit: err.limit }));
      return EXIT.failed;
    }
    out(t('cli.error', { message: err.message }));
    return EXIT.failed;
  }
}
