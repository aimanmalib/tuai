# 0009: A chipnet demo relayer behind a Claim button

Status: accepted, 2026-11-18

## Context

The claim page (ADR 0007) checks an address against the epoch files and the chain, then shows the CLI command that
claims for it. A reviewer who wants to see a claim happen needs a clone of the repository, Node, and a funded
chipnet key. A browser wallet connection would also need a chipnet wallet, and the wallet connection libraries we
measured on 2026-11-18 carry no license field and require a pre-release of `@bitauth/libauth`, which this repository
pins to 3.0.0.

A claim does not need the leaf owner's signature (ADR 0002): anyone may fund it, and the contract requires the
reward tokens to go to the leaf's own locking bytecode in the amount `cumulative - claimed`. So a third party can
pay the fee and dust for a claim without being able to change where the tokens go.

## Decision

1. **A small relayer pays fee and dust on chipnet.** `src/relay/` is a `node:http` service with two routes:
   `GET /api/relay/status` (network, on or off with a named reason, balance, claims left, hourly use) and
   `POST /api/relay/claim {address, again?}`. It finds the leaf in the epoch file that holds the pool's active root,
   reads the pool and receipts from Electrum, and plans the claim with `src/tx/claim.ts`, funded by its own key. The
   relayer receives only its own BCH change.
2. **What it cannot do.** The contracts (`ClaimPool`, `PoolVault`) decide where tokens go; the relayer only adds a
   funding input and a change output. As a second check, before anything is sent, every output must pay the leaf,
   the pool contract, the vault contract or the relayer; reward tokens must reach the leaf in exactly
   `cumulative - claimed` (computed independently from the receipts); no tokens may go to the relayer; and the fee
   must not exceed `relay.maxFeeSatsPerClaim`. A plan that fails any of these is refused without a broadcast.
3. **Chipnet only.** The network is a constant in code (`RELAY_NETWORK`), and `relay.networks` must be exactly
   `["chipnet"]`; config validation and `createRelay` both refuse anything else. The relay key file records its
   network, and a key made for another network is refused. Coins on chipnet have no value, so a public button is
   acceptable there. On mainnet the claimant's own wallet (or anyone the claimant asks) pays, as with the CLI.
4. **Its own key, and only that key.** `tuai relay-key --network chipnet` writes a new key (mode 0600, never
   overwritten) and prints only its address. The relay container receives that one file through a read-only mount;
   it is never copied into an image. Operator, payer and mainnet keys never enter any container. The process does
   not start without the key file.
5. **Limits from config.** `maxClaimsPerHour` is global, because a client address seen behind the CDN and the proxy
   cannot be trusted without more infrastructure than a demo needs. One claim is planned and sent at a time
   (in-process queue), so two requests never spend the same pool or relayer outputs. Bodies over `maxBodyBytes`
   are refused (413). Below `minBalanceSats` the status reports `lowBalance` and the page shows the CLI command
   instead of the button.
6. **Claim again.** For an already claimed leaf, `again: true` plans the double claim that `tuai demo double-claim`
   uses (the leaf's receipt is hidden, so a duplicate receipt is inserted). It is sent only if local evaluation
   refuses it; the page then shows both the local refusal and the node's refusal.
7. **Switch off.** `TUAI_RELAY_OFF=1` in the host settings and a redeploy stop the container; nginx answers the
   status route with `enabled: false` when the relayer is not running, and the page shows the CLI command.

## Consequences

- A reviewer can claim from the page with no wallet; the transaction appears on the activity page from the pool's
  chain history, and the receipt and amounts on the address card update from the chain.
- The relayer is a single process with a small balance; when it is empty or busy the page says so and falls back to
  the CLI command. Nothing about the claim rules depends on it.
- Synthetic demo leaves have no known key; claiming one moves test tokens to an address nobody can spend from,
  which is acceptable on chipnet and shows that the claimant does not have to be the leaf owner.
