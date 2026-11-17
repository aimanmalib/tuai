# 0004: Epoch files, the inputs hash, and the operator CLI

Status: accepted, 2026-11-17

## Context

A root on chain is only auditable if anyone can rebuild it. The bounty asks for an input snapshot hash, a watcher
that recomputes roots, and tooling an operator can run each epoch. The sponsor already splits rewards with
`GET /v1/GetDistro` (start date, end date, amount, `includeFoldingUserTypes=8`) and pays one output per recipient.

## Decision

1. **Epoch file** (`deployments/<network>/epoch-<n>.json`, format `tuai-epoch/1`): the root, the inputs hash, the
   manifest, every carried balance (`recipients`: locking bytecode, link method, cumulative, high-water mark) and
   every leaf with its address and proof. A claimant needs only this file and the chain.
2. **Manifest** (`tuai-manifest/1`): epoch number, maximum depth, default link method, token decimals, the previous
   epoch (file, number, root) and each input (relative file name, SHA-256 of its exact bytes, kind, and for API
   inputs the query). Inputs are stored next to the epoch file under `inputs/<sha256>.json`.
3. **Inputs hash** = SHA-256 of the manifest as canonical JSON (keys sorted at every level). It is the
   `inputsHash` committed in the pending and state NFTs, so the chain commits to the inputs, not only to the root.
   The previous root inside the manifest chains epochs together.
4. **Cumulative amounts.** Each input adds allocations to the previous balances (`addAllocations`). Amounts from the
   distribution endpoint are converted to base units the way the sponsor's script does (`round(amount * 10^8)`). A
   recipient keeps one link method for life; a change is refused (issue a new leaf instead).
5. **Link method for API leaves** comes from `sponsorApi.linkMethod` (default 0: address in the Folding@home name).
   The watcher checks method 0 leaves against the public daily user summary; method 1 leaves (FoldingCash's own
   mapping) are counted and reported as not checkable from public data.
6. **Sponsor API use.** One request per query, ever: the exact response bytes are cached under `state/api/` and
   reused. A new request less than `minIntervalSeconds` (at least 60) after the last one is refused with a retry
   time; the CLI never sleeps. Requests time out after `timeoutSeconds`.
7. **CLI** (`bin/tuai.ts`): `epoch build|verify`, `watch`, `token genesis`, `deploy`, `propose`, `activate`,
   `claim`, `status`, `budget`; `--network chipnet|mainnet|mock`, `--json`. Exit codes: 0 done, 1 failed or a check
   found a difference, 2 usage, 3 not yet possible (timelock not reached, API interval), so scripts can retry later.
   `activate` reads the pending root's confirmation height from Electrum and refuses before the delay unless
   `--force` is given (used once to record the network's own refusal).
8. **Every broadcast goes through one function** that evaluates the transaction locally, measures size and fee,
   and appends a record (including refusals) to `state/runs/<network>.json`. On mainnet it first checks the ledger
   `state/belanja.json` against `budget.mainnetMaxSats` and refuses a spend that would pass it; spent means value
   leaving project keys (fees plus value locked in outputs the project does not own).
9. **Keys** are read from `state/keys/<role>.json` (not tracked). Operator public keys come from config when set,
   otherwise from the three operator key files. Private keys are never printed.

## Consequences

- `epoch verify` and `watch` need no network and no keys; anyone with a clone can rebuild every root.
- The mock network keeps nothing between processes, so `--network mock` is for tests that drive the CLI in-process.
- Rolling back: the epoch format is versioned; a new format gets a new `format` string and both can be verified.
