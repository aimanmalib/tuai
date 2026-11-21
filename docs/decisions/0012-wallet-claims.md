# 0012. Wallet claims through WizardConnect

Status: accepted, 19 Nov 2026

## Context

The claim page could claim through the chipnet demo relayer (ADR 0009) or print a CLI command. A claimant who
holds BCH in a wallet had no way to claim from the page with that wallet. The bounty lists wallet support under
infrastructure and usability.

## Decision

Three parts, each with one job:

1. **Relay prepares** (`src/relay/prepare.ts`, `POST /api/relay/prepare`). The page sends the leaf address and a
   few receive and change addresses it derived from the wallet's public keys. The relay reads those addresses'
   coins from the chain and plans the same claim as the CLI and the relayer (`planClaim`, one builder), with the
   wallet's coins as funding inputs that carry placeholder unlockers. It returns the unsigned transaction and its
   source outputs. It holds no wallet key, never signs, never broadcasts, and spends nothing of its own.
2. **Page checks** (`web/src/wallet-check.ts`). The relay is not trusted. Before anything reaches the wallet, the
   page refuses the transaction unless every input is a pool contract or one of its own wallet addresses, every
   output passes the same output guard as the relayer (`src/relay/guard.ts`), the leaf receives exactly the
   amount the page read from the chain, and the wallet loses at most `relay.wallet.maxSpendSats`. The page, not
   the relay, decides which key path signs each wallet input.
3. **Wallet signs and broadcasts** over WizardConnect (`web/src/wizardconnect.ts`): a pairing code (QR or link),
   then one `sign_transaction_request`. The protocol requires `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS`, so a
   signature covers every input and output the page checked.

- WizardConnect rather than WalletConnect: WalletConnect needs a project id and a domain allowlist from a hosted
  service; WizardConnect runs over public Nostr relays with no account.
- `@wizardconnect/core` and `@wizardconnect/dapp` are LGPL-3.0 (license file of their source repository). They are
  used unmodified from npm and loaded as a separate chunk only after the user presses the button. Their newer
  libauth release is installed under them; the project's own pinned libauth is unchanged.
- Chipnet only: the route lives in the relay container, which refuses any network but chipnet (ADR 0009). Limits,
  the route path and the Nostr relay list are in `config/tuai.json` under `relay.wallet`.

## Consequences

- Tested in process (`tests/wallet-claim.test.ts`): a fake wallet signs the inputs the page names and the mock
  network, which runs the full VM, accepts the claim; a wrong key path is refused by the VM; a relay that redirects
  the payment, skims change or adds a foreign input is refused by the page before signing.
- No claim from a real wallet is recorded. Which wallets speak WizardConnect on chipnet is outside this project's
  control; the page states it plainly when no coins are found.
- A user with a mainnet-only wallet gets "no chipnet coins found". Mainnet wallet claims would need a mainnet
  prepare service, which this demo does not run.

## Addendum: connect button, pairing code and balance chip

- The connect button reads "Connect with WizardConnect" next to a small wizard hat icon. The npm packages ship no
  logo asset, so the icon is drawn for this page (`web/src/wizard-hat.ts`) and hidden from assistive technology;
  the button text carries the name.
- The pairing code is itself a button: pressing it copies the pairing link and says "Copied". The Copy button below
  the code stays for users who do not expect a code to be pressable.
- While a wallet is connected, a balance chip above the result card (`web/src/wallet-balance-view.ts`, numbers in `wallet-balance.ts`) shows the BCH and
  the reward tokens held by the addresses this page derived from the wallet's keys. It reads them in the browser
  with `blockchain.address.listunspent` (the same Electrum call the page already uses for contract addresses),
  counts each coin once even when an address is derived twice, and reads again every
  `web.walletBalanceRefreshSeconds` while the tab is visible.
- After a claim was sent the session stays open, so the chip shows the result without a click; it closes on
  Disconnect, when the wallet ends the session, or when a new wallet connection starts. A claim that did not go out
  ends the session as before.
- `e2e/wallet-balance.spec.ts` answers the lazily loaded wallet module with a stub session, so the tests contact no
  Nostr relay.

## Addendum: address discovery

A wallet that hands out a new address for every payment keeps its coins far from index 0, often on the change path.
Looking at a fixed handful of addresses made such a wallet look empty. The page now searches the way the wallet
itself does.

- **Gap limit.** `web/src/wallet-scan.ts` walks the receive path, then the change path, in batches of
  `relay.wallet.gapLimit` addresses (20, the BIP44 address gap limit). An address is used when it has any history or
  any coin. The search on a path stops after `gapLimit` unused addresses in a row after the last used one, or at
  `relay.wallet.maxAddressesPerScan` addresses on that path (60). Coins behind a full gap of unused addresses are not
  seen, which is the same rule wallets follow when they restore from a seed.
- **In the browser.** WizardConnect shares extended public keys, so the page derives any index locally. The history
  and coins of each batch are read through one Electrum connection (`blockchain.address.get_history` and
  `blockchain.address.listunspent`). The relay is not asked to search: it only reads the addresses the page sends.
- **What the relay gets.** Only addresses holding coins without tokens, largest first, plus one change address: the
  first unused change address, or the first unused receive address when the wallet shares no change key. At most
  `relay.wallet.maxAddresses` addresses (20) are sent; the relay rejects longer lists. The page still checks every
  input and output before the wallet sees the transaction (`wallet-check.ts`); the key path of each input comes from
  the search.
- **No coins found.** The relay is not called. The page says how many receive and change addresses it looked at and
  that it only uses chipnet test coins, then points to the claim that needs no wallet: the Claim now button on the
  same card, where the demo relayer pays the fee, or the CLI from a clone. The page never asks the user to move money
  and shows no payment address or payment QR code; `tests/wallet-scan.test.ts` checks the wallet claim text in both
  languages for such requests.
- Tested in `tests/wallet-scan.test.ts` (coins on the 25th receive address, on the change path, across a gap, behind
  a full gap, the scan cap, a wallet without change keys, token-only coins, batching) and `e2e/wallet-scan.spec.ts`
  (WebKit iPhone 13 and Chromium, a stub wallet and a fake Electrum server).
