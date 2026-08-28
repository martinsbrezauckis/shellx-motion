import { TIER_RANK, createWorkbenchSession } from "/workbench-session.js";

(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    shell: $("#appShell"), sessionState: $("#sessionState"), sessionButton: $("#sessionButton"), tierChip: $("#tierChip"),
    connectDialog: $("#connectDialog"), connectForm: $("#connectForm"), capabilityToken: $("#capabilityToken"), connectError: $("#connectError"),
    install: $("#installButton"), refresh: $("#refreshButton"), list: $("#moduleList"), pending: $("#pendingPanel"), pendingSummary: $("#pendingSummary"),
    confirm: $("#confirmButton"), cancel: $("#cancelButton"), details: $("#detailPanel"), detailList: $("#detailList"), status: $("#statusMessage"), detail: $("#statusDetail")
  };
  let pending = null;
  const session = createWorkbenchSession({
    ui,
    onConnected: ({ grantedTier }) => {
      const allowed = TIER_RANK[grantedTier] >= TIER_RANK.write_local;
      ui.install.disabled = !allowed; ui.refresh.disabled = !allowed;
      setStatus(allowed ? "Local effect manager ready." : "Local effects require local write access.", allowed ? "Operator session required" : grantedTier);
      if (allowed) void refresh();
    },
    onDisconnected: () => { ui.install.disabled = true; ui.refresh.disabled = true; ui.list.replaceChildren(empty("Connect through Start Motion to manage local effects.")); }
  });
  const setStatus = (message, detail) => { ui.status.textContent = message; ui.detail.textContent = detail; };
  const empty = (message) => { const element = document.createElement("div"); element.className = "empty-copy"; element.textContent = message; return element; };
  async function request(endpoint, body = {}) {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${session.state.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result?.error?.message || "The local effect action was refused.");
    return result;
  }
  async function refresh() {
    try { renderList((await request("/workbench/effect-modules")).entries); setStatus("Installed local effects loaded.", "No filesystem paths are displayed"); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error), "Use Start Motion to obtain an operator session"); }
  }
  function renderList(entries) {
    ui.list.replaceChildren();
    if (!Array.isArray(entries) || entries.length === 0) { ui.list.append(empty("No local effects are installed.")); return; }
    for (const entry of entries) {
      const row = document.createElement("article"); row.className = "provider-row";
      const identity = document.createElement("div"); identity.className = "provider-identity";
      const title = document.createElement("strong"); title.textContent = String(entry.displayName || entry.moduleId);
      const subtitle = document.createElement("span"); subtitle.textContent = `${entry.moduleId} · ${entry.version} · ${entry.revokedAt ? "Revoked" : "Active"}`;
      identity.append(title, subtitle);
      const actions = document.createElement("div"); actions.className = "provider-actions";
      const inspect = document.createElement("button"); inspect.className = "quiet-button compact"; inspect.type = "button"; inspect.textContent = "Inspect"; inspect.addEventListener("click", () => void inspectEntry(entry)); actions.append(inspect);
      if (!entry.revokedAt) { const revoke = document.createElement("button"); revoke.className = "quiet-button compact"; revoke.type = "button"; revoke.textContent = "Revoke"; revoke.addEventListener("click", () => void revokeEntry(entry)); actions.append(revoke); }
      row.append(identity, actions); ui.list.append(row);
    }
  }
  async function beginInstall() {
    try {
      const answer = await request("/workbench/effect-modules/install");
      if (answer.cancelled) { setStatus("Installation cancelled.", "No bytes were installed"); return; }
      pending = answer.pending; ui.pendingSummary.textContent = `${pending.displayName} ${pending.version} is ready to install.`; ui.pending.hidden = false; setStatus("Review the selected effect, then confirm.", "Exact selected bytes are frozen");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "Installation was not started"); }
  }
  async function confirmInstall() { if (!pending) return; try { await request("/workbench/effect-modules/confirm", { confirmationId: pending.confirmationId }); pending = null; ui.pending.hidden = true; await refresh(); setStatus("Local effect installed.", "Immutable version recorded"); } catch (error) { pending = null; ui.pending.hidden = true; setStatus(error instanceof Error ? error.message : String(error), "Confirmation is single use"); } }
  async function cancelInstall() { if (!pending) return; await request("/workbench/effect-modules/cancel", { confirmationId: pending.confirmationId }); pending = null; ui.pending.hidden = true; setStatus("Installation cancelled.", "Frozen bytes discarded"); }
  /**
   * Render registry provenance as deliberately small, pathless display text.
   *
   * This handles an untrusted response shape defensively: data descriptors only (so accessors never
   * run), a cycle guard, stable key ordering, bounded depth/entries/strings/output, and recursive
   * omission of path and secret-bearing keys. It is self-contained because executable contract tests
   * lift this exact browser function and run it outside the page closure.
   */
  function formatModuleDetailValue(value, key) {
    const MAX_DEPTH = 3;
    const MAX_ENTRIES = 8;
    const MAX_STRING = 160;
    const MAX_OUTPUT = 1200;
    const seen = new WeakSet();
    const isRedactedKey = (key) => /(?:path|url|uri|secret|token|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i.test(key);
    if (typeof key === "string" && isRedactedKey(key)) return null;
    const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const clip = (text, limit) => text.length > limit ? `${text.slice(0, Math.max(0, limit - 14))}… [truncated]` : text;
    const stringValue = (text, field, topLevel) => {
      // A detail response must never become a route for a host path or arbitrary link. The Workbench
      // has no need to display either; the registry itself owns those private values.
      if (text.length > MAX_STRING) return "[truncated]";
      const publicIdentifier = typeof field === "string"
        && /^(?:rendererAbi|parameterSchema|schema)$/.test(field)
        && /^shellx-motion\/[a-z0-9][a-z0-9._-]*@[1-9][0-9]*(?:\.[0-9]+){0,2}$/i.test(text);
      if (!publicIdentifier && (/[\\/]/.test(text) || /\b(?:https?|ftp):\/\/|\b(?:file|data|javascript|mailto|tel):|\bwww\./i.test(text))) return "[redacted]";
      return topLevel ? text : JSON.stringify(text);
    };
    const readDataDescriptor = (descriptor) => descriptor && typeof descriptor === "object" && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
    const format = (current, depth, field) => {
      try {
        if (current === null) return "null";
        if (current === undefined) return "undefined";
        if (typeof current === "string") return stringValue(current, field, depth === 0);
        if (typeof current === "number") return Number.isFinite(current) ? String(current) : `[${String(current)}]`;
        if (typeof current === "boolean" || typeof current === "bigint" || typeof current === "symbol") return String(current);
        if (typeof current === "function") return "[unsupported function]";
        if (typeof current !== "object") return "[unavailable]";
        if (seen.has(current)) return "[circular]";
        if (depth >= MAX_DEPTH) return "[depth limit]";
        seen.add(current);

        if (Array.isArray(current)) {
          const descriptors = Object.getOwnPropertyDescriptors(current);
          const length = readDataDescriptor(descriptors.length);
          if (!Number.isSafeInteger(length) || length < 0) return "[unavailable array]";
          const values = [];
          for (let index = 0; index < Math.min(length, MAX_ENTRIES); index += 1) {
            const descriptor = descriptors[String(index)];
            if (!descriptor) values.push("[empty]");
            else if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) values.push("[accessor omitted]");
            else values.push(format(readDataDescriptor(descriptor), depth + 1));
          }
          if (length > MAX_ENTRIES) values.push("[additional entries omitted]");
          return `[${values.join(", ")}]`;
        }

        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) return "[unsupported object]";
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const values = [];
        let omitted = false;
        for (const key of Object.keys(descriptors).sort(compare)) {
          if (isRedactedKey(key)) { omitted = true; continue; }
          if (values.length >= MAX_ENTRIES) { omitted = true; continue; }
          const descriptor = descriptors[key];
          if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) values.push(`${stringValue(key, undefined, false)}: [accessor omitted]`);
          else values.push(`${stringValue(key, undefined, false)}: ${format(readDataDescriptor(descriptor), depth + 1, key)}`);
        }
        if (omitted) values.push("[fields omitted]");
        return `{${values.join(", ")}}`;
      } catch {
        return "[unavailable]";
      }
    };
    return clip(format(value, 0, key), MAX_OUTPUT);
  }
  async function inspectEntry(entry) { try { const answer = await request(`/workbench/effect-modules/${encodeURIComponent(entry.moduleId)}/${encodeURIComponent(entry.version)}`); ui.detailList.replaceChildren(...Object.entries(answer.entry).map(([key, value]) => { const formatted = formatModuleDetailValue(value, key); if (formatted === null) return null; const row = document.createElement("div"), label = document.createElement("dt"), valueNode = document.createElement("dd"); label.textContent = key; valueNode.textContent = formatted; row.append(label, valueNode); return row; }).filter(Boolean)); ui.details.hidden = false; } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "Details unavailable"); } }
  async function revokeEntry(entry) { try { await request(`/workbench/effect-modules/${encodeURIComponent(entry.moduleId)}/${encodeURIComponent(entry.version)}/revoke`); await refresh(); setStatus("Local effect revoked.", "New uses are refused"); } catch (error) { setStatus(error instanceof Error ? error.message : String(error), "Revocation failed"); } }
  ui.install.addEventListener("click", () => void beginInstall()); ui.refresh.addEventListener("click", () => void refresh()); ui.confirm.addEventListener("click", () => void confirmInstall()); ui.cancel.addEventListener("click", () => void cancelInstall()); session.wire(); session.boot();
})();
