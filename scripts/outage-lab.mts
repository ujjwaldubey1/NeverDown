/**
 * Long-running outage lab for demo video / Acme dApp.
 * Wraps the configured primary Sepolia RPC behind a killable proxy, then
 * starts the NeverDown gateway with primary=proxy and standby=real standby.
 *
 * Control plane (localhost only):
 *   POST /kill-primary   → primary starts returning 503
 *   POST /restore-primary
 *   GET  /status
 *
 * dApp keeps ONE URL: http://127.0.0.1:<gateway>/rpc
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createGatewayApp } from "../apps/gateway/src/app.js";
import { loadGatewayConfig } from "../apps/gateway/src/config.js";

const CONTROL_PORT = Number(process.env.OUTAGE_LAB_CONTROL_PORT ?? 8790);
const GATEWAY_PORT = Number(process.env.OUTAGE_LAB_GATEWAY_PORT ?? process.env.GATEWAY_PORT ?? 8787);

function listen(server: Server, port: number, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(`http://${host}:${port}`));
  });
}

function listenEphemeral(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no TCP address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const configured = loadGatewayConfig(process.env);
  const primary = configured.providers.find((p) => p.id === "primary");
  const standby = configured.providers.find((p) => p.id === "standby");
  if (!primary || !standby) {
    throw new Error("Set GATEWAY_PRIMARY_RPC_URL and GATEWAY_STANDBY_RPC_URL to two different Sepolia RPCs");
  }

  let primaryFailed = false;
  const proxy = createServer(async (request, response) => {
    if (primaryFailed) {
      // Hard fail so gateway health marks primary unhealthy and fails over.
      response.destroy();
      return;
    }
    try {
      const body = await readBody(request);
      const upstream = await fetch(primary.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(6_000),
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502);
      response.end();
    }
  });

  const proxyUrl = await listenEphemeral(proxy);

  const config = {
    ...configured,
    port: GATEWAY_PORT,
    providers: [{ id: "primary", url: proxyUrl }, standby],
    healthIntervalMs: Math.min(configured.healthIntervalMs, 1000),
    failureThreshold: Math.min(configured.failureThreshold, 2),
    recoveryThreshold: Math.min(configured.recoveryThreshold, 2),
    failoverCooldownMs: 0,
  };

  const { app, controller } = createGatewayApp({ config });
  controller.start();
  const gateway = createServer(app);
  const gatewayUrl = await listen(gateway, GATEWAY_PORT);

  const control = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${CONTROL_PORT}`);
    if (req.method === "GET" && url.pathname === "/status") {
      sendJson(res, 200, {
        primaryFailed,
        proxyUrl,
        gatewayUrl,
        gatewayRpc: `${gatewayUrl}/rpc`,
        active: controller.activeProvider(),
        routingMode: controller.snapshot().routingMode,
        providers: controller.snapshot().providers,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/kill-primary") {
      primaryFailed = true;
      sendJson(res, 200, { ok: true, primaryFailed, note: "gateway URL unchanged — wait for live failover" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/restore-primary") {
      primaryFailed = false;
      sendJson(res, 200, { ok: true, primaryFailed });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  const controlUrl = await listen(control, CONTROL_PORT);

  console.log("outage-lab ready");
  console.log(`  gateway RPC (dApp URL): ${gatewayUrl}/rpc`);
  console.log(`  control:                ${controlUrl}`);
  console.log("  POST /kill-primary      → inject primary outage");
  console.log("  POST /restore-primary   → heal primary");
  console.log("  GET  /status");
  console.log(`  Set ACME RPC_URL=${gatewayUrl}/rpc`);

  const shutdown = () => {
    controller.stop();
    control.close();
    gateway.close();
    proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
