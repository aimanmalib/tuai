# 0015. Legacy BTC leaves (link method 2)

Status: accepted, 20 Nov 2026

## Context

The sponsor's production distribution query asks for one user type (`includeFoldingUserTypes=8`, CashTokens
addresses). Asking for all user types (`15`) returns many more recipients, and almost all of them are entries with a
`bitcoinAddress` (`1...`) and no `cashTokensAddress`. Before this change `distroToAllocations` refused such a
response outright. The bounty lists legacy BTC as a planned compatibility method that is not built yet, and asks
whether each leaf should record which linking method produced its address so a watcher knows what it can verify from
public Folding@home data.

A P2PKH locking script, `OP_DUP OP_HASH160 <hash160> OP_EQUALVERIFY OP_CHECKSIG`, is the same bytes on BTC and BCH,
and the same private key spends it on both. The address itself is in the Folding@home user name, which is public.

## Decision

1. New link method `legacyBtcName = 2` in `src/leaf.ts`. The method byte is already part of the leaf preimage and the
   claim contract only hashes it, so no contract change and no new deployment are needed. A method 2 leaf must pay a
   P2PKH script; the library refuses anything else.
2. `src/leaf-legacy.ts` decodes the address with libauth's Base58Check (no new package). Only version `0x00` is
   accepted. P2SH, bech32, other versions, bad checksums and non-Base58 text are refused with a named reason.
3. `distroToAllocations` gives CashTokens entries the default method as before and legacy entries method 2. A refused
   entry stops the build; the error lists every refused entry with its position, so nothing is dropped silently.
4. The watcher indexes Base58 P2PKH addresses that are a whole name or one `_` separated part of a name, separately
   from CashAddr links, and reports `legacy: { checked, found, missing[] }`. `--fah` reads plain or `.bz2` summaries
   as a stream.
5. `sponsorApi.realEpoch` in `config/tuai.json` holds the all-types query and its date windows for a demonstration
   epoch built from real sponsor data (`tuai epoch build --source api --real`). The production setting stays `8`.

## Consequences

- Existing epoch files and inputs verify unchanged: entries with a CashTokens address produce the same leaves.
- A recipient whose hash already has a method 0 leaf cannot get a method 2 leaf; the build refuses the method change
  and the operator decides.
- Method 2 proves the same thing method 0 proves: the paid script is the one the public name points to. It does not
  prove that the key holder is the person folding under that name.
- Payouts go to a BCH P2PKH output the user's old BTC key controls. A user who only kept BTC wallet software needs a
  BCH wallet that can import that key to spend it. This is stated in the docs rather than hidden.

Rollback: revert the commit. Leaves already committed on chain with method 2 stay claimable, since the contract does
not interpret the method byte.
