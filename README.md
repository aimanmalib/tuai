# Tuai: pull-based reward claims for FoldingCash

Entry for **BCH BLAZE 2026**, bounty "Trust-minimized, pull-based reward claims for FoldingCash".

Status: work in progress. This README is filled in as each part is built and measured.

## What it is

FoldingCash pays FLDCH tokens to Folding@home contributors by sending one output per recipient every period.
Tuai replaces that push with a pull: the operator publishes one Merkle root of cumulative rewards on Bitcoin Cash,
the root becomes active only after an audit window, and each contributor claims their own share with a proof
that a CashScript contract checks. The operator's cost per period no longer grows with the number of recipients.

## Design in one screen

- **Leaf:** `sha256(0x00 || method(1) || uint64le(cumulative) || lockingBytecode)`; inner node:
  `sha256(0x01 || left || right)`. The prefixes keep leaves and nodes in separate domains.
- **Root gate:** a new root needs 2 of 3 operator signatures and becomes claimable only after a relative
  block timelock (`activationDelayBlocks` in `config/tuai.json`). Anyone can activate it after the delay.
- **Claim pool:** pays `cumulative - alreadyClaimed` to the locking bytecode in the leaf, so whoever submits
  a claim cannot redirect the payment. Claim receipts stay inside the contract as a sorted linked list.
- **Contracts:** [`contracts/ClaimPool.cash`](contracts/ClaimPool.cash) checks claims;
  [`contracts/PoolVault.cash`](contracts/PoolVault.cash) holds reward tokens and receipts;
  [`contracts/RootGate.cash`](contracts/RootGate.cash) holds the pending root and enforces 2 of 3 and the delay.
  Layout and reasons: [ADR 0002](docs/decisions/0002-claim-pool-and-receipts.md),
  [ADR 0003](docs/decisions/0003-root-gate.md). Measured sizes and VM limits by proof depth:
  [`docs/DEPTH.md`](docs/DEPTH.md), generated from [`reports/claim-sizes.json`](reports/claim-sizes.json).
- **Inputs hash:** the root is published together with a hash of the input manifest so anyone can recompute it.

Decisions are recorded in [`docs/decisions/`](docs/decisions/). Test vectors for the leaf and tree format
(1 to 300 leaves, with preimages and proofs) are in [`examples/vectors.json`](examples/vectors.json).

## Run it

Requires Node 22.

```sh
npm ci
npm test                       # unit and contract tests (offline)
npm run vectors                # regenerate examples/vectors.json
npm run contracts              # compile contracts/*.cash into src/contracts/artifacts
npm run claim-sizes            # regenerate reports/claim-sizes.json and docs/DEPTH.md (mock network)
bash scripts/gerbang-ujian.sh  # full offline gate: lint, typecheck, contract compile check, tests
```

## Command line

`npx tsx bin/tuai.ts <command> [--network chipnet|mainnet|mock] [--json]` (see
[ADR 0004](docs/decisions/0004-epoch-files-and-cli.md)). Keys are read from `state/keys/` and never printed.

```sh
tuai epoch build --source api --start 2026-10-01T00:00:00Z --end 2026-11-01T00:00:00Z --amount 1000
tuai epoch build --source fixture --file allocations.json [--previous deployments/chipnet/epoch-1.json]
tuai epoch verify deployments/fixtures/sponsor-2026-10/epoch-1.json   # rebuild a root from its inputs
tuai watch --epoch <file> [--fah daily_user_summary.txt]               # recompute, check links, compare with chain
tuai token genesis --amount <units>     # test reward token held by the payer key
tuai deploy                             # pool, vault, receipt list head and root gate in one transaction
tuai propose --epoch <file> [--operators 1,3]   # two of three operators
tuai activate                           # anyone, once the pending root is old enough (exit 3 before that)
tuai claim <address> --epoch <file> [--payer <key>]   # pays the leaf's own address
tuai status                             # payer balance, active and pending roots, blocks left
tuai budget                             # mainnet spending against the configured limit
```

Measured results (sponsor API data, chipnet transactions) are in [`docs/MEASURED.md`](docs/MEASURED.md).

## Configuration

Every value that can change (networks, Electrum servers, timelock lengths, tree depth, operator keys, fee and dust
values, sponsor API settings, mainnet spending limit) lives in [`config/tuai.json`](config/tuai.json).
CLI text lives in [`lang/en.json`](lang/en.json) and [`lang/ms.json`](lang/ms.json).

## AI disclosure

The code and documents in this repository were written by an AI coding agent working under the direction of the
repository owner. The owner chose the problem, set the requirements and constraints, and reviews the results.
On-chain measurements in `docs/MEASURED.md` come from transactions the tools in this repository broadcast.

## License

MIT, see [LICENSE](LICENSE).
