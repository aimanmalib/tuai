# Measured

Facts measured on live systems, with times in UTC. Failures are recorded too.

## Sponsor distribution API

| When (UTC) | Query | Result |
|---|---|---|
| 2026-11-17 15:15:32 | `GET https://api.folding.cash/v1/GetDistro?startDate=2026-10-01T00:00:00Z&endDate=2026-11-01T00:00:00Z&amount=1000&includeFoldingUserTypes=8` | HTTP 200 in 0.9 s; `distroCount` 1, `totalPoints` 2,589,653, `totalWorkUnits` 18, `totalDistro` 1000; response SHA-256 `f7f256ebea85619177301032531be30506b654329062b53db0f6af57de4334d4` |

The response is kept byte for byte in `tests/fixtures/getdistro-2026-10-type8.json` and as the input of the epoch
built from it, [`deployments/fixtures/sponsor-2026-10/epoch-1.json`](../deployments/fixtures/sponsor-2026-10/epoch-1.json)
(1 leaf, root `f05d409f6a7ba2399ed0379dbeff085dd96dfaa811aa0dac61292e8976881402`, inputs hash
`b4a2269ac502285504406ef66fc194330198847f606ea1b62283043f286e98cc`). For October 2026 the sponsor's own
distribution query (folding user type 8) has one recipient, so the chipnet demonstration adds project demo keys and
synthetic leaves to reach at least 300 leaves.

Rebuild and check it with `npx tsx bin/tuai.ts epoch verify deployments/fixtures/sponsor-2026-10/epoch-1.json`.

## Chipnet

No transactions yet.
