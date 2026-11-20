# Specification

This is the format and transaction reference for Tuai. It describes what the code in `src/` builds and what the
contracts in `contracts/` accept, so another implementation can produce compatible trees, epoch files and
transactions. Reasons for each choice are in [`docs/decisions/`](decisions/).

All integers in hashed or committed data are little-endian. `||` is concatenation. `sha256` is single SHA-256.

## 1. Leaf

```
leaf     = 0x00 || method(1) || cumulative(8, LE, unsigned) || lockingBytecode(1..201)
leafHash = sha256(leaf)
```

- `method` records how the address was linked to a Folding@home identity: `0` = the address appears in the
  Folding@home user name (checkable from the public daily user summary), `1` = FoldingCash's own address mapping,
  `2` = a legacy BTC P2PKH address in the Folding@home user name, paid to the same hash160 script (section 9).
  Other values are refused by the library (`src/leaf.ts`).
- `cumulative` is everything the recipient has earned since the first epoch, in base token units, at most `2^63 - 1`
  so the contract reads it as a positive script number.
- `lockingBytecode` is the output script the payment must go to (P2PKH, P2SH or any standard script up to 201
  bytes). One leaf per locking bytecode: duplicates are merged before a tree is built.

## 2. Tree

```
node = sha256(0x01 || left(32) || right(32))
```

- Leaves are ordered by locking bytecode (lowercase hex, ascending). Recipients with a cumulative of zero are left
  out.
- `depth` is the smallest `d` with `2^d >= leafCount`; one leaf gives depth 0 and its leaf hash is the root.
- A level with an odd number of hashes is padded with 32 zero bytes on the right (not by repeating the last hash).
- The prefixes `0x00` and `0x01` keep leaves and nodes in separate domains, so a node cannot be presented as a leaf.
- A proof is the list of siblings from the leaf level up, plus the leaf index. Bit `i` of the index (lowest first)
  says whether the hash at level `i` is a right child (`1`: `node(sibling, hash)`) or a left child
  (`0`: `node(hash, sibling)`). After the last sibling the remaining index must be 0, so an index cannot be aliased.
- `tree.maxDepth` in `config/tuai.json` (24) bounds the depth; the contract enforces the same value.
- Test vectors (1 to 300 leaves, with preimages, roots and proofs): [`examples/vectors.json`](../examples/vectors.json).

## 3. Epoch file and inputs hash

An epoch file (`format: tuai-epoch/1`, written by `tuai epoch build`) holds the root, the inputs hash, the manifest,
every recipient balance and every leaf with its address and proof. A claimant needs only this file and the chain.

The manifest (`format: tuai-manifest/1`) lists the epoch number, maximum depth, default link method, token decimals,
the previous epoch (file, number, root) and every input file with its SHA-256 and kind (`distro` for a sponsor
`GetDistro` response, `allocations` for a plain allocation list) and, for API inputs, the query that produced it.
Input files are stored next to the epoch file as `inputs/<sha256>.json`.

```
inputsHash = sha256(canonicalJson(manifest))   // keys sorted at every level, no whitespace
```

Cumulative amounts: each input adds allocations to the previous epoch's balances. Sponsor amounts are whole tokens
converted to base units as `round(amount * 10^8)`. Both input kinds the CLI reads are already per-period amounts and
are added as they are. For a source that reports running credit totals instead, `advanceEpoch` in
`src/epoch/cumulative.ts` counts new work only above each recipient's high-water mark, so a dip in credit is never
paid twice; the CLI does not use it yet. `tuai epoch verify <file>` rebuilds the root
and the inputs hash from the stored inputs and the previous file and fails on any difference.

## 4. On-chain state

Three contracts share one **pool token category** (the txid of the deploy transaction's first input):

| UTXO | Contract | Token | Commitment |
|---|---|---|---|
| State NFT | `ClaimPool` | pool category, **minting** | `root(32) \|\| epoch(4, LE) \|\| inputsHash(32)` (68 bytes) |
| Pending-root NFT | `RootGate` | pool category, **mutable** | same layout as the state NFT; armed for pushes: `state \|\| 0x01` (69 bytes, section 5.5) |
| Receipt | `PoolVault` | pool category, **immutable** | `key(32) \|\| next(32) \|\| claimed(8, LE)` (72 bytes) |
| Reward tokens | `PoolVault` | reward category, fungible | none |

- `key = sha256(lockingBytecode)` of the leaf. Receipts form a singly linked list sorted by key read as a
  little-endian unsigned integer. The head is `key = 0x00..00, next = 0xff..ff, claimed = 0`.
- Contract parameters: `ClaimPool(poolCategory, rewardCategory, vaultBytecode, maxDepth, pushMinimum, pushSats)`,
  `PoolVault(poolCategory)`, `RootGate(operatorA, operatorB, operatorC, delay, pushDelay, poolCategory)`.
- Version 1 contracts (no push path; `src/contracts/artifacts/v1/`) drop `pushMinimum`, `pushSats` and `pushDelay`.
  The recorded chipnet pool uses them: its `deployments/chipnet/pool.json` has no `push` field.
- `PoolVault.spend` only requires input 0 to hold the pool category's minting NFT. That NFT never leaves `ClaimPool`,
  so the `ClaimPool` script at input 0 decides every vault spend.
- A sharded pool (ADR 0013, `tuai deploy --shards K`) holds K state NFTs and K reward token UTXOs, all created by the
  deploy transaction after the version 1 outputs; the contracts are unchanged. A claim spends one of each, chosen
  from the first four bytes of its receipt key. Each shard is activated in its own transaction; the newest epoch
  among the shards is the active root.
- Each kept UTXO (state, pending root, reward tokens, receipts) keeps its exact satoshi value through every
  transaction.

## 5. Transactions

Input and output indexes are fixed; the contracts check them by position.

### 5.1 Deploy (`tuai deploy`, `src/tx/deploy.ts`)

| # | Input | Output |
|---|---|---|
| 0 | payer BCH, output index 0 of its transaction (its txid becomes the pool category) | `ClaimPool`: state NFT, minting, root 0, epoch 0 |
| 1.. | payer reward token UTXOs (one category) | `PoolVault`: receipt list head |
| | | `PoolVault`: all reward tokens |
| | | `RootGate`: pending-root NFT, mutable, same commitment as the state |
| | | payer change |

A zero root has no known preimage, so nothing is claimable before the first activation.

### 5.2 Propose (`tuai propose`, `src/tx/propose.ts`, `RootGate.propose(sig, sig)`)

| # | Input | Output |
|---|---|---|
| 0 | `RootGate`: pending-root NFT | `RootGate`: pending-root NFT with the new commitment, same value, mutable |
| 1.. | funding without tokens | change |

Requires 2 of the 3 operator signatures (`OP_CHECKMULTISIG` with `ECDSA` signatures, in gate key order), a 68-byte commitment,
and an epoch not below the pending one. Proposing again creates a new UTXO, so the activation delay restarts.

### 5.3 Activate (`tuai activate`, `src/tx/activate.ts`, `ClaimPool.activate()` + `RootGate.activate()`)

| # | Input | Output |
|---|---|---|
| 0 | `ClaimPool`: state NFT | `ClaimPool`: state NFT with the pending commitment, same category, value, amount 0 |
| 1 | `RootGate`: pending-root NFT, sequence = `delay` blocks | `RootGate`: pending-root NFT unchanged |
| 2.. | funding without tokens | change without tokens |

Needs no key, so anyone can send it. `RootGate.activate` requires `this.age >= delay` (BIP68 relative lock on input
1), a pending epoch above the active one, and no tokens on any input or output from index 2. `ClaimPool.activate`
requires input 1 to be the pool category's mutable NFT, which binds the activation to the gate.

### 5.4 Claim (`tuai claim`, `src/tx/claim.ts`, `ClaimPool.claim(method, cumulative, lockingBytecode, index, proof)`)

First claim (no receipt for `key` yet):

| # | Input | Output |
|---|---|---|
| 0 | `ClaimPool`: state NFT | `ClaimPool`: state NFT unchanged |
| 1 | `PoolVault`: reward tokens | `PoolVault`: reward tokens minus `payment`, same value |
| 2 | `PoolVault`: predecessor receipt `P` with `P.key < key < P.next` | `PoolVault`: `P.key \|\| key \|\| P.claimed`, same value |
| 3.. | claimant funding (not pool, not vault) | payment: `payment` reward tokens to `lockingBytecode` |
| | | `PoolVault`: new receipt `key \|\| P.next \|\| cumulative` |
| | | claimant change, no tokens |

Additional claim (receipt for `key` exists): input 2 is that receipt, output 3 is
`key || next || cumulative`, and there is no fourth receipt output.

`payment = cumulative - claimed`, which must be above zero; there is no minimum. The script recomputes the leaf hash,
walks the proof to the active root, checks the receipt rule above, and checks that the payment goes to the leaf's
own locking bytecode. Whoever submits the claim pays the fee, the payment output's dust and, on a first claim, the
new receipt's dust; the submitter cannot change where the tokens go. Any reward-token UTXO at the vault can be input 1
(the builder takes the largest one that covers the payment and leaves at least one unit), so tokens sent to the vault
address after deploy are claimable too (`tests/vault-topup.test.ts`).

Why leaving out a receipt does not pay twice: receipts stay in the vault as one sorted list, and a first claim must
spend the receipt `P` just before `key` and pass `P.key < key < P.next` on that receipt's real commitment. Once `key`
is in the list its predecessor points at it, so no receipt can pass the check for it again, and an NFT of another
category is refused at input 2. The own receipt is spent only by a claim that recreates it in the vault with the new
cumulative amount (no burn, move or reset), and an activation carries no token inputs. Only a claim writes `claimed`;
a new root that lists a leaf lower or unchanged pays it nothing. Each attempt is a case in
[`tests/receipt-omission.test.ts`](../tests/receipt-omission.test.ts); the chipnet refusals are in
[MEASURED](MEASURED.md#chipnet).

### 5.5 Arm pushes (`src/tx/push.ts` `planArm`, `ClaimPool.activate()` + `RootGate.arm()`)

Same layout as an activation. Input 1 (the pending-root NFT) has sequence = `pushDelay` blocks and must equal the
active state, so it was last recreated by the activation of that state (or by a proposal of the same commitment).
Output 0 is the state NFT unchanged; output 1 is the pending-root NFT with commitment `state || 0x01`. Needs no key.
A later proposal writes a 68-byte commitment, which closes pushes until the next root has stood `pushDelay` blocks.
An armed NFT cannot be activated: its epoch equals the active epoch.

### 5.6 Push (`src/tx/push.ts` `planPush`, `ClaimPool.claim(...)` + `RootGate.push()`)

A claim (section 5.4) with exactly one more input and output, and nothing else:

| # | Input | Output |
|---|---|---|
| 0..2 | as in a claim | as in a claim, except output 1 may hold up to `pushSats` fewer satoshis |
| 3 | `RootGate`: pending-root NFT armed for the active state | first push: new receipt, then the pending-root NFT unchanged; additional push: the pending-root NFT unchanged |

`ClaimPool.claim` treats input 3 holding the mutable pool NFT as a push: it requires the commitment `state || 0x01`,
`payment >= pushMinimum`, exactly four inputs, the pending-root NFT as the only output after the receipts, and
`outputs[1].value + pushSats >= inputs[1].value`. The vault's BCH therefore pays the payment dust, a new receipt's
dust and the fee. `RootGate.push` runs at input 3 and requires the last output to be the same NFT at the gate.
The payment still goes to the leaf's locking bytecode and the same receipt rule applies, so a push and a claim
never pay the same amount twice.

## 6. Sizes and limits

Measured sizes by proof depth, operation cost and the deepest proof the VM accepts are generated into
[`docs/DEPTH.md`](DEPTH.md); live chipnet sizes are in [`docs/MEASURED.md`](MEASURED.md#chipnet). Each tree level adds
one 32-byte sibling to a claim.

## 7. Network notes

- Relative locks: chipnet nodes required ten one-minute blocks per unit of a block-count sequence lock at the time of
  the demonstration (ADR 0006). `networks.<name>.sequenceBlockScale` tells the tools how long to wait; the contracts
  do not change.
- The contracts need the 2026 VM (commitments above 40 bytes, proof loops, 33-byte number comparisons). The mock
  network and chipnet run it.

## 8. Signed compatibility links

A method 1 leaf pays an address FoldingCash mapped to a Folding@home user who has no address in their name. To make
that mapping checkable, the user signs this text (lines joined by a single `\n`, no trailing newline) with the key
of the mapped address:

```
FoldingCash compatibility link
domain: <link.domain from config/tuai.json>
fah: <Folding@home user name, exactly as in the daily stats file>
address: <P2PKH CashAddr with prefix, lowercase, without the token flag>
```

- Hash: the wallet signed message format, `hash256(varint(24) || "Bitcoin Signed Message:\n" || varint(len) || text)`,
  so Electron Cash and other wallets that sign messages produce a valid link. `tests/link.test.ts` checks the hash
  against a published signature vector.
- Signature: base64 of 65 bytes, `header || r || s`, `header = 27 + recoveryId (+ 4 for a compressed key)`.
- Check: recover the public key, `hash160` it, compare with the address's key hash. Only P2PKH addresses can be
  linked this way. The domain stops a link signed for one distributor from being reused for another.
- Links file, published next to the epoch inputs: `{ "links": [{ "name", "address", "signature" }] }`.

Tools: `tuai link sign --name <n> --address <a> --key-file <file>` (WIF or a key file, prints the address and
signature only), `tuai link verify --name <n> --address <a> --signature <s>`, and
`tuai watch --epoch <file> --links <file>` (or `tuai link verify --links <file> --epoch <file>`). The watcher lists
each method 1 leaf as verified (with the names signed for it) or unverified; a link whose signature fails is a finding
and makes the command exit 1. An unverified leaf is not an error: it means the mapping is taken on FoldingCash's word,
as before.

## 9. Legacy BTC leaves (method 2)

Many Folding@home users who earn FoldingCash rewards still carry an old Bitcoin address (`1...`) in their user name
instead of a CashTokens address. The sponsor's distribution endpoint returns them when all user types are requested
(`includeFoldingUserTypes=15`) as entries with `bitcoinAddress` set and no `cashTokensAddress`.

- Encoding: the address is decoded as Base58Check. Only version `0x00` (P2PKH) is accepted. The leaf's locking
  bytecode is `76a914 <hash160> 88ac`, the same bytes the address locks on BTC, which on BCH is spent by the same key.
  No mapping database is involved. `src/leaf-legacy.ts`.
- Refused, by name, never skipped: a bad checksum (`checksum`), a P2SH address `3...` (`p2sh`, its redeem script is
  not known and may not be spendable on BCH), a bech32 address `bc1...` (`bech32`), any other version byte
  (`version`) and anything that is not Base58 (`format`). One refused entry stops the build and the error lists every
  refused entry with its position (`DistroEntriesError`, `src/epoch/inputs.ts`). An entry with neither address is
  refused the same way.
- A recipient seen in several inputs (for example two monthly windows) is one leaf whose cumulative amount is the sum.
  A script that was a method 0 leaf cannot become a method 2 leaf later: the build refuses a method change
  (section 3), so the same hash in CashAddr and Base58 form must be resolved by the operator, not merged silently.
- Watcher: `tuai watch --epoch <file> --fah <daily_user_summary.txt[.bz2]>` turns each method 2 leaf back into its
  `1...` address and looks for it as a whole Folding@home name or as one `_` separated part of a name (the common
  forms are `<name>_<address>`, `<name>_ALL_<address>` and `<name>_FLDC_<address>`). The CashAddr form of the same hash
  does not count. Output: `links.legacy = { checked, found, missing[] }`; each missing leaf is a finding and the
  command exits 1.
- What this does not prove, as for method 0: that the person who holds the BTC key is the person who folds under that
  name. It proves only that the paid script is the one the public name points to, so anyone can check the leaf
  without asking FoldingCash.

Building a demonstration epoch from real sponsor data: `tuai epoch build --source api --real` sends one request per
window in `sponsorApi.realEpoch` (all user types) through the same cached, rate limited client as `--source api`. The
production query (`sponsorApi.includeFoldingUserTypes`) is not changed. A rate limited run stops with a retry time;
running it again after that fetches only the window that is not cached yet. Decision record: ADR 0015.
