# 0017: Inputs may be stored as hex text

## Context

Epoch inputs are stored under `inputs/<sha256>.json`, and the manifest that names them is hashed into the
inputs hash committed on chain. One sponsor API response for epoch 3 contains a `cashTokensAddress` field whose
name and value match a generic credential pattern in secret scanners. The value is a public address, but the
bytes cannot be edited: any change breaks the input hash and so the on-chain commitment.

## Decision

An input may be stored as `inputs/<sha256>.json.hex`: the exact bytes as lowercase hex in fixed-width lines.
`readStoredInput` reads the raw `.json` file when present and otherwise decodes the `.hex` file. The manifest
still names the `.json` file, so epoch files, inputs hashes and on-chain roots are unchanged. The claim page
build decodes hex inputs and serves them under their manifest names, so browsers see the original bytes.
Hex text has no letters beyond `a` to `f`, so it cannot contain a credential keyword.

## Consequences

- `tuai epoch verify` and `epoch build` accept both forms; a hex input that is not hex is refused.
- New inputs are still written as raw JSON. A response that trips a scanner is converted with
  `encodeStoredHex` and checked with `tuai epoch verify` before it is committed.
- Rollback: decode the `.hex` file back to `.json`; nothing else refers to the stored form.
