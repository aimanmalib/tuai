# 0008: Operator push path behind a delay and a minimum

Status: accepted, 2026-11-18

## Context

The bounty lists an optional operator push path that opens only after a long timelock and only above a minimum
amount. Claims (ADR 0002) are already open to anyone: any wallet may fund a claim, and the payment still goes to the
leaf's locking bytecode. What a claim cannot do is pay for itself. A push path is useful when the operator wants
balances delivered to recipients who never claim, without anyone sending a wallet input per recipient, and without
spending the operator's BCH on small balances or before recipients had time to pull.

Two constraints shape the design:

- Every UTXO that a transaction reads is spent and recreated, so a relative timelock measures the age of the last
  transaction that touched that UTXO. The state NFT is recreated by every claim, so its age cannot measure how long
  a root has been active.
- The recorded chipnet pool (ADR 0006) was deployed with the version 1 contracts. Its addresses and transactions
  must stay verifiable.

## Decision

1. **Clock: the pending-root NFT.** Activation recreates the pending-root NFT with the active commitment, and
   claims never touch it. Its age is therefore the number of blocks since activation, until operators propose again.
   A new function `RootGate.arm()` (same layout as `activate`, input 1, no key) requires `this.age >= pushDelay` and a
   pending commitment equal to the active state, and rewrites the pending commitment as `state || 0x01`. That flag
   lasts until the next proposal, which writes a 68-byte commitment and closes pushes until the next root has stood
   `pushDelay` blocks. An armed NFT cannot be activated: its epoch equals the active epoch.
2. **Push = claim with the armed NFT at input 3.** `ClaimPool.claim` checks whether input 3 holds the pool category's
   mutable NFT. If it does, the transaction is a push and the script also requires: the commitment
   `state || 0x01`, `payment >= pushMinimum`, exactly four inputs, the pending-root NFT as the only output after the
   receipts, and `outputs[1].value + pushSats >= inputs[1].value`. Everything else (proof, receipt list, payment
   to the leaf's locking bytecode) is the claim code, so a push and a claim share one receipt and can never pay the
   same amount twice. `RootGate.push()` runs at input 3 and puts the NFT back, unchanged, as the last output.
3. **Who pays.** The vault's reward UTXO carries BCH that the operator puts there (at deploy, `vaultSats`, or by
   sending a reward-token UTXO with BCH to the vault address). A push takes at most `pushSats` of it for the payment
   dust, a new receipt's dust and the fee; nobody adds an input. Anyone may submit a push once pushes are armed, but
   cannot redirect tokens or take more BCH than `pushSats` minus what the outputs need.
4. **One contract, not a separate push contract.** A separate contract would need its own way to spend the state NFT
   and the vault, which means a new `ClaimPool` function and a second copy of the proof and receipt code. The flag
   check adds less to the claim script than that copy. The plan's rule was: more than 200 extra bytes on a claim
   means a separate contract. Measured (`docs/DEPTH.md`, "Operator push path"): a first claim at depth 9 grew from
   1,891 to 1,938 bytes (+47); ClaimPool grew from 563 to 610 bytes.
5. **Versioned artifacts.** `src/contracts/artifacts/v1/` keeps the compiled version 1 contracts. A pool record
   without a `push` field (the chipnet record) uses them; `tuai deploy` writes `push` from `config/tuai.json` and uses
   the current contracts. `tests/operator-push.test.ts` also claims on a version 1 pool.
6. **Values** come from `config/tuai.json`: `networks.*.pushDelayBlocks` (3 on chipnet and mock, 6 on mainnet),
   `production.pushDelayBlocks` 4,320 (about 30 days), `push.minimumUnits` and `push.maxSatsPerPush`.

## Testing

`tests/operator-push.test.ts` on the mock network: arm before `pushDelay` (RootGate), arm while a newer root is
pending, arm changing the state, push before arming, push below the minimum, payment redirected, more BCH than
`pushSats`, an extra input, a change output, the NFT moved out of the gate, a second push of the same balance, push
then claim (the claim pays only the increase), claim then push (the push pays only the remainder), a proposal
closing the window, an ordinary claim while armed, and a version 1 pool. Each rejection names the contract and the
`require` that failed. Removing the age check or the minimum check turns the matching test red.

## Consequences and known limits

- `pushDelay` must be shorter than the time between activation and the next proposal, or the window never opens.
  With monthly epochs, operators push before they propose the next root.
- The 300-leaf chipnet demonstration in `docs/MEASURED.md` ran the version 1 contracts, without the push path. A
  second, smaller chipnet pool (`tuai --run push`, `deployments/chipnet-push/`) runs these contracts and records an
  early arm and a push below the minimum refused by the network, an arm, a push and a pull claim (`docs/MEASURED.md`,
  Chipnet operator push).
- Pushes are serialized through the state NFT like claims.
- RootGate grew from 337 to 501 bytes, and propose and activate carry it, so the fixed operator cost per epoch rose
  (`docs/COST.md`). The point where push costs the distributor more than pull moved from 2 to 3 recipients per epoch.
- A push sends tokens to a recipient who did not ask for them. The minimum keeps those outputs above a size the
  operator chooses; the delay gives recipients time to claim first.
