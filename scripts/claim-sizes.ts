// Measures claim transaction sizes on the mock network and writes reports/claim-sizes.json.
// Run with `npm run claim-sizes`; tests/claim-sizes.test.ts fails when the committed report is stale.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { leafFromAddress } from '../src/leaf.ts';
import { readPool } from '../src/pool/utxos.ts';
import { assembleClaim } from '../src/tx/claim.ts';
import { FEE_RATE, claimPlan, deployPool, replaceState, stateFor, syntheticProof, testKey } from '../tests/helpers/pool-fixture.ts';

export const REPORT_PATH = resolve(REPO_ROOT, 'reports/claim-sizes.json');
export const DEPTHS = [1, 9, 16, 24];

export interface ClaimSize {
  depth: number;
  firstClaimBytes: number;
  additionalClaimBytes: number;
}

async function measure(depth: number): Promise<ClaimSize> {
  const claimant = testKey('size claimant');
  const first = leafFromAddress(claimant.address, 1_000n);
  const one = syntheticProof(first, depth, 2 ** depth - 1);
  const f = await deployPool(stateFor(one.root));
  const firstTx = assembleClaim(claimPlan(f, await readPool(f.contracts), first, one.proof, claimant), f.provider);
  const firstClaimBytes = firstTx.build().length / 2;
  await firstTx.send();
  const later = leafFromAddress(claimant.address, 2_500n);
  const two = syntheticProof(later, depth, 2 ** depth - 1);
  const pool = await replaceState(f, stateFor(two.root, 2));
  const moreTx = assembleClaim(claimPlan(f, pool, later, two.proof, claimant), f.provider);
  const additionalClaimBytes = moreTx.build().length / 2;
  await moreTx.send();
  return { depth, firstClaimBytes, additionalClaimBytes };
}

export async function renderClaimSizes(): Promise<string> {
  const f = await deployPool(stateFor(new Uint8Array(32)));
  const claims: ClaimSize[] = [];
  for (const depth of DEPTHS) claims.push(await measure(depth));
  const report = {
    description:
      'Claim transaction sizes in bytes, measured on the CashScript mock network (BCH_2026_05 VM). One P2PKH funding input ' +
      'and one change output; Schnorr signatures. Proofs use the deepest index at each depth.',
    generatedBy: 'scripts/claim-sizes.ts',
    feeRateSatsPerByte: FEE_RATE,
    contractBytes: { ClaimPool: f.contracts.pool.bytesize, PoolVault: f.contracts.vault.bytesize },
    claims,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(REPO_ROOT, 'scripts/claim-sizes.ts')) {
  writeFileSync(REPORT_PATH, await renderClaimSizes());
  console.log(`wrote ${REPORT_PATH}`);
}
