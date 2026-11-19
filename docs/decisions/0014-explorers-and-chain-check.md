# 0014. Named explorer list and an on-chain check on the activity page

Status: accepted, 19 Nov 2026

## Context

The activity page links every recorded transaction to one block explorer (`networks.<net>.explorerTxUrl`). A link
is only as good as the explorer behind it: when that explorer cannot show a transaction, a reader has no way to tell
from the page whether the transaction exists. Public chipnet explorers come and go.

Measured on 19 Nov 2026 around 09:40 UTC with WebKit, one page load per candidate, for the deploy transaction
`6356165de951e6a7e4765151250eec97d853a368da5d11106865307a9ef40cec` and the page claim
`2b6a7acc0963b14c0a227014eca58bf0c9b931dd9c26f90d6ce808111d582a9f`:

| Candidate | Result |
|---|---|
| `cbch.loping.net/tx/` (the configured explorer) | page loads, "Failed to load transaction"; its block list also fails to read the node |
| `tbch.loping.net/tx/` | testnet3, not chipnet; "Failed to load transaction" |
| `explorer.salemkode.com/chipnet/tx/` and `/tx/` | "Page not found" / "This transaction is not found"; its settings offer no chipnet |
| `chipnet.imaginary.cash/tx/` | navigation cancelled, no page |
| `chipnet.chaingraph.cash/tx/` | HTTP 403 |
| `chipnet.bch.ninja/tx/` | HTTP 404 (Electrum host, not an explorer) |

At the same time the chipnet Electrum server the page already uses (`chipnet.bch.ninja`) answered a verbose
`blockchain.transaction.get` for the deploy transaction with 1993 confirmations at tip 338001, which is block 336009,
the block in the record.

## Decision

1. `networks.<net>.explorers` is a list of `{ "name", "txUrl" }`, primary first (`src/explorers.ts`). The page, the
   activity index and the Markdown reports link each transaction to every explorer by name. A network without the
   list reads its older `explorerTxUrl` as one explorer named after its host, so records written before the list
   stay valid; with one explorer the generated MEASURED tables are unchanged. Chipnet lists one explorer today,
   because no second candidate showed the transactions; adding one is a config change.
2. The activity page checks every listed transaction on chain itself (`web/src/chain-check.ts`,
   `checkOnChain` in `web/src/electrum.ts`): one WebSocket to the configured Electrum server, the tip, then a verbose
   `blockchain.transaction.get` per txid, at most `web.chainCheckConcurrency` in flight. Under each transaction it
   shows one of:
   - "Confirmed on chain, block N (checked by this page via <server>)": only when the server answered for the same
     txid with a positive confirmation count that fits the tip; N is the tip minus the confirmations plus one;
   - "Not in a block yet": the server has it without confirmations;
   - "Could not check": the server does not know the transaction, fails the request, or cannot be reached.
   A failure never shows as confirmed, and no txid is written in `web/src`: the list comes from `deployments/` and the
   pool history.

## Consequences

- A reader can confirm each step without leaving the page, through a server they can change in the config, and
  still open any explorer that works.
- The check trusts the Electrum server's answer; it does not verify a Merkle branch against headers. The server is
  named on every badge so the reader knows whom the page asked.
- Undo: remove `explorers` from the config (the page falls back to `explorerTxUrl`); the check is one call in
  `web/src/activity-page.ts`.
