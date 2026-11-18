# 0006: Chipnet demonstration tree and time-read sequence locks

Status: accepted, 2026-11-18

## Context

The bounty asks for a working chipnet demonstration. The sponsor's own distribution query for October 2026 returns a
single recipient, and that response names a real participant (it stays in the operator's local API cache, see
`docs/MEASURED.md`). A tree that shows proofs at realistic depth needs at least 300 leaves, with claimable leaves at
both ends and in the middle.

While running the demonstration, chipnet nodes refused an activation that was 12 blocks past a 3-block relative lock
with `non-BIP68-final`. Chipnet runs one-minute blocks at the time of measurement. A plain P2PKH spend with a
1-block sequence lock was refused 6 blocks after its coin was mined and accepted 9 blocks after. Block counts do not
explain either result; reading each "block" of the sequence value as 600 seconds of median time past does (see the
test `tests/sequence-time.test.ts`, which encodes the measured heights and times).

## Decision

1. **Demonstration leaves.** `tuai demo allocations --round 1` places the five project demo keys at the leaf indices
   in `config.demo.keyIndices` (0, 1, 150, 298, 299 of 300). Every other leaf pays a synthetic P2PKH script whose
   20-byte hash is drawn from a labelled SHA-256 counter inside the gap between its neighbouring demo keys, so the
   sorted tree puts the demo keys exactly at their indices (`src/demo/layout.ts`). Nobody holds a key for a synthetic
   leaf. No real participant's address is in the demonstration tree. Round 2 adds `config.demo.topUpWhole` to every
   demo key for top-up claims.
2. **The allocations are an input like any other.** The epoch file stores the allocations under its content hash and
   commits to it through the inputs hash, so `tuai epoch verify` recomputes the demonstration root from the
   repository alone.
3. **Refused attempts are part of the record.** `activate --force` sends an early activation so the network's
   refusal is logged. `tuai demo double-claim` builds a second first claim for an already claimed leaf (it reads the
   receipt list as if the leaf's own receipt were absent), checks it with the local VM and then sends it, recording
   both refusals. `tuai fund demo-N` moves BCH only between project keys, so a second key can pay for a claim.
4. **Sequence locks per network.** `networks.<name>.sequenceSecondsPerBlock` (600 for chipnet) makes `status` and
   `activate` wait for the median time past as well as for the block count; without it, the lock counts blocks. The
   contracts are unchanged: `this.age >= delay` is enforced by the node either way, and the operator tools only
   decide when an attempt is worth sending.
5. `scripts/chain-report.ts` writes `deployments/<network>/transactions.json` from the operator's run log and the
   generated table in `docs/MEASURED.md`, with block heights read from Electrum and each logged size checked against
   the network's.

## Consequences

- The chipnet activation delay of 3 is roughly 30 minutes of chain time while chipnet keeps one-minute blocks, the
  same wall-clock meaning it had with ten-minute blocks. A production delay should be set in the same terms.
- If chipnet or mainnet nodes change how they read sequence values, only the config value changes.
