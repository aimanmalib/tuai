import { readFileSync } from 'node:fs';
import { binToHex } from '@bitauth/libauth';
import { readEpochFile } from '../../epoch/file.ts';
import { verifyEpoch } from '../../epoch/verify.ts';
import { readPending, readPool } from '../../pool/utxos.ts';
import { addressesInFahSummary, checkLinks } from '../../watch/fah.ts';
import { flag, requireFlag, type ParsedArgs } from '../args.ts';
import type { Context } from '../context.ts';
import { contractsFor } from '../pool.ts';
import { readRunLog } from '../runs.ts';

/**
 * `watch --epoch <file> [--fah <daily_user_summary.txt>]`: recomputes the epoch, checks method 0 leaves against
 * public Folding@home names, and when a pool is deployed compares the file with the active and pending roots.
 */
export async function watch(ctx: Context, a: ParsedArgs) {
  const path = requireFlag(a, 'epoch');
  const verify = verifyEpoch(path);
  const findings = [...verify.problems];
  const fahPath = flag(a, 'fah');
  let links = null;
  if (fahPath) {
    links = checkLinks(readEpochFile(path), addressesInFahSummary(readFileSync(fahPath, 'utf8')));
    for (const u of links.unlinked) findings.push(`leaf ${u.index} (${u.address ?? 'no address'}) is not linked in any Folding@home name`);
  }
  let chain = null;
  if (readRunLog(ctx).pool) {
    const contracts = contractsFor(ctx);
    const active = (await readPool(contracts)).decodedState;
    const pending = (await readPending(contracts)).pending;
    const file = readEpochFile(path);
    const onChain = [active, pending].find((s) => s.epoch === file.epoch);
    chain = { activeEpoch: active.epoch, pendingEpoch: pending.epoch, matched: false };
    if (onChain) {
      chain.matched = binToHex(onChain.root) === file.root && binToHex(onChain.inputsHash) === file.inputsHash;
      if (!chain.matched) findings.push(`epoch ${file.epoch} on chain commits to a different root or inputs hash than this file`);
    }
  }
  return { ok: findings.length === 0, epoch: verify.epoch, root: verify.root, leaves: verify.leaves, links, chain, findings };
}
