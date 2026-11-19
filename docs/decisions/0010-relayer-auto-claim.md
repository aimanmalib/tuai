# 0010: Relayer auto-claim by a threshold the leaf holder chose

Status: accepted, 2026-11-19

## Context

The bounty lists, as optional, a relayer that claims for a user once their balance crosses a threshold the user
chose. The chipnet demo relayer (ADR 0009) already plans, checks and sends claims that pay the leaf only, but it
claims only when someone presses the button on the page. Claims are cumulative (ADR 0002): waiting until the
claimable amount is large saves the per-claim fee and dust that a claim after every epoch would spend.

## Decision

1. **Same relayer, one more entry point.** `tuai relay --network chipnet --optins <file>` builds the relayer from
   the same `createRelay` the container uses and calls `autoClaim`, which runs each opted-in leaf through the same
   path as the button: pool and receipt read from Electrum, the epoch file holding the active root, the output guard,
   the fee cap, the hourly limit, the minimum balance and the kill switch. There is no second claim builder.
2. **Opt-ins are data.** The file is `{ "network": "chipnet", "optIns": [ { "address", "minAmount" } ] }`, with
   `minAmount` in reward token units as a decimal string. It is read strictly: wrong network, a missing or
   non-positive amount, or an address listed twice refuses the whole file. An address outside the active epoch is
   answered `notInEpoch`; no opt-in means no claim. `examples/relay-optins.json` is the file used on chipnet.
3. **Threshold rule.** A leaf is claimed when `cumulative - claimed >= minAmount`; below it the answer is
   `belowThreshold` with both numbers and nothing is sent. `--dry-run` answers `wouldClaim` instead of sending.
4. **Where the reward goes is not the relayer's choice.** The contract requires `outputs[2]` to pay the leaf's own
   locking bytecode. `tests/relay-auto.test.ts` moves that payment to the relayer after the guard and shows the
   contract refusing it in the VM, as well as the guard refusing it before broadcast (`tests/relay.test.ts`).
5. **One pass per run, no daemon.** An operator or a scheduler runs the command; each run is independent and safe
   to repeat, because a leaf with nothing left answers `nothingToClaim`. Each claim sent is checked on chain with
   `scripts/page-claims.ts --kind auto` and recorded in `deployments/<run>/auto-claims.json`, which the activity
   page lists as `claim-auto`.

## Consequences

- Who opted in is a file the relayer operator holds. A leaf holder asks the operator to add them; on mainnet this
  would be a signed request, which is not built (the same link-signing question as compatibility leaves).
- The relayer remains chipnet only; this command inherits `assertRelayNetwork` and refuses every other network.
- To undo: drop the `relay` command from `src/cli/main.ts` and `autoClaim` from `src/relay/service.ts`; the button
  path is unchanged.
