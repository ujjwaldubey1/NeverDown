# Acme Portfolio Reader

Demo dApp for the video **“new user installs the SDK.”**

Acme keeps **one RPC URL**. Without NeverDown, an outage breaks the portfolio reader. With NeverDown, that URL is the gateway `/rpc` — primary failure fails over inside the gateway while the dApp URL stays the same. `@neverdown/sdk` monitors the failure spot and can optionally run policy-gated procure (discover → ENS → PoC → x402 → install-standby). The SDK does **not** proxy every JSON-RPC response.

Spend keys never live in this app. `NeverDown.create` rejects host spend keys; payments use `PAYMENT_WORKER_ENV_FILE` (mode `0600`) only.

## Install story (video order)

### 1. Open this example

From a clone of NeverDown:

```bash
cd examples/acme-dapp
```

Or scaffold against the published package in a fresh folder (after npm release):

```bash
npm create vite@latest acme-portfolio -- --template vanilla
# then copy this example’s server + public UI, or keep using the monorepo example below
```

### 2. Install `@neverdown/sdk`

**Preferred (npm):**

```bash
npm i @neverdown/sdk
```

**Monorepo fallback** (this repo):

```bash
# from repository root
pnpm install
pnpm --filter @neverdown/core build
pnpm --filter @neverdown/sdk build
```

The example depends on `@neverdown/sdk` via the workspace. External apps should use the npm package.

### 3. Copy host env (no spend keys)

```bash
cp ../../packages/sdk/env.host.example .env.host
# or: cp .env.example .env   (then fill values — still no HEDERA_*_KEY in the host file)
```

Required for SDK rails: `ENS_RPC_URL`, `ENS_ALLOWLIST_NAMES`.  
Procure also needs `POC_REFERENCE_RPC`, Arkiv read access, `GATEWAY_URL`, `GATEWAY_INTERNAL_TOKEN`, and `PAYMENT_WORKER_ENV_FILE` pointing at a **separate** mode-`0600` worker file that holds spend keys.

### 4. Run NeverDown gateway (or outage-lab) with two Sepolia RPCs

In the repo root `.env`:

```bash
GATEWAY_PRIMARY_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
GATEWAY_STANDBY_RPC_URL=https://0xrpc.io/sep
```

Use two **different** working Sepolia HTTPS endpoints (publicnode + 0xrpc are a known-good pair). Identical URLs are rejected by the gateway.

Then either:

```bash
pnpm gateway:live
```

or the demo lab with a killable primary (recommended for the video):

```bash
pnpm outage-lab
```

`outage-lab` prints the stable gateway RPC URL and a control API (`POST /kill-primary`).

### 5. Point the dApp at the gateway

```bash
export RPC_URL=http://127.0.0.1:8787/rpc
export GATEWAY_URL=http://127.0.0.1:8787
export DIRECT_RPC_URL=<any public Sepolia HTTPS RPC>
export OUTAGE_LAB_URL=http://127.0.0.1:8790
```

### 6. Start the UI

From repo root:

```bash
pnpm acme-demo
```

Or:

```bash
pnpm --filter @neverdown/acme-dapp-example dev
```

Open **http://127.0.0.1:3200**.

### 7. Demo on camera

1. **Without NeverDown** — select **Direct upstream** → **Simulate outage** → status **DOWN** / “dApp broken”.
2. **With NeverDown** — select **NeverDown gateway** → **Simulate outage** → status stays **OK** on the **same** `…/rpc` URL; log shows `failover — URL unchanged`.
3. **Optional** — **Deny bad seller**, **Optional procure** (SETTLED + HashScan only; no entitlement token), **Show create() rejects spend key**.

Shot list: [DEMO-VIDEO.md](./DEMO-VIDEO.md).

## What this app uses from the SDK

| Import | Role |
|---|---|
| `FailureSpotMonitor` from `@neverdown/sdk` | Probe gateway RPC / emit incident |
| `getGatewayStatus` from `@neverdown/sdk/status` | Read-only active provider / routing mode |
| `NeverDown.create` / `procure` | Optional policy-gated standby purchase |
| `evidenceLinks` from `@neverdown/sdk/status` | HashScan URL for redacted receipt |

## Modes

| Mode | RPC | Outage | Expected |
|---|---|---|---|
| A — Direct upstream | `DIRECT_RPC_URL` | Local simulate flag | UI red, reads fail |
| B — NeverDown gateway | `RPC_URL` → gateway `/rpc` | `outage-lab` kill-primary | Same URL keeps serving after failover |

## Security reminders

- Do not commit `.env` or private keys.
- Do not put `HEDERA_SPEND_KEY` / `HEDERA_OPERATOR_KEY` in the host process.
- Browser never imports the SDK spend path — only this Node UI server does.
