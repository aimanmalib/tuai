// Measures claim and root-gate transactions on the mock network and writes reports/claim-sizes.json and docs/DEPTH.md.
// Run with `npm run claim-sizes`; tests/claim-sizes.test.ts fails when either committed file is stale.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TransactionBuilder } from 'cashscript';
import { REPO_ROOT, loadConfig } from '../src/config.ts';
import { treeDepth } from '../src/merkle/tree.ts';
import { leafFromAddress } from '../src/leaf.ts';
import { readPending, readPool } from '../src/pool/utxos.ts';
import { assembleClaim } from '../src/tx/claim.ts';
import { buildPropose } from '../src/tx/propose.ts';
import { buildActivate } from '../src/tx/activate.ts';
import {
  FEE_RATE, OPERATORS, advanceState, claimPlan, deployPool, fund, stateFor, syntheticProof, testKey, type PoolFixture,
} from '../tests/helpers/pool-fixture.ts';
import { DEPTH_DOC_PATH, renderDepthDoc, type ClaimSizeReport, type PoolInputUsage } from './depth-doc.ts';

export const REPORT_PATH = resolve(REPO_ROOT, 'reports/claim-sizes.json');
/** Depths shown in docs/DEPTH.md plus the tree depth of every recipient count in the cost comparison (docs/COST.md). */
export const DEPTHS = [...new Set([1, 9, 16, 24, ...loadConfig().cost.recipientCounts.map((n) => Math.max(1, treeDepth(n)))])].sort(
  (a, b) => a - b,
);
/** The VM adds this many bytes to the unlocking bytecode length when it sets an input's density budgets. */
const DENSITY_OVERHEAD_BYTES = 41;

const bytesOf = (tx: TransactionBuilder): number => tx.build().length / 2;

function poolInputUsage(tx: TransactionBuilder): PoolInputUsage {
  const m = tx.getVmResourceUsage()[0];
  if (!m) throw new Error('no VM metrics for input 0');
  return {
    unlockingBytes: Number(m.densityControlLength) - DENSITY_OVERHEAD_BYTES,
    operationCost: Number(m.operationCost),
    maximumOperationCost: Number(m.maximumOperationCost),
    hashDigestIterations: Number(m.hashDigestIterations),
    maximumHashDigestIterations: Number(m.maximumHashDigestIterations),
  };
}

async function measureClaims(depth: number) {
  const claimant = testKey('size claimant');
  const first = leafFromAddress(claimant.address, 1_000n);
  const one = syntheticProof(first, depth, 2 ** depth - 1);
  const f = await deployPool(stateFor(one.root));
  const firstTx = assembleClaim(claimPlan(f, await readPool(f.contracts), first, one.proof, claimant), f.provider);
  const firstClaimBytes = bytesOf(firstTx);
  const poolInput = poolInputUsage(firstTx);
  await firstTx.send();
  const later = leafFromAddress(claimant.address, 2_500n);
  const two = syntheticProof(later, depth, 2 ** depth - 1);
  const pool = await advanceState(f, stateFor(two.root, 2));
  const moreTx = assembleClaim(claimPlan(f, pool, later, two.proof, claimant), f.provider);
  const additionalClaimBytes = bytesOf(moreTx);
  await moreTx.send();
  return { depth, firstClaimBytes, additionalClaimBytes, poolInput };
}

async function measureOperator(f: PoolFixture) {
  const keeper = testKey('size keeper');
  const funding = (step: string) => ({ utxos: [fund(f, keeper, 50_000n, `size keeper ${step}`)], signer: keeper.signer, changeAddress: keeper.address });
  const proposal = stateFor(new Uint8Array(32).fill(2), 2);
  const proposeTx = buildPropose({
    contracts: f.contracts,
    pending: await readPending(f.contracts),
    proposal,
    operators: [OPERATORS[0]!.signer, OPERATORS[1]!.signer],
    funding: funding('propose'),
    feeRate: FEE_RATE,
  });
  const proposeBytes = bytesOf(proposeTx);
  await proposeTx.send();
  const activateTx = buildActivate({
    contracts: f.contracts,
    pool: await readPool(f.contracts),
    pending: await readPending(f.contracts),
    funding: funding('activate'),
    feeRate: FEE_RATE,
  });
  const activateBytes = bytesOf(activateTx);
  await activateTx.send();
  return { proposeBytes, activateBytes };
}

export async function measureReport(): Promise<ClaimSizeReport> {
  const f = await deployPool(stateFor(new Uint8Array(32), 1), undefined, 'size report');
  const claims = [];
  for (const depth of DEPTHS) claims.push(await measureClaims(depth));
  return {
    description:
      'Transaction sizes in bytes, measured on the CashScript mock network (BCH_2026_05 VM). Claims: one P2PKH funding ' +
      'input and one change output, Schnorr signatures, proofs at the deepest index of each depth. Root gate: ' +
      'two ECDSA operator signatures for propose, no operator key for activate; one funding input and one change output each.',
    generatedBy: 'scripts/claim-sizes.ts',
    feeRateSatsPerByte: FEE_RATE,
    contractBytes: { ClaimPool: f.contracts.pool.bytesize, PoolVault: f.contracts.vault.bytesize, RootGate: f.contracts.gate.bytesize },
    claims,
    operator: await measureOperator(f),
  };
}

export async function renderClaimSizes(): Promise<{ report: string; depthDoc: string }> {
  const report = await measureReport();
  return { report: `${JSON.stringify(report, null, 2)}\n`, depthDoc: renderDepthDoc(report) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(REPO_ROOT, 'scripts/claim-sizes.ts')) {
  const { report, depthDoc } = await renderClaimSizes();
  writeFileSync(REPORT_PATH, report);
  writeFileSync(DEPTH_DOC_PATH, depthDoc);
  console.log(`wrote ${REPORT_PATH} and ${DEPTH_DOC_PATH}`);
}
