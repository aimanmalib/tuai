# Measured

Facts measured on live systems, with times in UTC. Failures are recorded too.

## Sponsor distribution API

| When (UTC) | Query | Result |
|---|---|---|
| 2026-11-17 15:15:32 | `GET https://api.folding.cash/v1/GetDistro?startDate=2026-10-01T00:00:00Z&endDate=2026-11-01T00:00:00Z&amount=1000&includeFoldingUserTypes=8` | HTTP 200 in 0.9 s; `distroCount` 1, `totalPoints` 2,589,653, `totalWorkUnits` 18, `totalDistro` 1000; response SHA-256 `f7f256ebea85619177301032531be30506b654329062b53db0f6af57de4334d4` |

For October 2026 the sponsor's own distribution query (folding user type 8) has one recipient, so the chipnet
demonstration adds project demo keys and synthetic leaves to reach at least 300 leaves.

The live response stays in the operator's local API cache and is not committed, because it names a real
participant's address. The committed example,
[`deployments/fixtures/example-distro/epoch-1.json`](../deployments/fixtures/example-distro/epoch-1.json), is built
from [`examples/distro-example.json`](../examples/distro-example.json): the same response shape with three synthetic
recipients written by `scripts/example-distro.ts`. Rebuild and check it with
`npx tsx bin/tuai.ts epoch verify deployments/fixtures/example-distro/epoch-1.json`.

## Sponsor push distributions on mainnet

Measured 2026-11-17 16:14 UTC by `npm run push-measure`: the public indexer returned 100 candidate transactions for
the reward token category; each was read from Electrum `bch.imaginary.cash` and 22 have the push distribution layout
(one per month from 2025-01-11 to 2026-10-13, 1 to 3 recipients each, 262 to 557 bytes, fee = size + 1 sat, 1,000
sat of dust per recipient). Every txid, size and fee is in [`reports/push-distributions.json`](../reports/push-distributions.json)
and in the table of [`COST.md`](COST.md). BCH price at the same time: 208.16 USD (CoinGecko simple price API).

An earlier run on the same day read every candidate but failed on exit (`Manual connection management is disabled` when
closing the Electrum connection); the script now opens one managed connection and the rerun above completed.

## Watcher

Run on 2026-11-18 by `npm run watch-report`; aggregates in [`reports/watch-chipnet.json`](../reports/watch-chipnet.json).

- **Roots on chain.** For epochs 1 and 2 of the chipnet deployment the watcher read the pool state NFT from the
  recorded propose and activate transactions (Electrum `chipnet.bch.ninja`) and recomputed root and inputs hash from
  the committed epoch files and inputs. All four pairs match (03:41 UTC); `tuai watch --network chipnet --deployment
  deployments/chipnet` gives the same result.
- **Folding@home daily summary.** `https://apps.foldingathome.org/daily_user_summary.txt.bz2` downloaded once at
  2026-11-18 03:40:15 UTC: 28,753,037 bytes, SHA-256 `135703b69c1d9f01c1afa705f86231f38ad495adb1d470d962724385eb3f3c64`
  (server Last-Modified 2026-11-18 03:32:57 UTC). The file is public and changes daily, so it is kept by the operator
  and identified here by hash rather than committed.
- **Replay of real push distributions.** The 22 push distributions in `reports/push-distributions.json` were read
  from Electrum `bch.imaginary.cash` and rebuilt as one off-chain epoch: 45 payouts to 6 distinct recipients, replay
  root `d0506d1aa4d08cd6e143dc8ce724fac13d1384fe7dc1e0d7734a7c0e88bb4773`. Treating every leaf as link method 0, all 6
  addresses appear in a name of the daily summary; none was unlinked. The per-leaf result stays local because it pairs
  addresses with Folding@home names.

## Chipnet

Run on 2026-11-18 with the committed CLI from the project's own chipnet keys. Contracts and parameters:
[`deployments/chipnet/pool.json`](../deployments/chipnet/pool.json). Epoch files (300 leaves, depth 9, every leaf
with its proof): [`epoch-1.json`](../deployments/chipnet/epoch-1.json) and
[`epoch-2.json`](../deployments/chipnet/epoch-2.json); recompute either with
`npx tsx bin/tuai.ts epoch verify deployments/chipnet/epoch-2.json`. The five project demo keys sit at leaves 0, 1,
150, 298 and 299; the other 295 leaves pay synthetic scripts nobody holds a key for (ADR 0006). No real
participant's address is in the tree.

What the record below shows:

- **Root authority.** Epoch 1 was proposed with operator keys 1 and 3, epoch 2 with keys 2 and 3 (2-of-3).
- **Timelock.** Early activations were refused by the network with `non-BIP68-final`, including one forced
  attempt one block before the lock ended. Chipnet nodes require ten one-minute blocks per unit of a block-count
  sequence lock, so the demo delay of 3 means 30 blocks (measurements and reasoning in ADR 0006). Two probes
  were accepted outside the CLI from a one-off script used to find the rule, so they are not in the table. On coins
  mined at 336009: spends with sequence 3 and then sequence 1 were refused (tip 336015); a spend with sequence 0
  was accepted (`0674a0c44b2f263c1bf9991e048d43c722f411ec8cb37b8ebf67ddf73c3effc0`); a spend with sequence 1 was
  accepted with the tip at 336018 (`84b1c80568a0e96d22dc087b0ccb08c52f5180f4f0b01c2900ac18f856383b1d`).
- **Activation by anyone.** Activations were funded by the payer key, which holds no operator key.
- **Claims.** Each claim paid the leaf's full unclaimed amount to the leaf's own address; the claimant paid the fee
  and dust. Leaf 150's claim was funded by its own demo key; leaf 0's epoch 2 top-up was funded by a different
  demo key (leaf 150's), and the tokens still went to leaf 0's address.
- **Double claim.** A second first claim for leaf 0 (a duplicate receipt) was refused by the local VM at the
  `target < upper` check of `contracts/ClaimPool.cash` and by the network (`mandatory-script-verify-flag-failed`).
- **Epoch 2.** Cumulative amounts carried over; top-up claims paid only the difference.
- **Watcher.** `npx tsx bin/tuai.ts watch --epoch deployments/chipnet/epoch-2.json --network chipnet` after the
  epoch 2 activation recomputed the root from the committed inputs and found it active on chain (`matched: true`,
  no findings).

Generated by `npx tsx scripts/chain-report.ts chipnet` from the operator's run log, with block heights read from
Electrum and each size checked against the network's. Machine-readable copy:
[`deployments/chipnet/transactions.json`](../deployments/chipnet/transactions.json).

<!-- chipnet-transactions:start -->
| # | When (UTC) | Step | Transaction | Bytes | Fee (sat) | Block | Result |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-18 00:04:49 | prepare-genesis | [`14ec5fc2d31da0300dfdeb2bd64bc6b292af5c01e8e0c59bc1274a659e3e18a3`](https://cbch.loping.net/tx/14ec5fc2d31da0300dfdeb2bd64bc6b292af5c01e8e0c59bc1274a659e3e18a3) | 185 | 185 | 336009 | accepted |
| 2 | 2026-11-18 00:04:51 | token-genesis | [`bfb4f1c59e36eb87b65ffdc3fe0b246200f9e6810ad42ce994e8c9c151a6b0a1`](https://cbch.loping.net/tx/bfb4f1c59e36eb87b65ffdc3fe0b246200f9e6810ad42ce994e8c9c151a6b0a1) | 262 | 262 | 336009 | accepted |
| 3 | 2026-11-18 00:05:02 | prepare-genesis | [`9d4957d2e44390960854d1e39b7ed9c800cff956568b776abd064aa1cc9f31a6`](https://cbch.loping.net/tx/9d4957d2e44390960854d1e39b7ed9c800cff956568b776abd064aa1cc9f31a6) | 185 | 185 | 336009 | accepted |
| 4 | 2026-11-18 00:05:05 | deploy | [`6356165de951e6a7e4765151250eec97d853a368da5d11106865307a9ef40cec`](https://cbch.loping.net/tx/6356165de951e6a7e4765151250eec97d853a368da5d11106865307a9ef40cec) | 858 | 858 | 336009 | accepted |
| 5 | 2026-11-18 00:05:28 | propose-epoch-1 | [`72b5fbf76e2a5dfb14932ffe69db28e034cde7724cfac08cea7078217b7efa48`](https://cbch.loping.net/tx/72b5fbf76e2a5dfb14932ffe69db28e034cde7724cfac08cea7078217b7efa48) | 862 | 866 | 336009 | accepted (operators 1,3) |
| 6 | 2026-11-18 00:05:56 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 7 | 2026-11-18 00:06:01 | fund-demo-5 | [`6c35e14b8d8ea4778e59620eabc8ce7c81a48600811cfff1655f8dd27fcc6228`](https://cbch.loping.net/tx/6c35e14b8d8ea4778e59620eabc8ce7c81a48600811cfff1655f8dd27fcc6228) | 219 | 219 | 336009 | accepted |
| 8 | 2026-11-18 00:07:49 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 9 | 2026-11-18 00:08:53 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 10 | 2026-11-18 00:15:05 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 11 | 2026-11-18 00:18:07 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 12 | 2026-11-18 00:34:48 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 13 | 2026-11-18 00:36:30 | activate-epoch-1 | not mined | 1473 | 1473 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 14 | 2026-11-18 00:37:07 | activate-epoch-1 | [`5003786414a7babd59114603a497f9435c6b75989da9a8f183def325df7cd35a`](https://cbch.loping.net/tx/5003786414a7babd59114603a497f9435c6b75989da9a8f183def325df7cd35a) | 1473 | 1473 | 336043 | accepted (pending mined at 336009, tip 336038) |
| 15 | 2026-11-18 00:37:27 | claim-first-epoch-1 | [`bdb7b8f1e6e03691dc379c8c8fa5834425a75d2580df6a2d5f9a5eca071d6ca4`](https://cbch.loping.net/tx/bdb7b8f1e6e03691dc379c8c8fa5834425a75d2580df6a2d5f9a5eca071d6ca4) | 1899 | 1899 | 336043 | accepted (leaf 0) |
| 16 | 2026-11-18 00:37:38 | claim-first-epoch-1 | [`7b2850831200d256386e285572b6af14e59372b1908edd1b4fbb7bfec73d4f3d`](https://cbch.loping.net/tx/7b2850831200d256386e285572b6af14e59372b1908edd1b4fbb7bfec73d4f3d) | 1899 | 1899 | 336043 | accepted (leaf 1) |
| 17 | 2026-11-18 00:37:49 | claim-first-epoch-1 | [`aded1114eb0c2cfb9ad61cc6258fd379bb16b23df1544c4fa65f78ffe5c1cd2f`](https://cbch.loping.net/tx/aded1114eb0c2cfb9ad61cc6258fd379bb16b23df1544c4fa65f78ffe5c1cd2f) | 1901 | 1901 | 336043 | accepted (leaf 150) |
| 18 | 2026-11-18 00:38:02 | claim-first-epoch-1 | [`0041367c3339669e209e168e6ebec362b74e43e481279a662db1cc3ff499d039`](https://cbch.loping.net/tx/0041367c3339669e209e168e6ebec362b74e43e481279a662db1cc3ff499d039) | 1901 | 1901 | 336043 | accepted (leaf 298) |
| 19 | 2026-11-18 00:38:16 | claim-first-epoch-1 | [`e7b5780761a0c254d4db380051d2c616d31c3f560dee796955479a936c73038f`](https://cbch.loping.net/tx/e7b5780761a0c254d4db380051d2c616d31c3f560dee796955479a936c73038f) | 1901 | 1901 | 336043 | accepted (leaf 299) |
| 20 | 2026-11-18 00:38:55 | double-claim-epoch-1 | not mined | 1899 | 1899 | - | refused: local: ClaimPool.cash:75 Require statement failed at input 0 in contract ClaimPool.cash at line 75.; network: the transaction was rejected by network rules. mandatory-script-verify-flag-failed (Script |
| 21 | 2026-11-18 00:39:38 | propose-epoch-2 | [`9bbc758dd43b721a9526e251acd7eb19fc8c2fab8bd7f146acbcfddd94fb2c34`](https://cbch.loping.net/tx/9bbc758dd43b721a9526e251acd7eb19fc8c2fab8bd7f146acbcfddd94fb2c34) | 862 | 866 | 336043 | accepted (operators 2,3) |
| 22 | 2026-11-18 01:08:22 | activate-epoch-2 | [`d3217738961f951e97890fdf0782b5091a28bc38f247b820b80ab6af63bf93a3`](https://cbch.loping.net/tx/d3217738961f951e97890fdf0782b5091a28bc38f247b820b80ab6af63bf93a3) | 1473 | 1473 | 336076 | accepted (pending mined at 336043, tip 336072) |
| 23 | 2026-11-18 01:08:40 | claim-additional-epoch-2 | [`3b891a54a58dab33e147e6cb723241d2b8385f161d7fc18a7ef12cd27fed3c36`](https://cbch.loping.net/tx/3b891a54a58dab33e147e6cb723241d2b8385f161d7fc18a7ef12cd27fed3c36) | 1748 | 1748 | 336076 | accepted (leaf 0) |
| 24 | 2026-11-18 01:09:03 | claim-additional-epoch-2 | [`9c0edf1cbb7803e643b50c9bfd3ba9eac50b217b39686cfd84cc5ae6c6720164`](https://cbch.loping.net/tx/9c0edf1cbb7803e643b50c9bfd3ba9eac50b217b39686cfd84cc5ae6c6720164) | 1750 | 1750 | 336076 | accepted (leaf 299) |
| 25 | 2026-11-18 21:12:16 | fund-relay-chipnet | [`58ca9a8181e68dfdfec161853e745b850c4ea56d26052264337599c7ab36552e`](https://cbch.loping.net/tx/58ca9a8181e68dfdfec161853e745b850c4ea56d26052264337599c7ab36552e) | 219 | 219 | 337267 | accepted |
<!-- chipnet-transactions:end -->

## Chipnet operator push

Run on 2026-11-18 with the committed CLI (`--run push`) from the project's own chipnet keys, to show the operator
push path of ADR [0008](decisions/0008-operator-push.md) on a real network. This is a second, smaller pool with the
version 2 contracts; the 300-leaf pool above keeps its version 1 contracts. Contracts and parameters (push delay 3,
push minimum and BCH limit from `config/tuai.json`):
[`deployments/chipnet-push/pool.json`](../deployments/chipnet-push/pool.json). Epoch file (five project demo keys,
two balances below the push minimum): [`epoch-1.json`](../deployments/chipnet-push/epoch-1.json). The deploy left
BCH with the reward tokens (`tuai deploy --vault-sats`) so pushes pay their dust and fee from the vault.

What the record below shows:

- **Push delay.** An arm sent right after the activation confirmed was refused by the network (`non-BIP68-final`);
  the arm after the delay was accepted.
- **Push minimum.** A push of a balance below the minimum, built with `tuai push --force` and sent without the local
  script check, was refused by the network. The CLI refuses it before sending without `--force`.
- **Push.** A balance above the minimum was pushed to the leaf's own address with no wallet input; the vault's BCH
  paid the dust and fee.
- **Pull still works.** The balance below the minimum was then claimed by an ordinary pull claim.

Generated by `npx tsx scripts/chain-report.ts chipnet push` from the operator's run log. Machine-readable copy:
[`deployments/chipnet-push/transactions.json`](../deployments/chipnet-push/transactions.json).

<!-- chipnet-push-transactions:start -->
| # | When (UTC) | Step | Transaction | Bytes | Fee (sat) | Block | Result |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-18 06:33:52 | prepare-genesis | [`5745ddb93df78406fdbf0b16d7d74964a76839bd2f746efae3a35ed731dfad49`](https://cbch.loping.net/tx/5745ddb93df78406fdbf0b16d7d74964a76839bd2f746efae3a35ed731dfad49) | 185 | 185 | 336402 | accepted |
| 2 | 2026-11-18 06:33:56 | token-genesis | [`aa1c5c4af246dbc0b1d784e145c3c77f4d3e6c089fb55c4dc64cb796bb005068`](https://cbch.loping.net/tx/aa1c5c4af246dbc0b1d784e145c3c77f4d3e6c089fb55c4dc64cb796bb005068) | 262 | 262 | 336402 | accepted |
| 3 | 2026-11-18 06:34:18 | prepare-genesis | [`99bf150551834802dda9fb0f2e712a3773f541728905846606f02bcecfe935f5`](https://cbch.loping.net/tx/99bf150551834802dda9fb0f2e712a3773f541728905846606f02bcecfe935f5) | 185 | 185 | 336402 | accepted |
| 4 | 2026-11-18 06:34:22 | deploy | [`152f133cbf09c7838ad6e1309e225ccb551b86bd282b7fdbc1be0e65de57b117`](https://cbch.loping.net/tx/152f133cbf09c7838ad6e1309e225ccb551b86bd282b7fdbc1be0e65de57b117) | 858 | 858 | 336402 | accepted |
| 5 | 2026-11-18 06:34:54 | propose-epoch-1 | [`f138cca88613543409a9380becbac8264e2cccdcd331796bc3bb442ad6d7b3a7`](https://cbch.loping.net/tx/f138cca88613543409a9380becbac8264e2cccdcd331796bc3bb442ad6d7b3a7) | 1024 | 1030 | 336402 | accepted (operators 1,2) |
| 6 | 2026-11-18 07:08:08 | activate-epoch-1 | [`7ad329860c61266cb76e6362b88776398aab453e1ca5e39a3fdd046fdfe5108e`](https://cbch.loping.net/tx/7ad329860c61266cb76e6362b88776398aab453e1ca5e39a3fdd046fdfe5108e) | 1688 | 1688 | 336441 | accepted (pending mined at 336402, tip 336433) |
| 7 | 2026-11-18 07:16:24 | arm-epoch-1 | not mined | 1689 | 1689 | - | refused: BIP68 sequence lock not satisfied: the transaction was rejected by network rules. non-BIP68-final (code 64) |
| 8 | 2026-11-18 07:44:45 | arm-epoch-1 | [`a7087d2fd81c54eb5136b7de3836b2b67ba4efadc2b67d35b9d1de00d023dd32`](https://cbch.loping.net/tx/a7087d2fd81c54eb5136b7de3836b2b67ba4efadc2b67d35b9d1de00d023dd32) | 1689 | 1689 | 336472 | accepted (pending mined at 336441, tip 336471) |
| 9 | 2026-11-18 07:46:39 | push-first-epoch-1 | not mined | 2278 | 2278 | - | refused: the transaction was rejected by network rules. mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation) (code 16) |
| 10 | 2026-11-18 07:46:58 | push-first-epoch-1 | [`5fc63b2474f735cecd558e43b017c52d43a7120dd2b13f47fd5ed1c6481f42e0`](https://cbch.loping.net/tx/5fc63b2474f735cecd558e43b017c52d43a7120dd2b13f47fd5ed1c6481f42e0) | 2278 | 2278 | 336474 | accepted (leaf 4, 4278 sats from the vault) |
| 11 | 2026-11-18 07:47:45 | claim-first-epoch-1 | [`cbf3836d89da6a4677a313ce35a92e5c8319ff2132ae0843365891fcc1f81e8c`](https://cbch.loping.net/tx/cbf3836d89da6a4677a313ce35a92e5c8319ff2132ae0843365891fcc1f81e8c) | 1757 | 1757 | 336474 | accepted (leaf 1) |
<!-- chipnet-push-transactions:end -->

## Chipnet claims from the page

Claims made on the public claim page with "Claim now", fee paid by the chipnet demo relayer
(docs/decisions/0009-chipnet-relayer.md). Each transaction was read back from Electrum by `scripts/page-claims.ts`
before it was recorded: the leaf received exactly its cumulative amount minus what it had claimed, the other
outputs went to the deployment's own contracts, and the only remaining output was the relayer's change. The table
and list below are generated from `deployments/chipnet/page-claims.json`.

<!-- chipnet-page-transactions:start -->
| # | When (UTC) | Leaf address | Transaction | Bytes | Fee (sat) | Block | Tokens paid |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-18 21:45:50 | `bchtest:zz8fm0yp5j5as68vel8rvskv7xtz8xca8g90zrn4mm` | [`2b6a7acc0963b14c0a227014eca58bf0c9b931dd9c26f90d6ce808111d582a9f`](https://cbch.loping.net/tx/2b6a7acc0963b14c0a227014eca58bf0c9b931dd9c26f90d6ce808111d582a9f) | 1901 | 1901 | 337326 | 30400000000 |

"Try to claim again" on a claimed leaf, answered by the node and shown on the page:

- 2026-11-18 21:46:05 UTC, `bchtest:zz8fm0yp5j5as68vel8rvskv7xtz8xca8g90zrn4mm`: refused, `Local check: ClaimPool.cash:75 Require statement failed at input 0 in contract ClaimPool.cash at line 75. Node: the transaction was rejected by network rules.`
<!-- chipnet-page-transactions:end -->
