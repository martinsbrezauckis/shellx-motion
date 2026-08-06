/**
 * workbench-session.js — shared loopback Debug API session controller for the new
 * engine-room pages (History, Connections, Docs, About).
 *
 * Role: factor the connect / disconnect / authenticated-dispatch flow that the
 * existing Inspector (workbench.js) page carries
 * inline, so the supporting pages share one honest implementation. It manages the
 * capability token (kept in this browser tab's sessionStorage under the same key
 * the other pages use), the connect dialog, the session-state chrome, and the
 * granted permission tier, and exposes a single `api()` for POST /debug commands.
 *
 * Security posture (mirrors the existing pages): the capability token is sent only
 * as an `Authorization: Bearer` header to same-origin loopback endpoints; a 401
 * clears the session; the token is never logged or placed in the URL.
 *
 * Dependencies: none (ES module). Transport: GET /debug/contracts, POST /debug.
 * Primary callers: history.js, docs.js, about.js.
 */

/** Server permission tier lattice, mirrored from the debug server. */
export const TIER_RANK = {
  read_motion: 0,
  draft_motion: 1,
  render_motion: 2,
  edit_motion: 3,
  write_local: 4,
  push_remote: 5
};

export function accessLabel(tier) {
  const labels = {
    read_motion: "Read access",
    draft_motion: "Draft access",
    render_motion: "Render access",
    edit_motion: "Edit access",
    write_local: "Local write access",
    push_remote: "Publish access"
  };
  return labels[tier] || "Secure access";
}

const STORAGE_KEY = "shellx-motion-capability";
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);

/**
 * Consume the one-use value placed in the URL fragment by Start Motion.
 * The fragment is cleared before the network exchange, so neither the bootstrap
 * value nor the returned access key remains in the address or browser history.
 */
export async function claimWorkbenchBootstrap() {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const bootstrap = fragment.get("bootstrap");
  if (!bootstrap) return "";
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const response = await fetch("/workbench/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrap })
  });
  const body = await response.json().catch(() => ({}));
  const capabilityToken = text(object(body).capabilityToken);
  if (!response.ok || object(body).ok !== true || !capabilityToken) {
    throw new Error(text(object(object(body).error).message, "This Start Motion link is invalid or has already been used."));
  }
  return capabilityToken;
}

/**
 * Create a session controller bound to a page's connection UI.
 *
 * @param {object} options
 * @param {object} options.ui Element references:
 *   shell, sessionState, sessionButton, tierChip?, connectDialog, connectForm,
 *   capabilityToken, connectError.
 * @param {(context: { grantedTier: string, contracts: object[], contractsBody: object }) => void} [options.onConnected]
 * @param {(reason: string) => void} [options.onDisconnected]
 * @returns {object} The session controller.
 */
export function createWorkbenchSession(options) {
  const ui = options.ui;
  const state = {
    token: sessionStorage.getItem(STORAGE_KEY) || "",
    connected: false,
    grantedTier: "read_motion",
    commandPermission: new Map(),
    contractsBody: {}
  };

  /** Reflect connection state into the shared chrome. */
  function setConnected(connected) {
    state.connected = connected;
    if (ui.shell) ui.shell.dataset.state = connected ? "ready" : "disconnected";
    if (ui.sessionState && ui.sessionState.lastChild) ui.sessionState.lastChild.textContent = connected ? "Ready" : "Disconnected";
    if (ui.sessionButton) ui.sessionButton.textContent = connected ? "Disconnect" : "Connect";
    if (ui.tierChip) {
      ui.tierChip.hidden = !connected;
      if (connected) ui.tierChip.textContent = accessLabel(state.grantedTier);
    }
  }

  /**
   * Authenticate against the local server and load the command contracts.
   * @param {string} token Capability token.
   */
  async function connect(token) {
    state.token = String(token || "").trim();
    if (ui.connectError) ui.connectError.hidden = true;
    try {
      const response = await fetch("/debug/contracts", { headers: { authorization: `Bearer ${state.token}` } });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(text(object(body.error).message, "The local access key was rejected."));
      state.grantedTier = text(body.grantedTier, "read_motion");
      state.contractsBody = object(body);
      state.commandPermission = new Map(list(body.contracts).map((contract) => [contract.command, contract.permission]));
      sessionStorage.setItem(STORAGE_KEY, state.token);
      setConnected(true);
      if (ui.connectDialog && ui.connectDialog.open) ui.connectDialog.close();
      options.onConnected?.({ grantedTier: state.grantedTier, contracts: list(body.contracts), contractsBody: state.contractsBody });
    } catch (error) {
      state.token = "";
      sessionStorage.removeItem(STORAGE_KEY);
      if (ui.connectError) {
        ui.connectError.textContent = error instanceof Error ? error.message : String(error);
        ui.connectError.hidden = false;
      }
      setConnected(false);
    }
  }

  /** Drop the session and clear the retained token. */
  function disconnect(reason = "Workbench disconnected.") {
    state.token = "";
    state.connected = false;
    sessionStorage.removeItem(STORAGE_KEY);
    setConnected(false);
    options.onDisconnected?.(reason);
  }

  /**
   * Dispatch an authenticated Debug API command over loopback JSON.
   * @param {string} command Debug command id.
   * @param {object} args Command arguments.
   * @param {string} requestedTier Lowest tier that satisfies the command.
   * @returns {Promise<object>} The parsed ok response body.
   */
  async function api(command, args = {}, requestedTier = "read_motion") {
    if (!state.token) throw new Error("Connect to Motion first.");
    const response = await fetch("/debug", {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args, requestedTier })
    });
    const body = await response.json().catch(() => ({ ok: false, error: { message: "Motion did not return a readable response." } }));
    if (response.status === 401) disconnect("The local access key was rejected.");
    if (!response.ok || body.ok !== true) throw new Error(text(object(body.error).message, "The Motion action failed."));
    return body;
  }

  /** Whether the granted tier satisfies a command's required tier. */
  function tierAllows(command) {
    const required = state.commandPermission.get(command) ?? "read_motion";
    return TIER_RANK[state.grantedTier] >= TIER_RANK[required];
  }
  const requiredTier = (command) => state.commandPermission.get(command) ?? "read_motion";

  /** Wire the connect dialog + session button. Call once during page boot. */
  function wire() {
    ui.sessionButton?.addEventListener("click", () => {
      if (state.connected) disconnect();
      else ui.connectDialog?.showModal();
    });
    ui.connectForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void connect(ui.capabilityToken.value);
    });
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => {
        const dialog = document.getElementById(button.dataset.closeDialog);
        if (dialog?.open) dialog.close();
      });
    });
  }

  /**
   * Boot the session: either resume the stored token or open the connect dialog.
   * @param {{ autoPrompt?: boolean }} [opts] Whether to auto-open the dialog when
   *   there is no stored token (default true).
   */
  function boot(opts = {}) {
    setConnected(false);
    return (async () => {
      try {
        const bootstrapToken = await claimWorkbenchBootstrap();
        if (bootstrapToken) state.token = bootstrapToken;
      } catch (error) {
        if (ui.connectError) {
          ui.connectError.textContent = error instanceof Error ? error.message : String(error);
          ui.connectError.hidden = false;
        }
      }
      if (state.token) {
        if (ui.capabilityToken) ui.capabilityToken.value = state.token;
        await connect(state.token);
      } else if (opts.autoPrompt !== false) {
        setTimeout(() => ui.connectDialog?.showModal(), 80);
      }
    })();
  }

  return { state, connect, disconnect, api, tierAllows, requiredTier, setConnected, wire, boot };
}
