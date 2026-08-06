import { accessLabel, createWorkbenchSession } from "/workbench-session.js";

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const text = (value, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  const PROVIDERS = ["codex", "claude", "grok", "generic"];

  const ui = {
    shell: $("#appShell"),
    sessionState: $("#sessionState"),
    sessionButton: $("#sessionButton"),
    tierChip: $("#tierChip"),
    connectDialog: $("#connectDialog"),
    connectForm: $("#connectForm"),
    capabilityToken: $("#capabilityToken"),
    connectError: $("#connectError"),
    connectionBadge: $("#connectionBadge"),
    connectionBadgeLabel: $("#connectionBadgeLabel"),
    mcpUrl: $("#mcpUrl"),
    debugApiUrl: $("#debugApiUrl"),
    accessKey: $("#accessKey"),
    copyMcpUrl: $("#copyMcpUrl"),
    copyDebugApiUrl: $("#copyDebugApiUrl"),
    revealAccessKey: $("#revealAccessKey"),
    copyAccessKey: $("#copyAccessKey"),
    statusMessage: $("#statusMessage"),
    statusDetail: $("#statusDetail"),
    toast: $("#toast")
  };
  const store = { setupCommands: {}, accessRevealed: false };

  const session = createWorkbenchSession({
    ui,
    onConnected: ({ grantedTier }) => {
      ui.connectionBadge.dataset.tone = "positive";
      ui.connectionBadgeLabel.textContent = "Motion is ready";
      setStatus("Motion is ready for connections.", accessLabel(grantedTier));
      refreshAccessKey();
      void loadConnectionState();
    },
    onDisconnected: () => {
      ui.connectionBadge.dataset.tone = "neutral";
      ui.connectionBadgeLabel.textContent = "Waiting for access";
      store.setupCommands = {};
      store.accessRevealed = false;
      ui.mcpUrl.textContent = "—";
      ui.debugApiUrl.textContent = "—";
      ui.accessKey.textContent = maskedKey();
      setControlsEnabled(false);
      setStatus("Motion is disconnected.", "Start Motion to reconnect automatically");
    }
  });

  function setStatus(message, detail) {
    ui.statusMessage.textContent = message;
    ui.statusDetail.textContent = detail;
  }

  function setControlsEnabled(enabled) {
    ui.copyMcpUrl.disabled = !enabled;
    ui.copyDebugApiUrl.disabled = !enabled;
    ui.revealAccessKey.disabled = !enabled;
    ui.copyAccessKey.disabled = !enabled;
    document.querySelectorAll("[data-copy-provider], [data-configure-provider]").forEach((button) => {
      button.disabled = !enabled;
    });
  }

  async function loadConnectionState() {
    setStatus("Loading connection details…", "Preparing agent setup");
    const response = await fetch("/workbench/connections/state", {
      headers: { authorization: `Bearer ${session.state.token}` }
    });
    const body = object(await response.json().catch(() => ({})));
    if (!response.ok || body.ok !== true) {
      setControlsEnabled(false);
      throw new Error(text(object(body.error).message, "Motion could not load its connection details."));
    }
    store.setupCommands = object(body.setupCommands);
    ui.mcpUrl.textContent = text(body.mcpUrl, "—");
    ui.debugApiUrl.textContent = text(body.debugApiUrl, "—");
    for (const provider of PROVIDERS) {
      const command = text(store.setupCommands[provider], "Setup is unavailable in this build.");
      $(`#${provider}Command`).textContent = command;
    }
    setControlsEnabled(true);
    setStatus("Connection details ready.", "Choose an agent or copy API access");
  }

  async function configureProvider(provider, button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Configuring…";
    setStatus(`Configuring ${providerLabel(provider)}…`, "Updating the agent's user MCP settings");
    try {
      const response = await fetch("/workbench/connections/configure", {
        method: "POST",
        headers: { authorization: `Bearer ${session.state.token}`, "content-type": "application/json" },
        body: JSON.stringify({ provider })
      });
      const body = object(await response.json().catch(() => ({})));
      if (!response.ok || body.ok !== true) throw new Error(text(object(body.error).message, `${providerLabel(provider)} could not be configured.`));
      button.textContent = "Configured";
      showToast(`${providerLabel(provider)} is connected. Open a new agent session to use Motion.`);
      setStatus(`${providerLabel(provider)} configured.`, "Open a new agent session");
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      const message = error instanceof Error ? error.message : String(error);
      showToast(message, true);
      setStatus(`${providerLabel(provider)} was not configured.`, "Review the message and retry");
    }
  }

  function providerLabel(provider) {
    return provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : provider === "grok" ? "Grok" : "MCP client";
  }

  function maskedKey() {
    return "•".repeat(32);
  }

  function refreshAccessKey() {
    ui.accessKey.textContent = store.accessRevealed ? session.state.token : maskedKey();
    ui.revealAccessKey.textContent = store.accessRevealed ? "Hide" : "Reveal";
  }

  async function copyText(value, success) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const field = document.createElement("textarea");
      field.value = String(value || "");
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("Copy is unavailable in this browser. Select the value and copy it manually.");
    }
    showToast(success);
  }

  function showToast(message, danger = false) {
    ui.toast.textContent = message;
    ui.toast.style.borderLeftColor = danger ? "var(--danger)" : "var(--success)";
    ui.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { ui.toast.hidden = true; }, 4200);
  }

  session.wire();
  document.querySelectorAll("[data-copy-provider]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = button.dataset.copyProvider;
      void copyText(text(store.setupCommands[provider]), `${providerLabel(provider)} setup command copied.`);
    });
  });
  document.querySelectorAll("[data-configure-provider]").forEach((button) => {
    button.addEventListener("click", () => void configureProvider(button.dataset.configureProvider, button));
  });
  ui.copyMcpUrl.addEventListener("click", () => void copyText(ui.mcpUrl.textContent, "MCP address copied."));
  ui.copyDebugApiUrl.addEventListener("click", () => void copyText(ui.debugApiUrl.textContent, "Debug API address copied."));
  ui.copyAccessKey.addEventListener("click", () => void copyText(session.state.token, "Local access key copied."));
  ui.revealAccessKey.addEventListener("click", () => {
    store.accessRevealed = !store.accessRevealed;
    refreshAccessKey();
  });
  session.boot();
})();
