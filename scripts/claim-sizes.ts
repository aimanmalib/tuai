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
import { assemblePush } from '../src/tx/push.ts';
import { buildPropose } from '../src/tx/propose.ts';
import { assembleActivate, buildActivate } from '../src/tx/activate.ts';
import { planArm, planPush } from '../src/tx/push.ts';
import type { PushParams } from '../src/pool/contracts.ts';
import {
  FEE_RATE, OPERATORS, PUSH, SATS, advanceState, claimPlan, deployPool, fund, stateFor, syntheticProof, testKey, type PoolFixture,
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
/** Depth of the push and version 1 measurements (a tree of up to 512 leaves, as in the chipnet demonstration). */
export const PUSH_DEPTH = 9;
/** Shards of the sharded-pool measurement (ADR 0013). */
export const SHARDED_POOL = 4;

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

async function measureClaims(depth: number, push: PushParams | null = PUSH, shards = 1) {
  const claimant = testKey('size claimant');
  const first = leafFromAddress(claimant.address, 1_000n);
  const one = syntheticProof(first, depth, 2 ** depth - 1);
  const f = await deployPool(stateFor(one.root), undefined, undefined, push, SATS, shards);
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

/** Arm once per root, then push a first and an additional balance; no keeper inputs, the vault pays. */
async function measurePush(depth: number) {
  const keeper = testKey('size keeper');
  const recipient = testKey('size push recipient');
  const arm = async (f: PoolFixture) => {
    const tx = assembleActivate(
      planArm({
        contracts: f.contracts,
        pool: await readPool(f.contracts),
        pending: await readPending(f.contracts),
        funding: { utxos: [fund(f, keeper)], signer: keeper.signer, changeAddress: keeper.address },
        feeRate: FEE_RATE,
      }),
      f.provider,
    );
    const bytes = bytesOf(tx);
    await tx.send();
    return bytes;
  };
  const push = async (f: PoolFixture, amount: bigint, root: (leaf: ReturnType<typeof leafFromAddress>) => ReturnType<typeof syntheticProof>) => {
    const leaf = leafFromAddress(recipient.address, amount);
    const plan = planPush({
      contracts: f.contracts,
      pool: await readPool(f.contracts),
      pending: await readPending(f.contracts),
      leaf,
      proof: root(leaf).proof,
      paymentSats: SATS,
      receiptSats: SATS,
      feeRate: FEE_RATE,
    });
    const tx = assemblePush(plan, f.provider);
    const bytes = bytesOf(tx);
    await tx.send();
    return { bytes, vaultSats: Number(plan.vaultSats) };
  };
  const proofFor = (leaf: ReturnType<typeof leafFromAddress>) => syntheticProof(leaf, depth, 2 ** depth - 1);
  const f = await deployPool(stateFor(proofFor(leafFromAddress(recipient.address, 1_000n)).root), undefined, undefined, PUSH, 50_000n);
  const armBytes = await arm(f);
  const first = await push(f, 1_000n, proofFor);
  await advanceState(f, stateFor(proofFor(leafFromAddress(recipient.address, 2_500n)).root, 2));
  await arm(f);
  const additional = await push(f, 2_500n, proofFor);
  return {
    depth,
    armBytes,
    firstPushBytes: first.bytes,
    firstPushVaultSats: first.vaultSats,
    additionalPushBytes: additional.bytes,
    additionalPushVaultSats: additional.vaultSats,
  };
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
  const v1 = await deployPool(stateFor(new Uint8Array(32), 1), undefined, 'size report v1', null);
  const claims = [];
  for (const depth of DEPTHS) claims.push(await measureClaims(depth));
  return {
    description:
      'Transaction sizes in bytes, measured on the CashScript mock network (BCH_2026_05 VM). Claims: one P2PKH funding ' +
      'input and one change output, Schnorr signatures, proofs at the deepest index of each depth. Root gate: ' +
      'two ECDSA operator signatures for propose, no operator key for activate; one funding input and one change output each. ' +
      'Push: arm with one funding input and one change output; pushes without keeper inputs (the vault pays). ' +
      'version1Claim: the same claims on the version 1 contracts (no push path) of the recorded chipnet pool. ' +
      'shardedClaim: the same claims on a pool deployed with several state NFT and reward token pairs (ADR 0013).',
    generatedBy: 'scripts/claim-sizes.ts',
    feeRateSatsPerByte: FEE_RATE,
    contractBytes: { ClaimPool: f.contracts.pool.bytesize, PoolVault: f.contracts.vault.bytesize, RootGate: f.contracts.gate.bytesize },
    version1ContractBytes: { ClaimPool: v1.contracts.pool.bytesize, PoolVault: v1.contracts.vault.bytesize, RootGate: v1.contracts.gate.bytesize },
    claims,
    operator: await measureOperator(f),
    push: await measurePush(PUSH_DEPTH),
    version1Claim: await measureClaims(PUSH_DEPTH, null),
    shardedClaim: { shards: SHARDED_POOL, ...(await measureClaims(PUSH_DEPTH, PUSH, SHARDED_POOL)) },
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
