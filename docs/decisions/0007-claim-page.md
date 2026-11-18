# 0007: Static claim page that checks proofs in the browser

Status: accepted

## Context

The bounty lists a proof-serving endpoint and a simple claim interface as optional infrastructure. A recipient
needs to see what they can claim, and should not have to trust the server that shows it.

## Decision

- `web/` is a static Vite page. The build copies the committed `deployments/<network>/` files (pool record, epoch
  files, input files) to `/epochs/<network>/`, plus an `index.json` listing the epochs. These static files are the
  proof-serving endpoint; there is no server code.
- The page reads chain state itself over an Electrum WebSocket (`networks.<n>.electrum.wssUrl` in
  `config/tuai.json`): the pool state NFT (active root and epoch), the gate's pending-root NFT and the vault receipts.
  It uses three read-only calls (`server.version`, `blockchain.headers.get_tip`,
  `blockchain.address.listunspent` with `include_tokens`) and never holds keys.
- For an address it finds the leaf, recomputes the root level by level with the same leaf and node hashing as the
  contracts (`src/leaf.ts`, `src/merkle/tree.ts`), and compares it with both the file root and the root the pool
  holds. A difference is shown as a named "Root mismatch" warning and the "will pay" confirmation is withheld.
  Claimed amounts come from the receipt in the vault, not from the file.
- Claiming is done with the CLI command the page shows. A wallet-signed claim from the page is a separate step.
- Text lives in the `web` section of `lang/en.json` and `lang/ms.json`; the chosen language is kept in local
  storage.

## Alternatives rejected

- An API that returns proofs: it would need a server and its answers would still have to be checked, so the page
  checks static files instead.
- Reading chain state through a third-party REST indexer: Electrum is what the CLI already uses, and Fulcrum servers
  return token data directly.

## Tests

`tests/web-model.test.ts` (address forms, proof path, receipts, root mismatch, pending root), `tests/web-epochs.test.ts`
(served files), and `e2e/claim.spec.ts` on WebKit (iPhone 13) and Chromium against a fake Electrum server: result and
proof, named mismatch warning, pending root and Malay text, errors, no overflow at 320 px, axe WCAG 2.1 AA, no console
errors.
