# Integrating with FoldingCash

How the pieces FoldingCash runs today map onto Tuai, and what an operator does each epoch. Formats are in
[`SPEC.md`](SPEC.md).

## What FoldingCash runs today

- **Eligibility and amounts:** `GET https://api.folding.cash/v1/GetDistro?startDate&endDate&amount&includeFoldingUserTypes`
  returns, for a period and a token amount, each recipient's address and share. The current distribution script
  queries it with `includeFoldingUserTypes=8` and sends one transaction per period with one output per recipient
  (every such transaction found on mainnet is listed in [`COST.md`](COST.md)).
- **Token supply:** a release contract (`TokenVault_Release` in the sponsor's `smart-contracts` repository) releases
  FLDCH over time to a `fund` key.

## What changes

| Today | With Tuai |
|---|---|
| The fund key pays every recipient each period | The fund key sends the period's tokens to the pool vault once |
| One output and 1,000 sat of dust per recipient per period | Two operator transactions per period, whatever the number of recipients |
| A recipient receives tokens whether or not they use them | A recipient claims when they choose, collecting every period since their last claim |
| Amounts are visible only after payment | The root and the hash of its inputs are on chain for the audit window before anyone can claim |

The release contract and the distribution API do not change.

## One-time setup

1. Choose three operator keys held by three people, and set `operators.publicKeys` in `config/tuai.json`.
2. Set `production.activationDelayBlocks` (144, about one day, by default) and the network's `rewardCategory`.
3. From the key that holds the first batch of reward tokens: `tuai deploy --network mainnet`. This creates the state
   NFT, the receipt list head, the reward vault and the pending-root NFT in one transaction, and writes
   `deployments/mainnet/pool.json` with the contract addresses.

## Each epoch

```sh
# 1. Fund: send this period's released tokens to the vault's token address (from pool.json).
#    Any reward-token UTXO at the vault can pay claims (tests/vault-topup.test.ts).

# 2. Build the epoch from the sponsor's own query; the response is cached and hashed into the manifest.
tuai epoch build --source api --start 2026-11-01T00:00:00Z --end 2026-12-01T00:00:00Z --amount <tokens> \
  --previous deployments/mainnet/epoch-<n-1>.json --network mainnet

# 3. Anyone can check it before it is proposed.
tuai epoch verify deployments/mainnet/epoch-<n>.json

# 4. Two of the three operators propose it. The CLI signs with both named operator key files on one machine;
#    splitting the signing across the operators' own machines is not built.
tuai propose --epoch deployments/mainnet/epoch-<n>.json --operators 1,2 --network mainnet

# 5. Publish the epoch file (repository, static site or the API) so recipients and watchers can read it.

# 6. After the delay, anyone activates it. Before that the command exits 3 and prints the blocks left.
tuai activate --network mainnet
```

Recipients then claim with `tuai claim <address> --epoch <file>`, or through any wallet or relayer that builds the
transaction in [`SPEC.md`](SPEC.md) section 5.4.
A relayer can pay for someone else's claim; the contract still sends the tokens to the leaf's own address.

## Watching

`tuai watch --epoch <file> [--fah daily_user_summary.txt] --network <net>` recomputes the root from the stored inputs,
compares it with the pending and active roots on chain, and checks method 0 leaves against the public Folding@home
daily user summary. Method 1 leaves (FoldingCash's own address mapping) are listed as not checkable from public data.
It needs no keys.

## Trust that stays with FoldingCash

- The distribution API decides who is eligible and how much they get. Tuai commits to its exact response (the
  inputs hash), so a later change to the API's answer is visible, but it cannot tell whether the answer was right.
- The Folding@home daily files are taken as published.
- Address links made by FoldingCash's mapping (method 1) are taken as given. A way to make them checkable is for the
  linked address to sign the Folding@home name with a BCH signed message and publish that next to the epoch inputs;
  this is not built.

## Moving an existing distribution

Recipients who were already paid by push need no leaf for past periods: start the cumulative amounts at zero in the
first epoch and include only periods after the switch. To credit past periods, add them as an `allocations` input to
the first epoch; it is hashed into the manifest like any other input.
