# 0001: CashScript stack and Merkle tree format

Status: accepted, 2026-11-17

## Context

FoldingCash already releases FLDCH from a CashScript vault contract and distributes it with a JavaScript script
that calls the public `/v1/GetDistro` endpoint and pushes one output per recipient. A pull-based design should be
easy for that team to adopt, cheap for each claimant, and verifiable by anyone.

## Decision

1. **Contracts in CashScript, tools in TypeScript.** `cashc` and `cashscript` 0.14.0, pinned exactly. The sponsor's
   existing contracts and scripts use the same toolchain, so no new compiler or language is introduced.
   Hand-written covenants keep the claim transaction small, which is the cost every claimant pays.
   `@bitauth/libauth` 3.0.0 is used directly for CashAddr, hashing and keys (cashscript 0.14.0 carries its own
   prerelease copy as a dependency; the two are not mixed in one object).
2. **Leaf:** `sha256(0x00 || method || uint64le(cumulative) || lockingBytecode)`.
   - `method` (1 byte) records how the address was linked to the Folding@home identity: `0` = address embedded in
     the Folding@home user name (verifiable from public stats files), `1` = address mapping kept by FoldingCash.
   - `cumulative` is the total ever earned, not the amount for one period, so a new root never needs to know what
     was claimed and a missed period is never lost.
   - `lockingBytecode` is where the claim pays. The contract pays only there, so a third party may submit and fund
     a claim but cannot redirect it.
3. **Inner node:** `sha256(0x01 || left || right)`. The direction at each level comes from the bit of the leaf
   index. An odd level is padded with 32 zero bytes. Distinct prefixes stop a node from being presented as a leaf.
4. **Depth limit:** `tree.maxDepth` in `config/tuai.json` (default 24, about 16.7 million leaves). The contract
   rejects deeper proofs; the measured cost per level is reported in `docs/DEPTH.md`.
5. **Every value that can change** (networks, Electrum servers, delays, depth, operator keys, fees, API limits,
   mainnet spending limit) is read from `config/tuai.json`; contract constants are constructor parameters filled
   from that file at deploy time.

## Consequences

- Claims are proportional to `log2(N)` hashes, independent of how many others claim.
- Changing the leaf format is a new contract deployment and a new tree; old roots stay verifiable with the old
  format. Rollback for a deployed contract is a new deployment, recorded in `docs/MEASURED.md`.
