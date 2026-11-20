import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchDistro } from '../../api/distro.ts';
import { buildEpoch, type InputSource } from '../../epoch/build.ts';
import { readEpochFile } from '../../epoch/file.ts';
import { verifyEpoch } from '../../epoch/verify.ts';
import type { LinkMethod } from '../../leaf.ts';
import { flag, flags, has, requireFlag, type ParsedArgs } from '../args.ts';
import type { Context } from '../context.ts';

async function sources(ctx: Context, a: ParsedArgs): Promise<{ list: InputSource[]; fromCache: boolean[] }> {
  const source = requireFlag(a, 'source');
  if (source === 'fixture') {
    const files = flags(a, 'file');
    if (files.length === 0) throw new Error('--file is required with --source fixture');
    return { list: files.map((f) => ({ bytes: readFileSync(f) })), fromCache: [] };
  }
  if (source !== 'api') throw new Error('--source must be api or fixture');
  const api = ctx.config.sponsorApi;
  const options = {
    ...api,
    cacheDir: resolve(ctx.repoRoot, api.cacheDir),
    now: ctx.now,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  };
  // `--real` (ADR 0015): one request per configured window, all user types. Each is cached, so a rate limited run
  // is simply repeated a minute later and only the missing window is fetched.
  const queries = has(a, 'real')
    ? api.realEpoch.windows.map((w) => ({
        ...w,
        amount: Number(flag(a, 'amount') ?? api.realEpoch.amount),
        includeFoldingUserTypes: api.realEpoch.includeFoldingUserTypes,
      }))
    : [{
        startDate: requireFlag(a, 'start'),
        endDate: requireFlag(a, 'end'),
        amount: Number(requireFlag(a, 'amount')),
        includeFoldingUserTypes: api.includeFoldingUserTypes,
      }];
  const list: InputSource[] = [];
  const fromCache: boolean[] = [];
  for (const q of queries) {
    const response = await fetchDistro(options, q);
    list.push({ bytes: response.bytes, request: { path: response.path, query: response.query } });
    fromCache.push(response.fromCache);
  }
  return { list, fromCache };
}

/** `epoch build --source api [--real] | --source fixture ...`: adds new allocations to the previous epoch and writes the next epoch file. */
export async function epochBuild(ctx: Context, a: ParsedArgs) {
  const previousPath = flag(a, 'previous');
  const nextEpoch = previousPath ? readEpochFile(previousPath).epoch + 1 : 1;
  const outPath = flag(a, 'out') ?? resolve(ctx.repoRoot, 'deployments', ctx.deployment, `epoch-${nextEpoch}.json`);
  const { list, fromCache } = await sources(ctx, a);
  const method = Number(flag(a, 'method') ?? ctx.config.sponsorApi.linkMethod) as LinkMethod;
  const file = buildEpoch({
    network: ctx.network,
    prefix: ctx.prefix,
    outPath,
    maxDepth: ctx.config.tree.maxDepth,
    defaultMethod: method,
    decimals: ctx.config.rewards.decimals,
    ...(previousPath ? { previousPath } : {}),
    sources: list,
  });
  return { out: outPath, epoch: file.epoch, root: file.root, inputsHash: file.inputsHash, leaves: file.leaves.length, depth: file.depth, fromCache };
}

/** `epoch verify <file>`: recomputes the epoch from its manifest and inputs. Exit code 1 on any difference. */
export function epochVerify(_ctx: Context, a: ParsedArgs) {
  const path = a.positional[2];
  if (!path) throw new Error('usage: tuai epoch verify <file>');
  return verifyEpoch(path);
}
