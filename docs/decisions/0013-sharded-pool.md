# 0013. Sharded claim pool

Status: accepted, 19 Nov 2026

## Context

Every claim spends the pool's state NFT (input 0) and a reward token UTXO (input 1) and recreates them. With one of
each, claims are serialized: two claimants who build a claim from the same view of the chain spend the same
outpoints, and only one of the two transactions can confirm. They can chain within a block, but only when each
claimant sees the previous claim first. The bounty asks how the design scales.

## Decision

A pool can be deployed with K state NFT and reward token pairs ("shards"); `pool.shards` in `config/tuai.json`
sets K for new pools and `tuai deploy --shards K` overrides it. No contract changes:

- `ClaimPool.claim` already accepts any state NFT of the pool category at input 0 and any vault reward UTXO at
  input 1. The deploy transaction is the only place that creates minting NFTs of the pool category, and the claim,
  activate and push paths can only recreate the one they spend, so the number of shards is fixed at deploy.
- The deploy transaction keeps its version 1 layout for the first shard (state NFT, receipt list head, reward
  tokens, pending NFT) and appends one state NFT and one reward output per extra shard. Reward tokens are split
  evenly; the first shard takes the remainder (`splitAmount`).
- The claim builder (`pickShard` in `src/pool/shards.ts`) chooses the state NFT and reward UTXO from the first four
  bytes of the claimant's receipt key, modulo the number of candidates, ordered by outpoint. Different claimants
  start on different shards, so K claims built from one snapshot of the pool can confirm in the same block. Only
  shards that hold the newest epoch are candidates; reward UTXOs are tried in a ring from the same slot until one
  holds more than the payment.
- Receipts are not sharded. Two first claims whose keys share a predecessor in the sorted receipt list still
  conflict; with keys spread by sha256 over a growing list, that becomes rarer as the list grows. Additional
  claims spend only their own receipt.

Activation: `RootGate.activate` moves the pending root into one state NFT and recreates the pending NFT, which
restarts its relative timelock. A pool with K shards therefore needs K activations per epoch, each `delay` blocks
after the previous one (`tuai activate` reports `shardsLeft`; the planner takes the oldest shard first). While
some shards are behind, claims use the shards on the new root; the others still hold the previous root, which can
only pay what that root already allowed, because cumulative amounts never go down.

## Consequences

- Claim size is unchanged: `reports/claim-sizes.json` measures the same claims on a sharded pool
  (`shardedClaim`) and `docs/DEPTH.md` shows both. `tests/pool-shards.test.ts` checks that two claims from one
  snapshot spend disjoint outpoints and both confirm, and that with one shard the second conflicts.
- Each extra shard costs two dust outputs at deploy, one more activation per epoch, and a longer wait for the
  last shard (K times the delay). Pools already deployed (the recorded chipnet pools) have one shard and keep
  working as before; readers accept one or more state NFTs.
- The claim page and the watcher read the newest epoch among the shards as the active root.

## Alternatives

- Activate every shard in one transaction: needs a new `RootGate` and `ClaimPool` (the pool's activate function
  pins the pending NFT to input 1), which would change the deployed contracts and every recorded size. Left as a
  follow-up if the activation wait matters in production.
- Shard the receipt list by key prefix (one head per shard): removes the remaining first-claim conflicts but
  changes the receipt rules in the contract.
