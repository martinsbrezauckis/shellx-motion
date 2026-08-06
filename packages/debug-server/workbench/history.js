/**
 * history.js — DOM controller for the engine-room Receipts History (the trust
 * surface).
 *
 * Role: a human-facing, chronological review of what Motion actually did. It lists
 * receipts newest-first from a chosen receipts root using the existing Debug API
 * commands `motion.receipts.list` (enumerate) and `motion.receipts.read` (full
 * receipt), builds a defensive per-receipt card view-model (receipt-card.js), and
 * surfaces — at a glance — WHEN it ran, WHO/what triggered it, WHAT was produced
 * (operation, lane, encoder, gate result), and WHERE the outputs landed on disk.
 * Each output path carries an "Open folder" action that asks the server-half's
 * `POST /workbench/reveal` endpoint to open the OS file manager; when that endpoint
 * is absent (older build) the action degrades honestly.
 *
 * Every visible fact comes from a real receipt read over the authenticated
 * loopback API — nothing is invented, and an empty root shows an honest empty
 * state, never a fabricated timeline.
 *
 * Dependencies: /workbench-session.js (connection), /receipt-card.js (view-model).
 * Transport: GET /debug/contracts (grant + the host's own receipts root),
 * POST /debug (receipts.list / receipts.read), POST /workbench/reveal.
 * Primary caller: served at /workbench/history by the Motion debug server.
 */
import { accessLabel, createWorkbenchSession } from "/workbench-session.js";
import { buildReceiptCard, receiptFacets } from "/receipt-card.js";
import { pickWorkbenchPath, readWorkbenchPath, showWorkbenchPath } from "/workbench-path-picker.js";

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const list = (value) => (Array.isArray(value) ? value : []);
  const text = (value, fallback = "—") => (typeof value === "string" && value.trim() ? value : fallback);

  const ui = {
    shell: $("#appShell"),
    sessionState: $("#sessionState"),
    sessionButton: $("#sessionButton"),
    tierChip: $("#tierChip"),
    connectDialog: $("#connectDialog"),
    connectForm: $("#connectForm"),
    capabilityToken: $("#capabilityToken"),
    connectError: $("#connectError"),
    receiptsRoot: $("#receiptsRoot"),
    receiptsBrowse: $("#receiptsBrowse"),
    reloadButton: $("#reloadButton"),
    filterRow: $("#filterRow"),
    packageFilter: $("#packageFilter"),
    operationFilter: $("#operationFilter"),
    statusFilter: $("#statusFilter"),
    shownCount: $("#shownCount"),
    totalCount: $("#totalCount"),
    timeline: $("#timeline"),
    statusMessage: $("#statusMessage"),
    statusDetail: $("#statusDetail"),
    detailDialog: $("#detailDialog"),
    detailOperation: $("#detailOperation"),
    detailId: $("#detailId"),
    detailScroll: $("#detailScroll"),
    rawToggle: $("#rawToggle"),
    toast: $("#toast")
  };

  /**
   * One state model for the timeline area.
   *
   * `phase` is the single source of truth for what the timeline shows, so the page
   * cannot say "Not connected" while the session chrome says Connected — which is
   * exactly what happened when the empty state was static markup that only the
   * load path ever replaced.
   *
   * disconnected → no session · idle → connected, nothing loaded yet ·
   * loading → a load is in flight · empty → the root holds no receipts ·
   * error → the load failed · results → cards are rendered.
   */
  const stateStore = {
    phase: "disconnected",
    cards: [],
    activeCard: null,
    rawVisible: false,
    /** `{ title, detail }` for the empty/error phases. */
    notice: null
  };

  const session = createWorkbenchSession({
    ui,
    onConnected: ({ contractsBody }) => {
      ui.reloadButton.disabled = false;
      ui.receiptsBrowse.disabled = false;
      adoptHostReceiptsRoot(contractsBody);
      setPhase(stateStore.phase === "results" ? "results" : "idle");
      setStatus("Motion is ready.", accessLabel(session.state.grantedTier));
      // Only auto-load when a root is actually known. Connecting to a host that published none is a
      // legitimate state, and greeting it with "Choose a receipt location first." as a toast would be
      // scolding the person for something they have not done yet; the idle panel already says it.
      if (readWorkbenchPath(ui.receiptsRoot)) void loadReceipts();
    },
    onDisconnected: (reason) => {
      ui.reloadButton.disabled = true;
      ui.receiptsBrowse.disabled = true;
      stateStore.cards = [];
      setPhase("disconnected");
      setStatus(reason, "Access key cleared");
    }
  });

  /**
   * Move the timeline to a phase and re-render it.
   * @param {"disconnected"|"idle"|"loading"|"empty"|"error"|"results"} phase
   * @param {{title: string, detail: string}} [notice] Copy for the empty/error phases.
   */
  function setPhase(phase, notice = null) {
    stateStore.phase = phase;
    stateStore.notice = notice;
    // Filters only mean something once there are cards to filter.
    ui.filterRow.hidden = phase !== "results";
    renderTimeline();
  }

  // ----- small DOM helpers -----
  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = String(textContent);
    return node;
  }

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

  function svgIcon(d) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  /** Format an ISO timestamp into a compact local string; "—" when unparseable. */
  function formatWhen(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  const OPERATION_LABELS = Object.freeze({
    "render.final": "Final render",
    "preview.frame": "Frame preview",
    "template.apply": "Template applied",
    validate: "Validation"
  });

  function humanToken(value, fallback = "Unknown") {
    const raw = text(value, "");
    if (!raw) return fallback;
    return raw
      .replace(/^pkg[_-]?/i, "")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .replace(/\bShellx\b/g, "ShellX");
  }

  function operationLabel(operation) {
    return OPERATION_LABELS[operation] || humanToken(operation, "Operation");
  }

  function packageLabel(packageId) {
    return humanToken(packageId, "Package");
  }

  function rendererLabel(lane) {
    if (String(lane).toLowerCase() === "ffmpeg") return "FFmpeg";
    return humanToken(lane, "Renderer");
  }

  function pathBasename(value) {
    const parts = text(value, "Output").split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || "Output";
  }

  /**
   * Adopt the receipt folder THIS server keeps its receipts in, published by `/debug/contracts`.
   *
   * The page used to start with a literal `.scratch/receipts` baked into the markup — a root the
   * browser invented, which the Debug API's receipts-root fence refuses because only the host may
   * name one. The published value is the host's own root, so it passes the fence and, more to the
   * point, is where the receipts actually are.
   *
   * A root already on the page wins: a `?receiptsRoot=` handoff from the Inspector and a folder the
   * person picked are both deliberate choices, and a reconnect must not quietly discard them.
   *
   * @param body The parsed `/debug/contracts` payload.
   */
  function adoptHostReceiptsRoot(body) {
    if (readWorkbenchPath(ui.receiptsRoot)) return;
    const hostRoot = text(object(body).receiptsRoot, "");
    if (!hostRoot) return;
    showWorkbenchPath(ui.receiptsRoot, hostRoot, "No receipt location selected");
  }

  // ----- load receipts -----
  async function loadReceipts() {
    const root = readWorkbenchPath(ui.receiptsRoot);
    if (!root) { showToast("Choose a receipt location first."); return; }
    ui.reloadButton.disabled = true;
    setPhase("loading");
    setStatus("Loading receipt history…", "Reading the selected location");
    try {
      const response = await session.api("motion.receipts.list", { receiptsRoot: root }, session.requiredTier("motion.receipts.list"));
      const summaries = list(object(response.result).receipts);
      if (summaries.length === 0) {
        stateStore.cards = [];
        setPhase("empty", {
          title: "No receipts in this location",
          detail: `Nothing has been recorded under ${root} yet. Render a package, then reload.`
        });
        setStatus("No receipts found.", root);
        return;
      }
      // Read each receipt in full so cards can show encoder / actor / gate detail.
      // Reads are local files over loopback; a small concurrency keeps it responsive.
      const cards = await readAllReceipts(root, summaries);
      cards.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      stateStore.cards = cards;
      populateFilters(cards);
      setPhase("results");
      setStatus(`${cards.length} receipts loaded.`, root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stateStore.cards = [];
      setPhase("error", { title: "Could not load receipts", detail: message });
      setStatus(message, "Receipt history could not be loaded");
    } finally {
      ui.reloadButton.disabled = !session.state.connected;
    }
  }

  /**
   * Read every listed receipt in full with bounded concurrency. A read that fails
   * still yields a card from the summary fields, so one bad file never blanks the
   * whole timeline.
   */
  async function readAllReceipts(root, summaries) {
    const cards = new Array(summaries.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < summaries.length) {
        const index = cursor;
        cursor += 1;
        const summary = object(summaries[index]);
        try {
          const detail = await session.api(
            "motion.receipts.read",
            { receiptsRoot: root, receiptPath: text(summary.path, "") },
            session.requiredTier("motion.receipts.read")
          );
          const receipt = object(object(detail.result).receipt);
          cards[index] = buildReceiptCard(receipt, { path: text(summary.path, "") });
        } catch {
          // Fall back to the summary so the card still appears (degraded, honest).
          cards[index] = buildReceiptCard(summary, { path: text(summary.path, "") });
        }
      }
    };
    const concurrency = Math.min(6, summaries.length);
    await Promise.all(Array.from({ length: concurrency }, worker));
    return cards;
  }

  function honestEmpty(title, detail, danger = false) {
    const box = el("div", danger ? "empty-state danger" : "empty-state");
    box.append(el("strong", "", title), el("span", "", detail));
    return box;
  }

  // ----- filters -----
  function populateFilters(cards) {
    const facets = receiptFacets(cards);
    fillSelect(ui.packageFilter, "All packages", facets.packages, packageLabel);
    fillSelect(ui.operationFilter, "All operations", facets.operations, operationLabel);
  }

  function fillSelect(select, allLabel, values, labelFor = (value) => value) {
    const current = select.value;
    select.replaceChildren(new Option(allLabel, ""));
    for (const value of values) select.append(new Option(labelFor(value), value));
    select.value = values.includes(current) ? current : "";
  }

  function filteredCards() {
    const pkg = ui.packageFilter.value;
    const op = ui.operationFilter.value;
    const status = ui.statusFilter.value;
    return stateStore.cards.filter((card) => {
      if (pkg && card.packageId !== pkg) return false;
      if (op && card.operation !== op) return false;
      if (status && card.status !== status) return false;
      return true;
    });
  }

  // ----- render -----
  /** Render whatever the current phase says the timeline area is. */
  function renderTimeline() {
    const cards = stateStore.phase === "results" ? filteredCards() : [];
    ui.totalCount.textContent = String(stateStore.cards.length);
    ui.shownCount.textContent = String(cards.length);
    ui.timeline.replaceChildren();
    if (stateStore.phase !== "results") {
      ui.timeline.append(phaseNotice());
      return;
    }
    if (cards.length === 0) {
      ui.timeline.append(honestEmpty("No receipts match the filters", "Adjust or clear the package / operation / result filters."));
      return;
    }
    for (const card of cards) ui.timeline.append(renderCard(card));
  }

  /** The non-results states, each derived from `stateStore.phase` alone. */
  function phaseNotice() {
    if (stateStore.phase === "loading") return el("div", "empty-copy", "Loading receipts…");
    if (stateStore.phase === "error") {
      return honestEmpty(stateStore.notice?.title ?? "Could not load receipts", stateStore.notice?.detail ?? "", true);
    }
    if (stateStore.phase === "empty") {
      return honestEmpty(stateStore.notice?.title ?? "No receipts in this location", stateStore.notice?.detail ?? "");
    }
    if (stateStore.phase === "idle") {
      // Two genuinely different states, and saying "load the default history" in the second one
      // would promise a folder that does not exist: this host published no receipts root, so there
      // is nothing to load until a person picks one.
      return readWorkbenchPath(ui.receiptsRoot)
        ? honestEmpty("History is ready", "Load this location's history, or choose another location.")
        : honestEmpty("History is ready", "Choose a receipt location to load its history.");
    }
    return honestEmpty("Motion is disconnected", "Start Motion to view its receipt history.");
  }

  /** Render one receipt card — WHEN / WHO / WHAT / WHERE at a glance. */
  function renderCard(card) {
    const node = el("div", "receipt-card");
    node.dataset.status = card.status;
    node.setAttribute("role", "listitem");

    // Top row: friendly operation (WHAT) and timestamp (WHEN). The immutable
    // receipt id remains available in Details without turning the everyday
    // timeline into an implementation log.
    const top = el("div", "receipt-top");
    const opWrap = el("div", "receipt-op");
    opWrap.append(el("strong", "", operationLabel(card.operation)));
    top.append(opWrap, el("span", "receipt-when", formatWhen(card.createdAt)));
    node.append(top);

    // Facet chips: package, actor (WHO), renderer, encoder (WHAT).
    const facets = el("div", "receipt-facets");
    facets.append(facet("Package", packageLabel(card.packageId)));
    facets.append(actorFacet(card.actor));
    facets.append(facet("Renderer", rendererLabel(card.lane)));
    if (card.encoder) facets.append(encoderFacet(card.encoder));
    node.append(facets);

    // Outputs (WHERE): prominent paths + per-output Open-folder action.
    if (card.outputs.length > 0) {
      const outWrap = el("div", "receipt-outputs");
      outWrap.append(el("div", "receipt-outputs-label", card.outputs.length === 1 ? "Output" : "Outputs"));
      for (const output of card.outputs) outWrap.append(renderOutputRow(output));
      node.append(outWrap);
    }

    // Summary line: gate result, warnings, Details button.
    const summary = el("div", "receipt-summary");
    summary.append(gatePill(card));
    const warns = el("span", card.warningsCount > 0 ? "warns" : "warns none", card.warningsCount > 0 ? `${card.warningsCount} warning${card.warningsCount === 1 ? "" : "s"}` : "no warnings");
    summary.append(warns);
    summary.append(el("span", "spacer"));
    const details = el("button", "quiet-button compact", "Details");
    details.type = "button";
    details.addEventListener("click", () => openDetail(card));
    summary.append(details);
    node.append(summary);
    return node;
  }

  function facet(key, value) {
    const chip = el("span", "facet");
    chip.append(el("span", "facet-key", key), el("span", "", value));
    return chip;
  }

  function actorFacet(actor) {
    const chip = el("span", actor.attributed ? "facet" : "facet unattributed");
    chip.append(el("span", "facet-key", "By"), el("span", "", actor.label));
    // Surface the observed transport (MCP/HTTP/WS/CLI/SDK) beside the (possibly claimed) label, and
    // put the full observed "via …" evidence in the tooltip — those facts cannot be spoofed.
    if (actor.transportLabel) chip.append(el("span", "facet-transport", actor.transportLabel));
    if (actor.attributed && actor.via) chip.title = `${actor.label} — ${actor.via}`;
    if (!actor.attributed) chip.title = "This receipt carries no actor field — attribution is structurally absent.";
    return chip;
  }

  function encoderFacet(encoder) {
    const chip = el("span", `facet encoder-${encoder.source || "software"}`);
    chip.append(el("span", "facet-key", "Encoder"), el("span", "", encoder.name || encoder.reasonLabel));
    chip.title = encoder.reasonLabel + (encoder.fallback ? ` · fell back from ${encoder.fallback.attemptedEncoder}` : "");
    return chip;
  }

  function gatePill(card) {
    const pill = el("span", `gate-pill ${card.status}`);
    pill.append(el("span", "dot"));
    const detail = card.gates.checks.length > 0 ? ` · ${card.gates.checks.length} gate${card.gates.checks.length === 1 ? "" : "s"}` : "";
    pill.append(el("span", "", `${card.statusLabel}${detail}`));
    return pill;
  }

  function renderOutputRow(output) {
    const row = el("div", "output-row");
    if (output.role) row.append(el("span", "output-role", humanToken(output.role, "Output")));
    const outputName = pathBasename(output.path);
    row.append(el("span", "output-path", outputName));
    if (output.dimensionsLabel) row.append(el("span", "output-meta", output.dimensionsLabel));
    const actions = el("div", "output-actions");
    const reveal = el("button", "icon-button", undefined);
    reveal.type = "button";
    reveal.title = "Open the containing folder";
    reveal.setAttribute("aria-label", `Open folder for ${outputName}`);
    reveal.append(svgIcon("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"));
    reveal.addEventListener("click", () => revealPath(output.path));
    actions.append(reveal);
    row.append(actions);
    return row;
  }

  /**
   * Ask the server-half to open the OS file manager at an output path. Degrades
   * honestly when the endpoint is absent (older build) or the path is rejected.
   */
  async function revealPath(path) {
    try {
      const response = await fetch("/workbench/reveal", {
        method: "POST",
        headers: { authorization: `Bearer ${session.state.token}`, "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      if (response.status === 404) { showToast("Open folder is unavailable in this build."); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        showToast(text(object(body.error).message, "Could not open the folder."));
        return;
      }
      showToast("Opened the containing folder.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not open the folder.");
    }
  }

  // ----- detail dialog -----
  function openDetail(card) {
    stateStore.activeCard = card;
    stateStore.rawVisible = false;
    ui.detailOperation.textContent = operationLabel(card.operation);
    ui.detailId.textContent = card.id;
    ui.rawToggle.textContent = "Show raw JSON";
    renderDetail(card);
    ui.detailDialog.showModal();
  }

  function renderDetail(card) {
    ui.detailScroll.replaceChildren();

    // Overview
    const overview = section("Overview");
    const kv = el("table", "kv-table");
    appendRow(kv, "Status", card.statusLabel);
    appendRow(kv, "Recorded", formatWhen(card.createdAt));
    appendRow(kv, "Package", packageLabel(card.packageId));
    appendRow(kv, "Renderer", rendererLabel(card.lane));
    appendRow(kv, "Triggered by", card.actor.attributed ? card.actor.label : "unattributed (no actor field on this receipt)");
    // Show the observed transport evidence on its own row so "BY WHO" also answers "HOW it arrived".
    if (card.actor.attributed && card.actor.via) appendRow(kv, "Via", card.actor.via);
    if (card.receiptPath) appendRow(kv, "Receipt file", card.receiptPath);
    overview.append(kv);
    ui.detailScroll.append(overview);

    // Encoder
    if (card.encoder) {
      const enc = section("Encoder");
      const kvEnc = el("table", "kv-table");
      appendRow(kvEnc, "Encoder", card.encoder.name || "—");
      appendRow(kvEnc, "Selection", card.encoder.reasonLabel);
      enc.append(kvEnc);
      if (card.encoder.fallback) {
        enc.append(el("div", "fallback-note", `Hardware encoder ${card.encoder.fallback.attemptedEncoder} was attempted and fell back to software${card.encoder.fallback.reason ? `: ${card.encoder.fallback.reason}` : "."}`));
      }
      ui.detailScroll.append(enc);
    }

    // Outputs
    if (card.outputs.length > 0) {
      const out = section("Outputs");
      const table = el("table", "data-table");
      const thead = el("thead");
      const hr = el("tr");
      ["Role", "Path", "Dimensions", "Status"].forEach((h) => hr.append(el("th", "", h)));
      thead.append(hr);
      const tbody = el("tbody");
      for (const output of card.outputs) {
        const tr = el("tr");
        tr.append(el("td", "", output.role || "—"));
        tr.append(el("td", "mono", output.path));
        tr.append(el("td", "", output.dimensionsLabel || "—"));
        tr.append(el("td", "", output.status || "—"));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      out.append(table);
      ui.detailScroll.append(out);
    }

    // Quality gates
    if (card.gates.checks.length > 0) {
      const gates = section("Quality checks");
      for (const check of card.gates.checks) {
        const note = el("div", "quality-note", `${check.label}: ${check.status}${check.message ? ` — ${check.message}` : ""}`);
        note.dataset.status = check.status;
        gates.append(note);
      }
      ui.detailScroll.append(gates);
    }

    // Input hashes
    if (card.inputHashes.length > 0) {
      const hashes = section("Input hashes");
      const table = el("table", "hash-table");
      for (const row of card.inputHashes) appendHashRow(table, row.key, row.hash);
      hashes.append(table);
      ui.detailScroll.append(hashes);
    }

    // Warnings
    if (card.warnings.length > 0) {
      const warns = section(`Warnings (${card.warnings.length})`);
      for (const warning of card.warnings) warns.append(el("div", "fallback-note", warning));
      ui.detailScroll.append(warns);
    }
  }

  function renderRaw(card) {
    ui.detailScroll.replaceChildren();
    const wrap = section("Raw receipt JSON");
    let json;
    try { json = JSON.stringify(card.raw, null, 2); } catch { json = String(card.raw); }
    wrap.append(el("pre", "json-block", json));
    ui.detailScroll.append(wrap);
  }

  function section(title) {
    const box = el("div", "detail-section");
    box.append(el("h3", "", title));
    return box;
  }

  function appendRow(table, key, value) {
    const tr = el("tr");
    tr.append(el("td", "", key), el("td", "", value));
    table.append(tr);
  }

  function appendHashRow(table, key, value) {
    const tr = el("tr");
    tr.append(el("td", "", key), el("td", "", value));
    table.append(tr);
  }

  // ----- events -----
  ui.reloadButton.addEventListener("click", () => void loadReceipts());
  ui.receiptsBrowse.addEventListener("click", async () => {
    try {
      const selected = await pickWorkbenchPath({ token: session.state.token, purpose: "receipts-root", currentPath: readWorkbenchPath(ui.receiptsRoot) });
      if (!selected) return;
      showWorkbenchPath(ui.receiptsRoot, selected, "No receipt location selected");
      await loadReceipts();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The system folder chooser could not be opened.");
    }
  });
  ui.packageFilter.addEventListener("change", renderTimeline);
  ui.operationFilter.addEventListener("change", renderTimeline);
  ui.statusFilter.addEventListener("change", renderTimeline);
  ui.rawToggle.addEventListener("click", () => {
    if (!stateStore.activeCard) return;
    stateStore.rawVisible = !stateStore.rawVisible;
    ui.rawToggle.textContent = stateStore.rawVisible ? "Show structured view" : "Show raw JSON";
    if (stateStore.rawVisible) renderRaw(stateStore.activeCard);
    else renderDetail(stateStore.activeCard);
  });

  // ----- boot -----
  session.wire();
  const requestedRoot = new URLSearchParams(location.search).get("receiptsRoot");
  if (requestedRoot) showWorkbenchPath(ui.receiptsRoot, requestedRoot, "No receipt location selected");
  // Render the disconnected phase from the model before the session resolves, so
  // the markup's pre-script copy is never the thing the user ends up reading.
  setPhase("disconnected");
  session.boot();
})();
