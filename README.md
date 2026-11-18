# Tuai: pull-based reward claims for FoldingCash

Entry for **BCH BLAZE 2026**, bounty "Trust-minimized, pull-based reward claims for FoldingCash".

## What it is

FoldingCash pays `FLDCH` tokens to Folding@home contributors by sending one output per recipient every period. Tuai
replaces that push with a pull: two of three operators publish one Merkle root of cumulative rewards on Bitcoin Cash,
the root becomes claimable only after an audit window, and each contributor claims their own share with a proof that a
CashScript contract checks, paying the tokens only to the address in their leaf.

```mermaid
flowchart LR
  API["FoldingCash GetDistro<br/>(cached, hashed)"] --> B["tuai epoch build<br/>leaves, root, inputsHash"]
  B --> F["epoch-n.json<br/>(published)"]
  B --> P["propose<br/>2 of 3 operators"]
  P --> G["RootGate<br/>pending root"]
  G -- "after delay blocks,<br/>anyone" --> A["activate"]
  A --> S["ClaimPool<br/>active root"]
  F --> C["claim<br/>proof + receipt"]
  S --> C
  V["PoolVault<br/>reward tokens, receipts"] --> C
  C --> R["recipient's own address"]
  F --> W["tuai watch<br/>recompute, compare"]
```

## Design in one screen

- **Leaf:** `sha256(0x00 || method(1) || uint64le(cumulative) || lockingBytecode)`; inner node:
  `sha256(0x01 || left || right)`. The prefixes keep leaves and nodes in separate domains.
- **Root gate:** a new root needs 2 of 3 operator signatures and becomes claimable only after a relative block
  timelock. Anyone can activate it after the delay.
- **Claim pool:** pays `cumulative - alreadyClaimed` to the locking bytecode in the leaf, so whoever submits a claim
  cannot redirect the payment. Receipts stay inside the contract as a sorted linked list.
- **Inputs hash:** each root is committed on chain together with the hash of its input manifest, so anyone can
  recompute it from the published files.
- **Contracts:** [`ClaimPool.cash`](contracts/ClaimPool.cash) checks claims,
  [`PoolVault.cash`](contracts/PoolVault.cash) holds reward tokens and receipts,
  [`RootGate.cash`](contracts/RootGate.cash) holds the pending root and enforces 2 of 3 and the delay.

Full format and transaction reference: [`docs/SPEC.md`](docs/SPEC.md). Decisions and rejected alternatives:
[`docs/decisions/`](docs/decisions/).

## Bounty requirements

Chipnet transactions below are from the demonstration recorded in [`docs/MEASURED.md`](docs/MEASURED.md#chipnet)
(300 leaves, depth 9, two epochs). Explorer links are in that table.

| Requirement | Where | Tests | Chipnet evidence |
|---|---|---|---|
| Merkle root of (address, cumulative earned) published each epoch | [`src/epoch/`](src/epoch/), [`src/merkle/`](src/merkle/), [`RootGate.propose`](contracts/RootGate.cash) | `tests/merkle.test.ts`, `tests/cumulative.test.ts`, `tests/epoch-watch.test.ts` | epoch 1 proposed `72b5fbf76e2a5dfb14932ffe69db28e034cde7724cfac08cea7078217b7efa48`, epoch 2 proposed `9bbc758dd43b721a9526e251acd7eb19fc8c2fab8bd7f146acbcfddd94fb2c34` |
| Pool contract holds the tokens and verifies a proof on every claim; funds do not expire | [`ClaimPool.claim`](contracts/ClaimPool.cash), [`PoolVault`](contracts/PoolVault.cash), [`src/tx/claim.ts`](src/tx/claim.ts) | `tests/claim-pool.test.ts`, `tests/vault-topup.test.ts` | deploy `6356165de951e6a7e4765151250eec97d853a368da5d11106865307a9ef40cec`; first claims `bdb7b8f1e6e03691dc379c8c8fa5834425a75d2580df6a2d5f9a5eca071d6ca4` (leaf 0), `aded1114eb0c2cfb9ad61cc6258fd379bb16b23df1544c4fa65f78ffe5c1cd2f` (leaf 150), `e7b5780761a0c254d4db380051d2c616d31c3f560dee796955479a936c73038f` (leaf 299) |
| No double claims (receipt with the claimed amount) | receipt list in [`ClaimPool.claim`](contracts/ClaimPool.cash), ADR [0002](docs/decisions/0002-claim-pool-and-receipts.md) | `tests/claim-pool.test.ts` ("rejects a second claim of the same amount", "rejects a burned receipt") | second first claim for leaf 0 refused by the network (`mandatory-script-verify-flag-failed`), row 20 of the table; top-up claims paid only the difference: `3b891a54a58dab33e147e6cb723241d2b8385f161d7fc18a7ef12cd27fed3c36` |
| Timelock on root updates (audit window) | [`RootGate.activate`](contracts/RootGate.cash), ADR [0003](docs/decisions/0003-root-gate.md) | `tests/root-gate.test.ts`, `tests/sequence-time.test.ts` | seven early activations refused with `non-BIP68-final` (rows 6 to 13); accepted `5003786414a7babd59114603a497f9435c6b75989da9a8f183def325df7cd35a` and `d3217738961f951e97890fdf0782b5091a28bc38f247b820b80ab6af63bf93a3` |
| No claim threshold; the claimant pays dust and fee | [`src/tx/claim.ts`](src/tx/claim.ts), `payment > 0` in [`ClaimPool.claim`](contracts/ClaimPool.cash) | `tests/claim-pool.test.ts` | fees and dust came from each claim's own funding input (the project payer key or a demo key), not from the pool; leaf 0's top-up was funded by leaf 150's key and still paid leaf 0 |
| Reference transaction-building code, chipnet demo of several hundred leaves, cost comparison with push | [`src/tx/`](src/tx/), [`bin/tuai.ts`](bin/tuai.ts), [`docs/MEASURED.md`](docs/MEASURED.md), [`docs/COST.md`](docs/COST.md) | `tests/cli-e2e.test.ts`, `tests/cost.test.ts`, `tests/chipnet-record.test.ts` | all 24 attempts with full txids in [`docs/MEASURED.md`](docs/MEASURED.md#chipnet) |

Stretch items built: cumulative-only roots; inputs hash on chain and a watcher that recomputes roots and checks method 0
links against the Folding@home daily summary; 2-of-3 root authority; proof depth and VM limit analysis
([`docs/DEPTH.md`](docs/DEPTH.md)). Not built: the optional operator push path after a long timelock.

## Open questions answered

- **Epoch cadence.** Monthly, matching the sponsor's live distributions (one per month in
  [`docs/COST.md`](docs/COST.md)). The operator cost per epoch does not depend on the number of recipients, so a
  shorter cadence costs the operators only two more transactions per epoch; claimants are not affected because a
  claim collects every epoch since the last one.
- **Scale.** `tree.maxDepth` is 24 (16,777,216 leaves). Each level adds one 32-byte sibling to a claim; the binding
  VM limit is the 10,000-byte unlocking bytecode, reached at depth 292 by linear extrapolation
  ([`docs/DEPTH.md`](docs/DEPTH.md)). All claims spend the one state UTXO, so they are serialized (they can chain
  within a block).
- **Root authority.** 2 of 3 operator keys propose; the root becomes claimable after `delay` blocks (144 in
  production, about one day) and anyone can activate it. The delay is an audit window, not a veto.
- **Receipt layout.** `key(32) || next(32) || claimed(8 LE)` with `key = sha256(lockingBytecode)`, kept in the vault
  as a list sorted by key. A first claim spends its predecessor as proof that no receipt exists yet. Receipts never
  sit in the claimant's wallet, so burning one cannot reset a claim (ADR [0002](docs/decisions/0002-claim-pool-and-receipts.md)).
- **Leaf contents.** Link method (1 byte), cumulative amount (8 bytes), locking bytecode. The method byte records
  how the address was linked, so a watcher knows which leaves it can check.
- **Link verification.** Method 0 (address in the Folding@home name) is checked by `tuai watch --fah` against the
  public daily file. Method 1 (FoldingCash's own mapping) is flagged as not checkable; a BCH signed message from the
  linked address published with the epoch inputs would make it checkable. That is not built.

## Trust boundaries

- **Contracts enforce:** the payment amount and destination, one receipt per locking bytecode, 2 of 3 signatures for
  a new root, the delay before it pays, and that pool tokens leave only through claims. Nothing in the contracts
  lets anyone withdraw the pool, so unclaimed rewards stay claimable.
- **Operators decide:** the content of each root. Two operators can publish a wrong root; the inputs hash and the
  delay make it visible before it pays, but do not block it.
- **FoldingCash decides:** eligibility and amounts (the distribution API) and method 1 address links. The Folding@home
  daily files are taken as published.
- **Recipients and relayers:** anyone may submit a claim or an activation; neither can change where tokens go.

## Cost

From [`docs/COST.md`](docs/COST.md) (generated from measured sizes and live mainnet distributions; price and time of
measurement are in that file):

- **Operators:** 2,335 sat per epoch (propose 862 bytes, activate 1,473 bytes), whatever the number of recipients.
  Push at 1,000 recipients: 1,077,187 sat per epoch in fees and dust.
- **Recipients:** a first claim at depth 9 was 1,899 bytes on chipnet, paid by the claimant together with 1,000 sat
  of receipt dust; a later top-up claim was 1,748 bytes. From 100 recipients up, a recipient who claims once every 3
  epochs or less often costs no more in fees and dust than the pushes it replaces.
- Push is cheaper for very small recipient lists, which is what the sponsor runs today (1 to 3 recipients per month).

## Run it

Requires Node 22.

```sh
npm ci
npm test            # every unit, contract and CLI test (offline, mock network)
npm run demo:mock   # the full CLI flow on the mock network: deploy, propose, activate, claims, epoch 2, watch
npx tsx bin/tuai.ts epoch verify deployments/chipnet/epoch-2.json   # rebuild the chipnet root from committed inputs
```

Other scripts: `npm run vectors` (test vectors), `npm run contracts` (compile `contracts/*.cash`),
`npm run claim-sizes` (sizes and `docs/DEPTH.md`), `npm run cost` (`docs/COST.md`), `bash scripts/gerbang-ujian.sh`
(lint, typecheck, contract compile check, tests).

### Claim page

`npm run web:dev` serves the claim page from `web/`; `npm run web:build` writes it to `dist/` together with the
committed epoch files under `/epochs/<network>/`. Enter an address (q or z, with or without the prefix): the page
finds the leaf, recomputes the root in the browser, compares it with the root the pool holds on chain (read over an
Electrum WebSocket), shows the claimed and claimable amounts from the vault receipt, and gives the claim command. A
root that differs from the published file is shown as a named warning. English and Malay. `npm run e2e` runs the
browser tests on WebKit (iPhone 13) and Chromium. See [ADR 0007](docs/decisions/0007-claim-page.md).

### Command line

`npx tsx bin/tuai.ts <command> [--network chipnet|mainnet|mock] [--json]` (see
[ADR 0004](docs/decisions/0004-epoch-files-and-cli.md)). Keys are read from `state/keys/` and never printed. Exit
codes: 0 done, 1 failed or a difference found, 2 usage, 3 not yet possible (timelock, API interval).

```sh
tuai epoch build --source api --start 2026-10-01T00:00:00Z --end 2026-11-01T00:00:00Z --amount 1000
tuai epoch build --source fixture --file allocations.json [--previous deployments/chipnet/epoch-1.json]
tuai epoch verify <epoch file>          # rebuild a root from its inputs
tuai watch --epoch <file> [--fah daily_user_summary.txt]   # recompute, check links, compare with chain
tuai token genesis --amount <units>     # test reward token held by the payer key
tuai deploy                             # pool, vault, receipt list head and root gate in one transaction
tuai propose --epoch <file> [--operators 1,3]   # two of three operators
tuai activate                           # anyone, once the pending root is old enough
tuai claim <address> --epoch <file> [--payer <key>]   # pays the leaf's own address
tuai status                             # payer balance, active and pending roots, blocks left
tuai budget                             # mainnet spending against the configured limit
tuai fund demo-5 [--sats N]             # BCH between project keys only
tuai demo allocations --round 1|2 --out <file>   # demonstration tree (ADR 0006)
tuai demo double-claim <address> --epoch <file>  # records the refusal of a second claim
```

## Integrating with FoldingCash

[`docs/INTEGRATION.md`](docs/INTEGRATION.md): the distribution API becomes the input of each epoch, the release
contract's fund key sends each period's tokens to the pool vault, and the per-epoch operator steps.

## Configuration

Every value that can change (networks, Electrum servers, timelock lengths, tree depth, operator keys, fee and dust
values, sponsor API settings, mainnet spending limit) lives in [`config/tuai.json`](config/tuai.json). CLI text lives
in [`lang/en.json`](lang/en.json) and [`lang/ms.json`](lang/ms.json).

## Known limits

- Claims are larger than a push output: about 1.9 kB for a first claim at depth 9. The contract was kept readable
  rather than hand-optimized; 20-byte receipt keys and a hand-written script are recorded options in ADR 0002.
- All claims go through one state UTXO, so two claims in the same moment conflict and one must be rebuilt.
- Operator keys are fixed in the gate. Rotating them means a new deployment.
- The CLI signs a proposal with two operator key files on one machine.
- Method 1 address links cannot be checked from public data.
- The sponsor's October 2026 distribution had one recipient, so the chipnet tree uses five project demo keys and
  295 synthetic leaves nobody holds a key for (ADR [0006](docs/decisions/0006-chipnet-demonstration.md)). No real
  participant's address is in the demonstration.
- Chipnet nodes read a block-count sequence lock as ten one-minute blocks per unit at the time of the demonstration,
  so the demo delay of 3 took 30 blocks (ADR 0006).
- The demonstration runs on chipnet only. The claim page shows the CLI command; it does not sign claims with a wallet.

## AI disclosure

The code and documents in this repository were written by an AI coding agent working under the direction of the
repository owner. The owner chose the problem, set the requirements and constraints, and reviews the results.
On-chain measurements in `docs/MEASURED.md` come from transactions the tools in this repository broadcast.

## License

MIT, see [LICENSE](LICENSE).
