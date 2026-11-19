# 0011. Signed compatibility links

Status: accepted, 19 Nov 2026

## Context

Method 1 leaves pay addresses that FoldingCash maps to Folding@home users who did not put an address in their name.
Public stats cannot confirm such a mapping, so a watcher had to take it as given. The bounty lists independently
verifiable compatibility links as a stretch item.

## Decision

The linked address signs a fixed text naming the distributor domain, the Folding@home name and the address, in the
wallet signed message format (docs/SPEC.md section 8). Signed links are published in a links file next to the
epoch inputs. `tuai link sign` and `tuai link verify` make and check one link; `tuai watch --links` reports every
method 1 leaf as verified or unverified and treats a failing signature as a finding.

- The wallet format, not a new one, so a user can sign in the wallet they already hold the key in.
- The links file is outside the leaf and the root. A leaf stays `method || cumulative || lockingBytecode`, the
  contracts and every recorded chipnet transaction are unchanged, and links can be added after a root is published.
- Only P2PKH: a signature proves a key hash, not a script.
- The domain lives in `config/tuai.json` (`link.domain`).

## Consequences

- An unverified method 1 leaf still pays; verification is evidence for watchers, not a gate in the contract. Making
  it a gate would need the signature or its hash inside the leaf, which changes the leaf format and every root.
- The signature proves that the key holder claims the name. It does not prove that the person controls the
  Folding@home account; Folding@home has no signing key to check that against.

## Rollback

Drop the `--links` flag and the `link` commands; nothing on chain depends on them.
