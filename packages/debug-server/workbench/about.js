/**
 * about.js — DOM controller for the engine-room About page (identity + update).
 *
 * Role: report the exact engine build the user is connected to, and drive the
 * shared automatic software-update flow. Engine identity is read from the live server:
 * its version and user-facing access level from live server state. The
 * update flow speaks the GitHub-releases contract via `POST /workbench/update-check`
 * and `POST /workbench/update-apply`, mapping every response to an honest view
 * (update-state.js).
 *
 * The page reads the server's cached startup/periodic result and "Check now"
 * refreshes that same cache. The browser never creates a second update answer.
 *
 * Dependencies: /workbench-session.js (connection), /update-state.js (view-model).
 * Transport: GET /health, GET /debug/contracts, POST /workbench/update-check,
 *   POST /workbench/update-apply.
 * Primary caller: served at /workbench/about by the Motion debug server.
 */
import { accessLabel, createWorkbenchSession } from "/workbench-session.js";
import { buildUpdateView, normalizeApplyState, normalizeCachedUpdateState, normalizeCheckState } from "/update-state.js";

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const text = (value, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);

  const ui = {
    shell: $("#appShell"),
    sessionState: $("#sessionState"),
    sessionButton: $("#sessionButton"),
    tierChip: $("#tierChip"),
    connectDialog: $("#connectDialog"),
    connectForm: $("#connectForm"),
    capabilityToken: $("#capabilityToken"),
    connectError: $("#connectError"),
    engineVersion: $("#engineVersion"),
    connectionTier: $("#connectionTier"),
    identityNote: $("#identityNote"),
    toolGrid: $("#toolGrid"),
    toolNote: $("#toolNote"),
    updateBadge: $("#updateBadge"),
    updateBadgeLabel: $("#updateBadgeLabel"),
    updateTitle: $("#updateTitle"),
    updateMessage: $("#updateMessage"),
    updateNotes: $("#updateNotes"),
    checkButton: $("#checkButton"),
    applyButton: $("#applyButton"),
    statusMessage: $("#statusMessage"),
    statusDetail: $("#statusDetail"),
    toast: $("#toast")
  };

  // The latest check result drives what an Apply click will target.
  const store = { lastView: null, latestVersion: "", currentVersion: "", updatePoll: null };

  const session = createWorkbenchSession({
    ui,
    onConnected: ({ grantedTier, contractsBody }) => {
      ui.connectionTier.textContent = accessLabel(grantedTier);
      // The server half may add a version to the contracts payload; read it honestly.
      const version = readVersion(contractsBody);
      if (version) { ui.engineVersion.textContent = version; store.currentVersion = version; }
      ui.identityNote.hidden = true;
      setStatus("Motion is ready.", accessLabel(grantedTier));
      void loadToolReadiness();
      void loadUpdateState();
      startUpdatePolling();
    },
    onDisconnected: () => {
      ui.connectionTier.textContent = "disconnected";
      ui.identityNote.hidden = false;
      ui.toolGrid.hidden = true;
      ui.toolNote.hidden = true;
      if (store.updatePoll) clearInterval(store.updatePoll);
      store.updatePoll = null;
      setStatus("Motion is disconnected.", "Start Motion to reconnect automatically");
    }
  });

  function setStatus(message, detail = "ShellX Motion") {
    ui.statusMessage.textContent = message;
    ui.statusDetail.textContent = detail;
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { ui.toast.hidden = true; }, 4200);
  }

  /** Read an engine version from a payload, tolerating several field names. */
  function readVersion(body) {
    const record = object(body);
    return text(record.version) || text(record.engineVersion) || text(object(record.engine).version);
  }

  function authHeaders(extra = {}) {
    return session.state.token ? { authorization: `Bearer ${session.state.token}`, ...extra } : { ...extra };
  }

  // ----- engine identity (unauthenticated /health) -----
  async function loadHealth() {
    try {
      const response = await fetch("/health");
      if (!response.ok) return;
      const body = object(await response.json());
      const version = readVersion(body);
      // Prefer a real server version; otherwise be honest that the build is unversioned.
      ui.engineVersion.textContent = version || "unversioned (0.0.0)";
      store.currentVersion = version || "";
    } catch {
      // /health unreachable: leave the placeholders and let the connection fill in.
    }
  }

  // ----- external tool readiness (authenticated motion.platform.requirements) -----
  /**
   * @contract motion.platform.requirements → the About page's external-tool readiness block.
   *
   * Self-contained and DOM-free so `workbench-contract.test.ts` can lift it out of this file and run
   * it against a REAL server response.
   *
   * The `unverified` state is the point (the readiness-parity invariant). This block used to disappear whenever
   * the probe or the transport failed, and a page with no tool rows is indistinguishable from a page
   * reporting a healthy machine — the failure mode read as the success. It now says so, and still
   * lists the two programs Motion depends on, valued "could not verify": `unverified` is a defined
   * tool status meaning no probe ran, so those rows state a fact rather than invent one.
   *
   * Per-operation blockers come from the server's `operations[].blockedBy` — never from "every
   * non-ready tool", which would report a missing FFprobe as blocking the final encode.
   *
   * @param result The `result` object of `motion.platform.requirements`, or null when the command
   *   or transport failed.
   * @returns `{ state: "verified"|"unverified", tools: [{ name, value }], note }`.
   */
  function readToolReadinessView(result) {
    const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    const answer = record(result);
    const platform = record(answer.platform);
    const tools = Array.isArray(platform.tools) ? platform.tools.map(record) : [];
    if (answer.ok !== true || tools.length === 0) {
      return {
        state: "unverified",
        // The programs Motion shells out to are a fixed, documented dependency; naming them while
        // saying their state is unknown is honest, and it is what tells a user what to go check.
        // Chromium belongs in this list for the same reason the other two do: the default frame
        // lane rasterizes in a real browser, so omitting it here would understate what to check.
        tools: [
          { name: "ffmpeg", value: "could not verify" },
          { name: "ffprobe", value: "could not verify" },
          { name: "chromium", value: "could not verify" }
        ],
        note: "Could not verify which external tools are available on this machine. The readiness check did not answer — it was not a report that anything is missing."
      };
    }
    const rows = tools.map((tool) => ({
      name: typeof tool.tool === "string" ? tool.tool : "unknown",
      value: tool.status === "ready"
        ? "Ready"
        : (typeof tool.status === "string" ? tool.status : "unverified")
    }));
    const operations = Array.isArray(platform.operations) ? platform.operations.map(record) : [];
    const blocked = operations.filter((operation) => operation.satisfied !== true);
    return {
      state: "verified",
      tools: rows,
      note: blocked.length === 0
        ? "Every external tool Motion needs is present: preview, final encode and quality checks all work."
        : `Unavailable here: ${blocked
          .map((operation) => `${operation.operation} (needs ${(Array.isArray(operation.blockedBy) ? operation.blockedBy : []).join(", ")})`)
          .join("; ")}.`
    };
  }

  /**
   * Report what this machine can DO, next to what build it is.
   *
   * Engine identity alone answers "which Motion is this", never "can it encode" — so the only
   * state a user can actually fix (a missing FFmpeg) was invisible until a render failed
   * (the readiness-parity invariant). This reads the shared requirements result, so this page, `motion doctor`,
   * the render dialog and any MCP client all show the same thing. All wording lives in
   * `readToolReadinessView`; this function only moves it into the DOM, and always shows the block.
   */
  async function loadToolReadiness() {
    let result = null;
    try {
      const response = await fetch("/debug", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ command: "motion.platform.requirements", args: {}, requestedTier: "read_motion" })
      });
      result = object(await response.json()).result;
    } catch {
      // Swallowed on purpose: readiness is additional evidence and never a reason to break the
      // identity page. The "could not verify" state below is what the reader sees instead.
      result = null;
    }
    const view = readToolReadinessView(result);
    ui.toolGrid.replaceChildren(...view.tools.map((tool) => {
      const item = document.createElement("div");
      item.className = "identity-item";
      const key = document.createElement("span");
      key.className = "k";
      key.textContent = tool.name;
      const value = document.createElement("span");
      value.className = "v";
      value.textContent = tool.value;
      item.append(key, value);
      return item;
    }));
    // Both stay visible in every state: an absent block reads as a healthy machine.
    ui.toolGrid.dataset.state = view.state;
    ui.toolGrid.hidden = false;
    ui.toolNote.textContent = view.note;
    ui.toolNote.hidden = false;
  }

  // ----- update view rendering -----
  function renderUpdate(view) {
    store.lastView = view;
    store.latestVersion = view.latestVersion || store.latestVersion;
    ui.updateTitle.textContent = view.title;
    ui.updateMessage.textContent = view.message;

    // Tone badge.
    ui.updateBadge.hidden = false;
    ui.updateBadge.dataset.tone = view.tone;
    ui.updateBadgeLabel.textContent = badgeLabel(view.kind);

    // Notes link (only ever an http(s) URL, validated in update-state.js).
    if (view.notesUrl) { ui.updateNotes.hidden = false; ui.updateNotes.href = view.notesUrl; }
    else ui.updateNotes.hidden = true;

    // Buttons.
    ui.checkButton.disabled = view.checkDisabled;
    ui.checkButton.hidden = !view.showCheck;
    ui.applyButton.hidden = !view.canApply;
    ui.applyButton.disabled = view.applyDisabled || !view.canApply;
  }

  function badgeLabel(kind) {
    const labels = {
      idle: "not checked", checking: "checking", unconfigured: "not configured",
      "up-to-date": "up to date", "update-available": "update available",
      "network-error": "unavailable", "endpoint-absent": "unavailable",
      applying: "applying", applied: "applied",
      "source-workflow-required": "source update", "manual-action-required": "manual update",
      "apply-error": "failed"
    };
    return labels[kind] || kind;
  }

  function renderCheckBody(body, kind = normalizeCheckState(body)) {
    renderUpdate(buildUpdateView(kind, {
      currentVersion: text(body.currentVersion) || readVersion(body) || store.currentVersion,
      latestVersion: text(body.latestVersion) || text(object(body.release).version),
      notesUrl: text(body.notesUrl) || text(object(body.release).notesUrl) || text(object(body.release).htmlUrl),
      errorCode: text(object(body.error).code)
    }));
  }

  async function loadUpdateState() {
    if (!session.state.token) return;
    try {
      const response = await fetch("/workbench/update-state", { headers: authHeaders() });
      if (response.status === 404) {
        renderUpdate(buildUpdateView("endpoint-absent"));
        return;
      }
      if (!response.ok) return;
      const body = object(await response.json());
      const kind = normalizeCachedUpdateState(body);
      const result = object(body.result);
      if (kind === "idle" || kind === "checking") renderUpdate(buildUpdateView(kind, { currentVersion: store.currentVersion }));
      else renderCheckBody(result, kind);
    } catch {
      // Keep the last truthful cached state; the next local poll can recover it.
    }
  }

  function startUpdatePolling() {
    if (store.updatePoll) clearInterval(store.updatePoll);
    store.updatePoll = setInterval(() => void loadUpdateState(), 30_000);
  }

  // ----- check + apply -----
  async function checkForUpdates() {
    renderUpdate(buildUpdateView("checking"));
    setStatus("Checking for updates…", "Refreshing the shared release status");
    try {
      const response = await fetch("/workbench/update-check", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({})
      });
      if (response.status === 404) {
        renderUpdate(buildUpdateView("endpoint-absent"));
        setStatus("Update checks are unavailable in this build.", "The current build cannot check releases");
        return;
      }
      const body = object(await response.json().catch(() => ({})));
      if (response.status === 401) {
        renderUpdate(buildUpdateView("network-error", { message: "Connect to Motion, then check again." }));
        return;
      }
      const kind = normalizeCheckState(body);
      renderCheckBody(body, kind);
      setStatus("Update status refreshed.", badgeLabel(kind));
    } catch (error) {
      renderUpdate(buildUpdateView("network-error"));
      setStatus("Could not refresh update status.", "Motion will try again automatically");
    }
  }

  async function applyUpdate() {
    renderUpdate(buildUpdateView("applying", { latestVersion: store.latestVersion }));
    setStatus("Opening update options…", "Checking the supported install method");
    try {
      const response = await fetch("/workbench/update-apply", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(store.latestVersion ? { version: store.latestVersion } : {})
      });
      if (response.status === 404) {
        renderUpdate(buildUpdateView("endpoint-absent"));
        showToast("Update options are unavailable in this build.");
        return;
      }
      const body = object(await response.json().catch(() => ({})));
      if (!response.ok || body.ok === false) {
        renderUpdate(buildUpdateView("apply-error"));
        return;
      }
      // Derive the honest apply outcome from the server's real contract. Only the
      // "applied" branch (applied === true) claims success; the server's truthful
      // non-apply responses (source-checkout / manual-download) render explicit
      // action-required copy instead of pretending the update was applied.
      const kind = normalizeApplyState(body);
      renderUpdate(buildUpdateView(kind, {
        latestVersion: text(body.latestVersion) || store.latestVersion,
        ref: text(body.ref) || text(body.checkoutRef),
        checkedOut: body.checkedOut === true || body.applied === true,
        // For a manual download the server hands back the release page URL; surface
        // it as the notes link so the user can reach the release directly.
        notesUrl: text(body.releasePageUrl) || text(body.notesUrl)
      }));
      const statusByKind = {
        applied: ["Update applied.", "restart required"],
        "manual-action-required": ["Download required.", "Open the release page"],
        "source-workflow-required": ["This copy cannot update itself.", "Current installation unchanged"]
      };
      const [statusMessage, statusDetail] = statusByKind[kind] || ["Update check complete.", kind];
      setStatus(statusMessage, statusDetail);
    } catch {
      renderUpdate(buildUpdateView("apply-error"));
    }
  }

  // ----- events -----
  ui.checkButton.addEventListener("click", () => void checkForUpdates());
  ui.applyButton.addEventListener("click", () => void applyUpdate());

  // ----- boot -----
  session.wire();
  session.boot({ autoPrompt: false });
  renderUpdate(buildUpdateView("idle"));
  void loadHealth();
})();
