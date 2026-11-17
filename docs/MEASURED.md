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

## Chipnet

No transactions yet.
