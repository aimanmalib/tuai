# 0016: A claim signed by a third-party wallet on chipnet, driven by a script

Status: accepted, 20 Nov 2026.

## Context

The page can hand a claim to a wallet over WizardConnect (ADR 0012): the relay prepares the transaction, the page
checks every input and output, and the wallet signs and pays the fee. Until now that path was tested only with an
in-process fake wallet. A reviewer should be able to see a claim signed by a wallet this project did not write.

## Decision

- Wallet: Cashonize, a web wallet that speaks WizardConnect and builds to a static site, at the version and commit
  named in `thirdPartyWallet` (config/tuai.json). It is not added as a dependency; the build is made outside the
  repository and passed with `--cashonize <dir>` (how to build it is in the script header).
- `scripts/wallet-claim-cashonize.ts` serves that build on 127.0.0.1 at `thirdPartyWallet.port`, opens it in headless
  Chromium with its own phrase, switches it to chipnet, and pairs it with the public page. Modes: `--address-only`
  (the address as Cashonize shows it), `--dry` (pair and stop before any signature), the default (claim and record),
  and `--refresh` (fill in block heights).
- The phrase lives in the ignored `.env` under `thirdPartyWallet.mnemonicEnv`. It is made once and never replaced,
  printed, logged or shown in a screenshot; the WizardConnect pairing link is treated the same way. Every printed line
  goes through `redact` (src/wallet-driver.ts), which is unit tested.
- Chipnet only: the config check refuses any other network and a fund ceiling above 30,000 satoshis.
- Claims are recorded in `deployments/chipnet/wallet-claims.json` (txid, wallet name and version, commit, leaf index,
  address, height, time), checked by `parseWalletClaims`.

## Consequences

- The run uses a public Nostr relay for pairing and the live page and relay; it is not part of the test gate. The
  gate covers the pure parts only.
- A Cashonize release that renames its buttons breaks the script, not the page. The version is pinned for that reason.
- Undo: revert the commit; recorded chipnet claims stay on chain as test data.
