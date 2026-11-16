# Acme Portfolio Reader — demo video shot list

Target length: ≤5 minutes. Story: **new user installs `@neverdown/sdk`**.

## Prep (off camera)

1. Root `.env` has two different Sepolia RPCs for gateway primary/standby.
2. Terminal A: `pnpm outage-lab` → note `http://127.0.0.1:8787/rpc`.
3. Terminal B: `pnpm acme-demo` → open `http://127.0.0.1:3200`.
4. Optional procure: host env from `packages/sdk/env.host.example` + mode-`0600` `PAYMENT_WORKER_ENV_FILE` (never show its contents on camera).

## Shots

| # | On screen | Click / say | Expected result |
|---|---|---|---|
| 1 | README install steps (or terminal) | Narrate: npm i `@neverdown/sdk`, copy `env.host.example`, run outage-lab, set `RPC_URL`, `pnpm acme-demo` | Fresh-clone path is believable |
| 2 | UI hero + labels | Point at labels: Stable gateway RPC · Live failover · SDK monitor · Optional procure · Deny-before-sign | Brand the product before the outage |
| 3 | **Direct upstream** selected | Click **Direct upstream** | RPC URL shows public Sepolia; status OK with chainId/block |
| 4 | Mode A outage | Click **Simulate outage** | Live status **DOWN** · error text · “dApp broken” · fake balance fails · red plane |
| 5 | Mode A restore | Click **Restore** | Status returns **OK** |
| 6 | Switch to gateway | Click **NeverDown gateway** | RPC URL = `http://127.0.0.1:8787/rpc` · SDK pill ready · gateway active=primary |
| 7 | Mode B healthy | Hold on metrics 2–3s | chainId `0xaa36a7` (Sepolia) · block ticking · latency |
| 8 | Mode B outage / failover | Click **Simulate outage** | Within a few seconds: status stays **OK** · **same** gateway URL · log `failover — URL unchanged` · gateway active → standby · routingMode failover |
| 9 | SDK monitor | Point at event log / SDK pill | Monitor noted the failure spot; dApp did not change RPC URL |
| 10 | Deny-before-sign | Click **Deny bad seller** | Alert/log: rejected spoofed payTo · no signing |
| 11 | Spend-key boundary | Click **Show create() rejects spend key** | `HEDERA_SPEND_KEY must stay in the payment worker env file` |
| 12 | Optional procure | Click **Optional procure** | Receipt **SETTLED** (or DENIED with reason) · HashScan link only · never show entitlement token or keys |
| 13 | Close | Same gateway URL still in the RPC field | “URL unchanged through failover + optional procure” |

## Before / after (say this)

- **Before (Mode A):** outage → portfolio reader dies on the hard-coded RPC.
- **After (Mode B):** same outage against the NeverDown gateway → reader keeps `eth_chainId` / `eth_blockNumber` on the **identical** `/rpc` URL while the fast plane fails over.

## Do not show

- Contents of `PAYMENT_WORKER_ENV_FILE`
- Hedera private keys
- Entitlement tokens
- Rebuilding gateway/core inside the dApp
