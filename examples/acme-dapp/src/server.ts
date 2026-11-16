/**
 * Acme Portfolio Reader — demo dApp for “new user installs the SDK.”
 *
 * Mode A: direct / flaky RPC (no SDK, no gateway) → outage breaks the UI.
 * Mode B: ONE NeverDown gateway /rpc URL + @neverdown/sdk monitor → outage survives.
 *
 * Spend keys never enter this process; NeverDown.create rejects host spend keys.
 * SDK runs server-side only — the browser only talks to this UI server.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FailureSpotMonitor, NeverDown } from "@neverdown/sdk";
import { evidenceLinks, getGatewayStatus } from "@neverdown/sdk/status";
import type { CapabilityOfferRow } from "@neverdown/sdk";

const PORT = Number(process.env.ACME_PORT ?? 3200);
const POLL_MS = Math.max(800, Number(process.env.POLL_INTERVAL_MS ?? 1500));
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

type RpcMode = "direct" | "gateway";
type HealthState = "OK" | "DOWN" | "DEGRADED";

type LogEntry = { at: string; level: "info" | "warn" | "error" | "ok"; message: string };
type ProbeResult = {
  ok: boolean;
  chainId: string | null;
  blockNumber: string | null;
  balance: string | null;
  latencyMs: number | null;
  error: string | null;
  rpcUrl: string;
  mode: RpcMode;
};

const state = {
  mode: (process.env.ACME_MODE === "gateway" ? "gateway" : "direct") as RpcMode,
  directOutage: false,
  lastProbe: null as ProbeResult | null,
  health: "DEGRADED" as HealthState,
  consecutiveOk: 0,
  consecutiveFail: 0,
  log: [] as LogEntry[],
  lastActiveProvider: null as string | null,
  monitorIncident: null as { incidentId: string; reason: string; occurredAt: string } | null,
  sdkReady: false,
  sdkError: null as string | null,
};

const DIRECT_UPSTREAM = (process.env.DIRECT_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com").replace(/\/+$/, "");
const GATEWAY_BASE = (process.env.GATEWAY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const GATEWAY_RPC = (process.env.RPC_URL || `${GATEWAY_BASE}/rpc`).replace(/\/+$/, "");
const OUTAGE_LAB = (process.env.OUTAGE_LAB_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
const DEMO_ADDRESS = "0x0000000000000000000000000000000000000001";

function pushLog(level: LogEntry["level"], message: string): void {
  state.log.unshift({ at: new Date().toISOString(), level, message });
  if (state.log.length > 80) state.log.length = 80;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<{ result?: unknown; error?: unknown; latencyMs: number }> {
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const latencyMs = Date.now() - started;
  const data = await response.json() as { result?: unknown; error?: unknown };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (data.error) throw new Error(typeof data.error === "object" && data.error && "message" in data.error
    ? String((data.error as { message: unknown }).message)
    : "rpc error");
  return { ...data, latencyMs };
}

/** Mode A flaky upstream: when directOutage is set, every call fails. */
async function callDirect(method: string, params: unknown[] = []): Promise<{ result?: unknown; latencyMs: number }> {
  if (state.directOutage) throw new Error("primary RPC outage (simulated) — dApp broken");
  return jsonRpc(DIRECT_UPSTREAM, method, params);
}

async function callActive(method: string, params: unknown[] = []): Promise<{ result?: unknown; latencyMs: number }> {
  if (state.mode === "direct") return callDirect(method, params);
  return jsonRpc(GATEWAY_RPC, method, params);
}

async function probeOnce(): Promise<ProbeResult> {
  const rpcUrl = state.mode === "gateway" ? GATEWAY_RPC : DIRECT_UPSTREAM;
  const started = Date.now();
  try {
    const chain = await callActive("eth_chainId");
    const block = await callActive("eth_blockNumber");
    let balance: string | null = null;
    try {
      const bal = await callActive("eth_getBalance", [DEMO_ADDRESS, "latest"]);
      balance = typeof bal.result === "string" ? bal.result : null;
    } catch {
      // Gateway may only allow chainId/blockNumber/net_version — balance is optional demo.
      balance = null;
    }
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      chainId: typeof chain.result === "string" ? chain.result : null,
      blockNumber: typeof block.result === "string" ? block.result : null,
      balance,
      latencyMs,
      error: null,
      rpcUrl,
      mode: state.mode,
    };
  } catch (error) {
    return {
      ok: false,
      chainId: null,
      blockNumber: null,
      balance: null,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      rpcUrl,
      mode: state.mode,
    };
  }
}

function updateHealth(probe: ProbeResult): void {
  state.lastProbe = probe;
  if (probe.ok) {
    state.consecutiveOk += 1;
    state.consecutiveFail = 0;
    state.health = state.mode === "gateway" && state.lastActiveProvider && state.lastActiveProvider !== "primary"
      ? "OK"
      : "OK";
    monitor?.reportHealthy("acme-rpc");
  } else {
    state.consecutiveFail += 1;
    state.consecutiveOk = 0;
    state.health = state.consecutiveFail >= 2 ? "DOWN" : "DEGRADED";
    void monitor?.reportFailure("acme-rpc", probe.error || "rpc probe failed").catch(() => undefined);
  }
}

let monitor: FailureSpotMonitor | null = null;

function ensureMonitor(): void {
  if (monitor) return;
  monitor = new FailureSpotMonitor();
  monitor.register({
    id: "acme-rpc",
    failureThreshold: 2,
    probe: async () => {
      if (state.mode !== "gateway") return true;
      const probe = await probeOnce();
      return probe.ok;
    },
    onIncident: async (incident) => {
      state.monitorIncident = {
        incidentId: incident.incidentId,
        reason: incident.reason,
        occurredAt: incident.occurredAt,
      };
      pushLog("warn", `SDK monitor incident · ${incident.incidentId} · ${incident.reason}`);
    },
    onError: (error) => pushLog("error", `SDK monitor error · ${error.message}`),
  });
  monitor.start(POLL_MS);
  pushLog("info", "SDK FailureSpotMonitor started (gateway RPC probe)");
}

function hostEnvForSdk(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ENS_RPC_URL: process.env.ENS_RPC_URL,
    ENS_ALLOWLIST_NAMES: process.env.ENS_ALLOWLIST_NAMES,
    POC_REFERENCE_RPC: process.env.POC_REFERENCE_RPC,
    ARKIV_ACCESS_KEY: process.env.ARKIV_ACCESS_KEY,
    ARKIV_CHAIN_ID: process.env.ARKIV_CHAIN_ID,
    ARKIV_RPC: process.env.ARKIV_RPC,
    PAYMENT_WORKER_ENV_FILE: process.env.PAYMENT_WORKER_ENV_FILE,
    GATEWAY_URL: GATEWAY_BASE,
    GATEWAY_INTERNAL_TOKEN: process.env.GATEWAY_INTERNAL_TOKEN,
  };
  // Explicitly drop forbidden keys even if the launcher leaked them.
  delete env.HEDERA_SPEND_KEY;
  delete env.HEDERA_OPERATOR_KEY;
  delete env.ARKIV_PRIVATE_KEY;
  delete env.RECLAIM_PRIVATE_KEY;
  return env;
}

function tryCreateSdk(): NeverDown | null {
  try {
    const nd = NeverDown.create({ env: hostEnvForSdk() });
    state.sdkReady = true;
    state.sdkError = null;
    return nd;
  } catch (error) {
    state.sdkReady = false;
    state.sdkError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function serializeOffer(offer: CapabilityOfferRow) {
  return {
    entityKey: offer.entityKey,
    sellerens: offer.sellerens,
    serviceurl: offer.serviceurl,
    payto: offer.payto,
    pricetinybars: offer.pricetinybars.toString(),
    chainid: offer.chainid.toString(),
    category: offer.category,
  };
}

async function findOffer(nd: NeverDown) {
  const ensName = process.env.SELLER_ENS_NAME?.trim();
  const payTo = process.env.HEDERA_MERCHANT_ACCOUNT_ID?.trim();
  if (!ensName || !payTo) throw new Error("SELLER_ENS_NAME and HEDERA_MERCHANT_ACCOUNT_ID required for procure");
  const seller = await nd.resolveSeller({ ensName, expectedPayTo: payTo });
  const maxPrice = process.env.HEDERA_X402_PRICE_SMALLEST_UNITS || "10000";
  const offers = await nd.discoverOffers({ category: "rpc", maxPriceTinybars: maxPrice, allowedPayTo: [payTo] });
  const x402 = seller.records.x402Url?.replace(/\/+$/, "");
  const offer = offers.find((row) => row.sellerens.toLowerCase() === ensName.toLowerCase() && row.serviceurl === x402);
  if (!offer) throw new Error("No Arkiv offer matches verified ENS seller");
  return { seller, offer };
}

function redactReceipt(receipt: Awaited<ReturnType<NeverDown["procure"]>>) {
  return {
    status: receipt.status,
    installed: receipt.installed,
    purchaseId: receipt.purchaseId,
    transactionId: receipt.transactionId,
    hashscanUrl: receipt.hashscanUrl,
    auditStatus: receipt.auditStatus,
    denyReason: receipt.denyReason,
    installError: receipt.installError,
  };
}

async function refreshGatewayHints(): Promise<void> {
  if (state.mode !== "gateway") return;
  try {
    const snap = await getGatewayStatus(GATEWAY_BASE);
    const active = snap.status.active;
    if (active && state.lastActiveProvider && state.lastActiveProvider !== active) {
      pushLog("ok", `failover — URL unchanged (${GATEWAY_RPC}) · active ${state.lastActiveProvider} → ${active}`);
    }
    state.lastActiveProvider = active;
    if (snap.status.routingMode === "failover" && state.health === "OK") {
      // Keep OK: same gateway URL still serving.
    }
  } catch {
    /* gateway status optional while RPC still works */
  }
}

async function tick(): Promise<void> {
  const probe = await probeOnce();
  const prev = state.health;
  updateHealth(probe);
  await refreshGatewayHints();
  if (probe.ok && prev !== "OK") {
    pushLog("ok", `RPC healthy · chainId=${probe.chainId} · block=${probe.blockNumber} · ${probe.latencyMs}ms`);
  } else if (!probe.ok && prev === "OK") {
    pushLog("error", `RPC failed · ${probe.error}`);
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/bootstrap" && req.method === "GET") {
    send(res, 200, {
      product: "Acme Portfolio Reader",
      mode: state.mode,
      directRpc: DIRECT_UPSTREAM,
      gatewayRpc: GATEWAY_RPC,
      gatewayBase: GATEWAY_BASE,
      outageLab: OUTAGE_LAB,
      pollMs: POLL_MS,
      sdkPackage: "@neverdown/sdk",
      sdkReady: state.sdkReady,
      sdkError: state.sdkError,
      labels: [
        "Stable gateway RPC",
        "Live failover",
        "SDK monitor",
        "Optional policy-gated procure + evidence",
        "Deny-before-sign",
      ],
    });
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    let gateway = null;
    if (state.mode === "gateway") {
      try { gateway = await getGatewayStatus(GATEWAY_BASE); } catch { gateway = null; }
    }
    send(res, 200, {
      mode: state.mode,
      health: state.health,
      rpcUrl: state.mode === "gateway" ? GATEWAY_RPC : DIRECT_UPSTREAM,
      directOutage: state.directOutage,
      lastProbe: state.lastProbe,
      consecutiveOk: state.consecutiveOk,
      consecutiveFail: state.consecutiveFail,
      monitor: state.monitorIncident,
      monitorStatus: monitor && state.mode === "gateway" ? monitor.status("acme-rpc") : null,
      gateway,
      sdkReady: state.sdkReady,
      sdkError: state.sdkError,
      log: state.log.slice(0, 40),
    });
    return;
  }

  if (pathname === "/api/mode" && req.method === "POST") {
    const body = await readJson(req);
    const next = body.mode === "gateway" ? "gateway" : body.mode === "direct" ? "direct" : null;
    if (!next) {
      send(res, 400, { error: "mode must be 'direct' or 'gateway'" });
      return;
    }
    state.mode = next;
    state.directOutage = false;
    state.consecutiveFail = 0;
    state.consecutiveOk = 0;
    state.monitorIncident = null;
    if (next === "gateway") {
      ensureMonitor();
      pushLog("info", `RPC mode → NeverDown gateway · ${GATEWAY_RPC}`);
    } else {
      pushLog("warn", `RPC mode → Direct upstream · ${DIRECT_UPSTREAM} (no SDK, no gateway)`);
    }
    await tick();
    send(res, 200, { ok: true, mode: state.mode, health: state.health, lastProbe: state.lastProbe });
    return;
  }

  if (pathname === "/api/outage" && req.method === "POST") {
    const body = await readJson(req);
    const action = body.action === "restore" ? "restore" : "kill";

    if (state.mode === "direct") {
      state.directOutage = action === "kill";
      pushLog(
        state.directOutage ? "error" : "ok",
        state.directOutage
          ? "Simulate outage (Mode A) — direct RPC failing · dApp broken"
          : "Restore direct RPC (Mode A)",
      );
      // Two failed probes → DOWN immediately for the camera.
      await tick();
      if (state.directOutage) await tick();
      send(res, 200, { ok: true, mode: "direct", directOutage: state.directOutage, health: state.health, lastProbe: state.lastProbe });
      return;
    }

    // Mode B: kill primary via outage-lab; dApp URL stays the gateway.
    const path = action === "kill" ? "/kill-primary" : "/restore-primary";
    try {
      const response = await fetch(`${OUTAGE_LAB}${path}`, { method: "POST", signal: AbortSignal.timeout(3_000) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        send(res, 502, { error: "outage-lab rejected request", payload });
        return;
      }
      pushLog(
        action === "kill" ? "warn" : "ok",
        action === "kill"
          ? `Kill primary via outage-lab · dApp still on ${GATEWAY_RPC} (URL unchanged)`
          : "Restore primary via outage-lab",
      );
      // Wait for gateway health → failover; dApp URL must not change.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 600));
        await tick();
        await refreshGatewayHints();
        if (action === "restore" && state.lastProbe?.ok) break;
        if (action === "kill" && state.lastProbe?.ok) {
          let active: string | null = state.lastActiveProvider;
          let routing: string | null = null;
          try {
            const snap = await getGatewayStatus(GATEWAY_BASE);
            active = snap.status.active;
            routing = snap.status.routingMode ?? null;
            state.lastActiveProvider = active;
          } catch { /* ignore */ }
          if (active === "standby" || routing === "failover") {
            pushLog("ok", `failover — URL unchanged (${GATEWAY_RPC}) · active=${active} · ${routing}`);
            break;
          }
          // Request-level retry may already keep reads green before official failover.
          if (Date.now() + 700 >= deadline) {
            pushLog("ok", `failover — URL unchanged (${GATEWAY_RPC}) · still serving`);
            break;
          }
        }
      }
      send(res, 200, {
        ok: true,
        mode: "gateway",
        note: action === "kill" ? "failover — URL unchanged" : "primary restored",
        rpcUrl: GATEWAY_RPC,
        health: state.health,
        lastProbe: state.lastProbe,
        lab: payload,
      });
    } catch (error) {
      send(res, 502, {
        error: error instanceof Error ? error.message : String(error),
        hint: "Start pnpm outage-lab (two Sepolia RPCs) before Mode B outage",
      });
    }
    return;
  }

  if (pathname === "/api/deny" && req.method === "POST") {
    const nd = tryCreateSdk();
    if (!nd) {
      send(res, 412, { error: state.sdkError || "SDK host env incomplete", note: "Copy packages/sdk/env.host.example" });
      return;
    }
    const ensName = process.env.SELLER_ENS_NAME?.trim() || process.env.ENS_ALLOWLIST_NAMES?.split(/[,\s;]+/)[0];
    if (!ensName) {
      send(res, 412, { error: "SELLER_ENS_NAME required" });
      return;
    }
    try {
      await nd.resolveSeller({ ensName, expectedPayTo: "0.0.99999999" });
      send(res, 500, { denied: false, error: "unexpectedly accepted spoofed payTo" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("ok", `Deny-before-sign · rejected spoofed payTo · ${message}`);
      send(res, 200, {
        denied: true,
        detail: message,
        note: "Seller payTo mismatch fails closed before any signing",
      });
    }
    return;
  }

  if (pathname === "/api/procure" && req.method === "POST") {
    const nd = tryCreateSdk();
    if (!nd) {
      send(res, 412, { error: state.sdkError || "SDK host env incomplete" });
      return;
    }
    if (!process.env.PAYMENT_WORKER_ENV_FILE) {
      send(res, 412, {
        error: "PAYMENT_WORKER_ENV_FILE is required",
        note: "Spend keys stay in that mode-0600 worker file — never in the host",
      });
      return;
    }
    try {
      pushLog("info", "Procure started · discover → ENS → PoC → policy → x402 → install-standby");
      const { offer } = await findOffer(nd);
      const receipt = await nd.procure({
        incidentId: `acme-demo-${Date.now()}`,
        serviceId: "neverdown-rpc-pack",
        offer,
      });
      const redacted = redactReceipt(receipt);
      const links = receipt.transactionId
        ? evidenceLinks({ transactionId: receipt.transactionId, topicId: process.env.HEDERA_TOPIC_ID?.trim() })
        : null;
      if (receipt.status === "SETTLED") {
        pushLog("ok", `SETTLED · installed=${receipt.installed} · ${receipt.hashscanUrl || links?.hashscan || "no hashscan"}`);
      } else {
        pushLog("warn", `Procure ${receipt.status}${receipt.denyReason ? ` · ${receipt.denyReason}` : ""}`);
      }
      send(res, 200, {
        receipt: redacted,
        hashscan: redacted.hashscanUrl || links?.hashscan || null,
        offer: serializeOffer(offer),
        note: "Receipt is redacted — entitlement token and keys are never returned to the UI",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", `Procure failed · ${message}`);
      send(res, 500, { error: message });
    }
    return;
  }

  if (pathname === "/api/reject-spend-key-demo" && req.method === "POST") {
    try {
      NeverDown.create({
        env: {
          ENS_RPC_URL: process.env.ENS_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
          ENS_ALLOWLIST_NAMES: process.env.ENS_ALLOWLIST_NAMES || "neverdownseller.eth",
          HEDERA_SPEND_KEY: "should-never-be-here",
        },
      });
      send(res, 500, { rejected: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("ok", `NeverDown.create rejected host spend key · ${message}`);
      send(res, 200, { rejected: true, detail: message });
    }
    return;
  }

  send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    const filePath = url.pathname === "/"
      ? join(PUBLIC, "index.html")
      : join(PUBLIC, url.pathname.replace(/^\/+/, ""));
    if (!filePath.startsWith(PUBLIC) || !existsSync(filePath)) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, readFileSync(filePath), MIME[extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (!res.headersSent) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
});

tryCreateSdk();
if (state.mode === "gateway") ensureMonitor();
pushLog("info", `Acme Portfolio Reader starting · default mode=${state.mode}`);
void tick();
setInterval(() => { void tick(); }, POLL_MS).unref?.();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Acme Portfolio Reader → http://127.0.0.1:${PORT}`);
  console.log(`Mode A direct RPC: ${DIRECT_UPSTREAM}`);
  console.log(`Mode B gateway RPC: ${GATEWAY_RPC}`);
  console.log(`SDK host ready: ${state.sdkReady}${state.sdkError ? ` (${state.sdkError})` : ""}`);
});
