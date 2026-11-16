const els = {
  modeDirect: document.getElementById("modeDirect"),
  modeGateway: document.getElementById("modeGateway"),
  rpcUrl: document.getElementById("rpcUrl"),
  statusPlane: document.getElementById("statusPlane"),
  healthValue: document.getElementById("healthValue"),
  healthSub: document.getElementById("healthSub"),
  chainId: document.getElementById("chainId"),
  blockNumber: document.getElementById("blockNumber"),
  latency: document.getElementById("latency"),
  errorText: document.getElementById("errorText"),
  balance: document.getElementById("balance"),
  gatewayActive: document.getElementById("gatewayActive"),
  eventLog: document.getElementById("eventLog"),
  sdkPill: document.getElementById("sdkPill"),
  actionHint: document.getElementById("actionHint"),
  evidence: document.getElementById("evidence"),
  evidenceStatus: document.getElementById("evidenceStatus"),
  hashscanLink: document.getElementById("hashscanLink"),
};

let mode = "direct";

function hexToInt(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) return value;
  try { return BigInt(value).toString(); } catch { return value; }
}

function setModeButtons() {
  els.modeDirect.classList.toggle("is-active", mode === "direct");
  els.modeGateway.classList.toggle("is-active", mode === "gateway");
  els.actionHint.textContent = mode === "direct"
    ? "Mode A: Simulate outage → UI goes DOWN / dApp broken. No SDK, no gateway."
    : "Mode B: Simulate outage kills primary via outage-lab. Same gateway URL should stay OK after failover.";
}

async function post(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.hint || `HTTP ${response.status}`);
  return data;
}

function renderStatus(data) {
  mode = data.mode;
  setModeButtons();
  els.rpcUrl.textContent = data.rpcUrl;
  els.statusPlane.dataset.health = data.health;
  els.healthValue.textContent = data.health;
  const probe = data.lastProbe;
  if (probe?.ok) {
    els.healthSub.textContent = mode === "gateway" && data.gateway?.status?.routingMode === "failover"
      ? "failover — URL unchanged · still serving"
      : "reads succeeding";
  } else if (data.health === "DOWN") {
    els.healthSub.textContent = mode === "direct" ? "dApp broken — direct RPC outage" : (probe?.error || "RPC down");
  } else {
    els.healthSub.textContent = probe?.error || "degraded";
  }

  els.chainId.textContent = probe?.chainId ?? "—";
  els.blockNumber.textContent = probe?.blockNumber ? hexToInt(probe.blockNumber) : "—";
  els.latency.textContent = probe?.latencyMs != null ? `${probe.latencyMs} ms` : "—";
  els.errorText.textContent = probe?.error || "—";
  els.balance.textContent = probe?.balance ? hexToInt(probe.balance) : (mode === "gateway" ? "n/a on gateway allowlist" : "—");
  els.gatewayActive.textContent = data.gateway?.status?.active
    ? `${data.gateway.status.active} · ${data.gateway.status.routingMode || "?"}`
    : (mode === "gateway" ? "…" : "n/a");

  if (data.sdkReady) {
    els.sdkPill.textContent = "SDK monitor ready";
    els.sdkPill.className = "pill ok";
  } else {
    els.sdkPill.textContent = data.sdkError ? `SDK host: ${data.sdkError}` : "SDK offline";
    els.sdkPill.className = "pill bad";
  }

  els.eventLog.replaceChildren();
  for (const entry of data.log || []) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = entry.at.replace("T", " ").replace("Z", " UTC");
    const msg = document.createElement("span");
    msg.textContent = entry.message;
    if (entry.level === "ok") msg.style.color = "var(--ok)";
    if (entry.level === "error") msg.style.color = "var(--bad)";
    if (entry.level === "warn") msg.style.color = "var(--warn)";
    li.append(time, msg);
    els.eventLog.append(li);
  }
}

async function refresh() {
  const data = await fetch("/api/status").then((r) => r.json());
  renderStatus(data);
}

async function setMode(next) {
  await post("/api/mode", { mode: next });
  await refresh();
}

els.modeDirect.addEventListener("click", () => { void setMode("direct"); });
els.modeGateway.addEventListener("click", () => { void setMode("gateway"); });

document.getElementById("btnOutage").addEventListener("click", async () => {
  try {
    await post("/api/outage", { action: "kill" });
    await refresh();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
});

document.getElementById("btnRestore").addEventListener("click", async () => {
  try {
    await post("/api/outage", { action: "restore" });
    await refresh();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
});

document.getElementById("btnDeny").addEventListener("click", async () => {
  try {
    const data = await post("/api/deny");
    alert(data.denied ? `Denied: ${data.detail}` : "Unexpected accept");
    await refresh();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
});

document.getElementById("btnProcure").addEventListener("click", async () => {
  try {
    const data = await post("/api/procure");
    els.evidence.hidden = false;
    els.evidenceStatus.textContent = `${data.receipt.status} · installed=${data.receipt.installed}`
      + (data.receipt.denyReason ? ` · ${data.receipt.denyReason}` : "");
    if (data.hashscan) {
      els.hashscanLink.href = data.hashscan;
      els.hashscanLink.hidden = false;
    } else {
      els.hashscanLink.hidden = true;
    }
    await refresh();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
});

document.getElementById("btnRejectKey").addEventListener("click", async () => {
  try {
    const data = await post("/api/reject-spend-key-demo");
    alert(data.rejected ? data.detail : "Did not reject");
    await refresh();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
});

fetch("/api/bootstrap")
  .then((r) => r.json())
  .then((boot) => {
    mode = boot.mode;
    setModeButtons();
    els.rpcUrl.textContent = boot.mode === "gateway" ? boot.gatewayRpc : boot.directRpc;
  })
  .catch(() => undefined);

void refresh();
setInterval(() => { void refresh(); }, 1200);
