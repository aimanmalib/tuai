// Shared mock-network fixture for contract tests. Keys are derived from fixed test labels, never from real wallets.
import { MockNetworkProvider, SignatureTemplate, randomUtxo, type SpendableUtxo } from 'cashscript';
import { binToHex, lockingBytecodeToCashAddress, ripemd160, secp256k1 } from '@bitauth/libauth';
import { concat, sha256 } from '../../src/bytes.ts';
import { hashLeaf, type Leaf } from '../../src/leaf.ts';
import { buildTree, type MerkleTree } from '../../src/merkle/tree.ts';
import { computeRoot, getProof, type MerkleProof } from '../../src/merkle/proof.ts';
import { encodeState, type PoolState } from '../../src/pool/encoding.ts';
import type { PoolContracts } from '../../src/pool/contracts.ts';
import { readPool, type PoolUtxos } from '../../src/pool/utxos.ts';
import { buildDeploy } from '../../src/tx/deploy.ts';
import { assembleClaim, planClaim, type ClaimPlan } from '../../src/tx/claim.ts';

export const MAX_DEPTH = 24;
export const FEE_RATE = 1;
export const SATS = 1000n;
export const REWARD_SUPPLY = 1_000_000_000n;

export interface TestKey {
  signer: SignatureTemplate;
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
  return { signer: new SignatureTemplate(privateKey), lockingBytecode, address: address.address };
}

const hash160 = (data: Uint8Array): Uint8Array => ripemd160.hash(sha256(data));

export const newProvider = (): MockNetworkProvider => new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });

export interface PoolFixture {
  provider: MockNetworkProvider;
  contracts: PoolContracts;
  payer: TestKey;
  deployTxid: string;
}

/** Deploys a pool on the mock network with the given state already active. */
export async function deployPool(state: PoolState, provider = newProvider()): Promise<PoolFixture> {
  const payer = testKey('payer');
  const genesisUtxo = provider.addUtxo(payer.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 });
  const rewardCategory = binToHex(sha256(new TextEncoder().encode(`reward ${genesisUtxo.txid}`)));
  const rewardUtxo = provider.addUtxo(payer.address, randomUtxo({ satoshis: SATS, token: { category: rewardCategory, amount: REWARD_SUPPLY } }));
  const { builder, contracts } = buildDeploy({
    provider,
    signer: payer.signer,
    payerAddress: payer.address,
    genesisUtxo,
    rewardUtxos: [rewardUtxo],
    maxDepth: MAX_DEPTH,
    initialState: state,
    outputSats: SATS,
    feeRate: FEE_RATE,
  });
  const sent = await builder.send();
  return { provider, contracts, payer, deployTxid: sent.txid };
}

export const stateFor = (root: Uint8Array, epoch = 1): PoolState => ({ root, epoch, inputsHash: sha256(root) });

/** Funding coins for a claimant, fresh for each claim. */
export function fund(f: PoolFixture, who: TestKey, satoshis = 50_000n): SpendableUtxo {
  return f.provider.addUtxo(who.address, randomUtxo({ satoshis }));
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
 * Stands in for root activation, which arrives with the root gate contract: the old state NFT is spent away
 * and a new one with the next state is placed at the pool address.
 */
export async function replaceState(f: PoolFixture, state: PoolState): Promise<PoolUtxos> {
  const current = await readPool(f.contracts);
  const replacement = f.provider.addUtxo(f.contracts.pool.tokenAddress, {
    ...randomUtxo({ satoshis: current.state.satoshis }),
    token: { category: f.contracts.params.poolCategory, amount: 0n, nft: { capability: 'minting', commitment: binToHex(encodeState(state)) } },
  });
  return { ...current, state: replacement, decodedState: state };
}
