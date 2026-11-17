# 0005: How the push and pull costs are compared

Status: accepted, 2026-11-17

## Context

The bounty asks for a cost comparison with the current model, in which the sponsor's script pays every recipient in
one transaction per period (one dust output per recipient). Hand-written cost numbers go stale and cannot be checked,
so every number in `docs/COST.md` must come from a measurement that a script can repeat.

## Decision

1. **Live push data.** `scripts/push-measure.ts` finds the sponsor's distributions on mainnet: a public indexer
   narrows the search to transactions with a dust-valued P2PKH output of the reward category after output 0, then
   every candidate and every output it spends is read from Electrum and classified by
   `src/cost/distributions.ts` (output 0 = token-free change to the distributor, every other output = dust plus
   tokens to one P2PKH script, every input owned by the distributor). Results and the BCH price go to
   `reports/push-distributions.json` with the measurement time. Recipient addresses are not stored.
2. **Larger recipient counts are built, not extrapolated.** `src/cost/push.ts` builds and signs the same layout
   with a model key (never broadcast). A test checks that it reproduces the byte size of every live one-input
   distribution exactly, so the builder stands in for counts the sponsor has not reached. Distributions above the
   standard size limit (`cost.maxStandardTxBytes`) are split into the most recipients per transaction that fit.
3. **Pull sizes** come from `reports/claim-sizes.json`. The claim depths it measures include the tree depth of every
   recipient count in `cost.recipientCounts`, so no claim size is interpolated.
4. **What is counted.** Distributor per epoch: push = fee + dust of every recipient output; pull = propose fee +
   activate fee, independent of the recipient count. Recipient per claim: fee, plus receipt dust on the first claim
   (it stays in the pool); the payment output's dust is the claimant's own and is shown apart. The break-even claim
   interval counts the fee and one dust output on both sides, since each model hands the recipient one dust output.
5. `scripts/cost.ts` renders `docs/COST.md` offline from these inputs; a test fails when the committed file differs.

## Consequences

- Refreshing the live data needs the network (`npm run push-measure`); the offline gate only reads the report.
- The comparison uses the fee rate of the claim measurements (1 sat per byte), which is also what the live
  distributions paid.
- The model's token amount per output (`cost.pushTokenAmountPerRecipient`) sets the amount's encoded length; amounts
  of 2^32 base units or more all encode in 9 bytes, as every live distribution output does.
