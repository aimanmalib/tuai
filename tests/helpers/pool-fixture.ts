// Shared mock-network fixture for contract tests. Keys are derived from fixed test labels, never from real wallets.
import { MockNetworkProvider, SignatureTemplate, randomUtxo, type SpendableUtxo } from 'cashscript';
import { binToHex, lockingBytecodeToCashAddress, ripemd160, secp256k1 } from '@bitauth/libauth';
import { concat, sha256 } from '../../src/bytes.ts';
import { hashLeaf, type Leaf } from '../../src/leaf.ts';
import { buildTree, type MerkleTree } from '../../src/merkle/tree.ts';
import { computeRoot, getProof, type MerkleProof } from '../../src/merkle/proof.ts';
import type { PoolState } from '../../src/pool/encoding.ts';
import type { PoolContracts, PushParams } from '../../src/pool/contracts.ts';
import { readPending, readPool, shardsOf, type PoolUtxos } from '../../src/pool/utxos.ts';
import { buildDeploy } from '../../src/tx/deploy.ts';
import { buildPropose } from '../../src/tx/propose.ts';
import { buildActivate } from '../../src/tx/activate.ts';
import { assembleClaim, planClaim, type ClaimPlan } from '../../src/tx/claim.ts';

export const MAX_DEPTH = 24;
export const FEE_RATE = 1;
export const SATS = 1000n;
export const REWARD_SUPPLY = 1_000_000_000n;
export const DELAY = 3;
/** Operator push parameters of every test pool unless a test asks for a version 1 pool (ADR 0008). */
export const PUSH: PushParams = { delay: 5, minimum: '50', sats: 6000 };

const hash160 = (data: Uint8Array): Uint8Array => ripemd160.hash(sha256(data));

export interface TestKey {
  signer: SignatureTemplate;
  publicKey: string;
  lockingBytecode: Uint8Array;
  address: string;
}

export function testKey(label: string): TestKey {
  const privateKey = sha256(new TextEncoder().encode(`tuai test key ${label}`));
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const lockingBytecode = concat(Uint8Array.of(0x76, 0xa9, 0x14), hash160(publicKey), Uint8Array.of(0x88, 0xac));
  const address = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: 'bchtest', tokenSupport: true });
  if (typeof address === 'string') throw new Error(address);
  return { signer: new SignatureTemplate(privateKey), publicKey: binToHex(publicKey), lockingBytecode, address: address.address };
}

/** The three operators of every test pool, in gate key order. */
export const OPERATORS: readonly TestKey[] = ['a', 'b', 'c'].map((l) => testKey(`operator ${l}`));


export const newProvider = (): MockNetworkProvider => new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });

export interface PoolFixture {
  provider: MockNetworkProvider;
  contracts: PoolContracts;
  payer: TestKey;
  deployTxid: string;
}

/** A fixed txid for measurements that must not change between runs (signature lengths depend on what is signed). */
export const seededTxid = (seed: string): string => binToHex(sha256(new TextEncoder().encode(`tuai test txid ${seed}`)));

/**
 * Deploys a pool on the mock network with the given state already active; a seed makes the pool category fixed.
 * `push: null` deploys the version 1 contracts (no push path), as on the recorded chipnet pool.
 */
export async function deployPool(
  state: PoolState,
  provider = newProvider(),
  seed?: string,
  push: PushParams | null = PUSH,
  vaultSats = SATS,
  shards = 1,
): Promise<PoolFixture> {
  // vaultSats: BCH kept with the reward tokens; pushes draw their dust and fee from it.
  const payer = testKey('payer');
  const genesis = { ...randomUtxo({ satoshis: 100_000n }), vout: 0 };
  const genesisUtxo = provider.addUtxo(payer.address, seed ? { ...genesis, txid: seededTxid(`${seed} genesis`) } : genesis);
  const rewardCategory = binToHex(sha256(new TextEncoder().encode(`reward ${genesisUtxo.txid}`)));
  const reward = randomUtxo({ satoshis: SATS, token: { category: rewardCategory, amount: REWARD_SUPPLY } });
  const rewardUtxo = provider.addUtxo(payer.address, seed ? { ...reward, txid: seededTxid(`${seed} reward`), vout: 1 } : reward);
  const { builder, contracts } = buildDeploy({
    provider,
    signer: payer.signer,
    payerAddress: payer.address,
    genesisUtxo,
    rewardUtxos: [rewardUtxo],
    maxDepth: MAX_DEPTH,
    operatorKeys: OPERATORS.map((k) => k.publicKey),
    activationDelay: DELAY,
    ...(push ? { push } : {}),
    initialState: state,
    outputSats: SATS,
    vaultSats,
    shards,
    feeRate: FEE_RATE,
  });
  const sent = await builder.send();
  return { provider, contracts, payer, deployTxid: sent.txid };
}

export const stateFor = (root: Uint8Array, epoch = 1): PoolState => ({ root, epoch, inputsHash: sha256(root) });

/** Funding coins for a claimant, fresh for each claim. */
export function fund(f: PoolFixture, who: TestKey, satoshis = 50_000n, seed?: string): SpendableUtxo {
  const utxo = randomUtxo({ satoshis });
  return f.provider.addUtxo(who.address, seed ? { ...utxo, txid: seededTxid(seed), vout: 0 } : utxo);
}

export function claimPlan(f: PoolFixture, pool: PoolUtxos, leaf: Leaf, proof: MerkleProof, payer: TestKey): ClaimPlan {
  return planClaim({
    contracts: f.contracts,
    pool,
    leaf,
    proof,
    funding: { utxos: [fund(f, payer)], signer: payer.signer, changeAddress: payer.address },
    paymentSats: SATS,
    receiptSats: SATS,
    feeRate: FEE_RATE,
  });
}

export const sendPlan = (f: PoolFixture, plan: ClaimPlan, allowBurn = false) => assembleClaim(plan, f.provider, allowBurn).send();

export async function claim(f: PoolFixture, leaf: Leaf, proof: MerkleProof, payer: TestKey) {
  const plan = claimPlan(f, await readPool(f.contracts), leaf, proof, payer);
  const sent = await sendPlan(f, plan);
  return { plan, sent };
}

export function treeOf(leaves: Leaf[]): { tree: MerkleTree; proof: (i: number) => MerkleProof } {
  const tree = buildTree(leaves.map(hashLeaf), MAX_DEPTH);
  return { tree, proof: (i) => getProof(tree, i) };
}

/** A proof of the requested depth with deterministic siblings; returns the root it commits to. */
export function syntheticProof(leaf: Leaf, depth: number, index: number): { proof: MerkleProof; root: Uint8Array } {
  const siblings = Array.from({ length: depth }, (_, i) => sha256(Uint8Array.of(0xaa, i)));
  const proof = { index, siblings };
  const root = computeRoot(hashLeaf(leaf), proof, 64);
  if (!root) throw new Error('bad synthetic proof');
  return { proof, root };
}

/**
 * Moves the pool to the next state the way operators do: two operators propose it, then a third party activates it.
 * The mock network does not track block heights; tests/root-gate.test.ts checks the timelock separately.
 */
export async function advanceState(f: PoolFixture, state: PoolState): Promise<PoolUtxos> {
  const operators = [(OPERATORS[0] as TestKey).signer, (OPERATORS[2] as TestKey).signer];
  const funder = testKey('activator');
  await buildPropose({
    contracts: f.contracts,
    pending: await readPending(f.contracts),
    proposal: state,
    operators,
    funding: { utxos: [fund(f, funder)], signer: funder.signer, changeAddress: funder.address },
    feeRate: FEE_RATE,
  }).send();
  // A sharded pool takes one activation per state NFT (ADR 0013).
  for (;;) {
    const pool = await readPool(f.contracts);
    if (shardsOf(pool).every((s) => s.state.epoch >= state.epoch)) break;
    await buildActivate({
      contracts: f.contracts,
      pool,
      pending: await readPending(f.contracts),
      funding: { utxos: [fund(f, funder)], signer: funder.signer, changeAddress: funder.address },
      feeRate: FEE_RATE,
    }).send();
  }
  return readPool(f.contracts);
}
