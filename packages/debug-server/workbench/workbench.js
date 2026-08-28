import { pickWorkbenchPath, readWorkbenchPath, showWorkbenchPath } from "/workbench-path-picker.js";
import { claimWorkbenchBootstrap } from "/workbench-session.js";

/**
 * workbench.js — DOM controller for the ShellX Motion Inspector workbench.
 *
 * Role: the human-facing package → timeline → preview → render surface over the
 * authenticated loopback Debug API. Everything visible comes from a real command
 * response; nothing is invented and nothing reports success without a receipt.
 *
 * Several bindings in here are *contract* bindings — they read a published Debug API
 * response shape and are lifted out of this file verbatim by
 * `packages/debug-server/src/workbench-contract.test.ts`, which runs them against a
 * REAL server response. They are marked `@contract` and kept self-contained (no
 * closure dependencies) precisely so that test can extract and execute them:
 *
 *   - readReceiptsPanelRows   ← motion.receipts.panel
 *   - motionDensityRequirement ← motion.timeline.panel (drives the render gate)
 *   - readJobStatusView       ← motion.job.get
 *   - readGpuReadinessView    ← motion.platform.requirements (source-only GPU proof state)
 *   - readActiveGpuProofView  ← motion.platform.gpu.probe (active hardware proof state)
 *
 * Transport: POST /debug (commands), GET /debug/contracts (grant + the host's own
 * receipts root), GET /workbench/artifact (preview frames). Primary caller: served
 * at /workbench.
 */
(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = {
    token: sessionStorage.getItem("shellx-motion-capability") || "",
    connected: false,
    grantedTier: "",
    packageRoot: "",
    package: null,
    timeline: null,
    preview: null,
    assets: null,
    selectedLayerId: null,
    playheadMs: 0,
    durationMs: 0,
    fps: 30,
    zoom: 1,
    playing: false,
    // GPU is an explicit strict lane choice. It is never selected as a fallback
    // when the browser preview refuses or fails.
    previewLane: "browser",
    previewBusy: false,
    previewObjectUrl: null,
    playTimer: null,
    scrubTimer: null,
    warnings: [],
    /**
     * The in-flight final render, or null.
     * `{ jobId, watching, observed, ended }` — `watching` is what the poll loop
     * checks, `observed` records that motion.job.get has answered at least once
     * (so a later job_unknown is a real disappearance, not the pre-announce gap).
     */
    render: null
  };

  const ui = {
    shell: $("#appShell"),
    sessionState: $("#sessionState"),
    sessionButton: $("#sessionButton"),
    refreshButton: $("#refreshButton"),
    renderButton: $("#renderButton"),
    packageForm: $("#packageForm"),
    packageRoot: $("#packageRoot"),
    packageBrowse: $("#packageBrowse"),
    packageList: $("#packageList"),
    packageCount: $("#packageCount"),
    accessSummary: $("#accessSummary"),
    documentName: $("#documentName"),
    documentMeta: $("#documentMeta"),
    previewButton: $("#previewButton"),
    previewLaneButtons: $$("[data-preview-lane]"),
    previewRegion: $("#previewRegion"),
    previewStage: $("#previewStage"),
    previewImage: $("#previewImage"),
    previewSize: $("#previewSize"),
    stageEmpty: $("#stageEmpty"),
    stageProgress: $("#stageProgress"),
    stageProgressText: $("#stageProgress span"),
    playButton: $("#playButton"),
    scrubber: $("#scrubber"),
    timecode: $("#timecode"),
    durationCode: $("#durationCode"),
    timelineSummary: $("#timelineSummary"),
    timelineRuler: $("#timelineRuler"),
    timelineRows: $("#timelineRows"),
    timelineScroll: $("#timelineScroll"),
    playhead: $("#playhead"),
    zoomOut: $("#zoomOut"),
    zoomIn: $("#zoomIn"),
    zoomValue: $("#zoomValue"),
    selectionName: $("#selectionName"),
    propertyList: $("#propertyList"),
    diagnostics: $("#diagnostics"),
    gpuReadiness: $("#gpuReadiness"),
    gpuReadinessLabel: $("#gpuReadinessLabel"),
    gpuReadinessDetail: $("#gpuReadinessDetail"),
    gpuProofButton: $("#gpuProofButton"),
    receiptsRoot: $("#receiptsRoot"),
    receiptsBrowse: $("#receiptsBrowse"),
    queueList: $("#queueList"),
    receiptList: $("#receiptList"),
    statusMessage: $("#statusMessage"),
    statusDetail: $("#statusDetail"),
    connectDialog: $("#connectDialog"),
    connectForm: $("#connectForm"),
    capabilityToken: $("#capabilityToken"),
    connectError: $("#connectError"),
    renderDialog: $("#renderDialog"),
    renderForm: $("#renderForm"),
    renderPackageName: $("#renderPackageName"),
    renderReadiness: $("#renderReadiness"),
    renderReadinessLabel: $("#renderReadinessLabel"),
    renderReadinessDetail: $("#renderReadinessDetail"),
    renderOutputPath: $("#renderOutputPath"),
    renderOutputBrowse: $("#renderOutputBrowse"),
    renderFrameLane: $("#renderFrameLane"),
    renderPreset: $("#renderPreset"),
    gpuFinalContract: $("#gpuFinalContract"),
    renderGpuReadiness: $("#renderGpuReadiness"),
    renderGpuReadinessLabel: $("#renderGpuReadinessLabel"),
    renderGpuReadinessDetail: $("#renderGpuReadinessDetail"),
    qualityManifestField: $("#qualityManifestField"),
    qualityManifestPath: $("#qualityManifestPath"),
    qualityManifestBrowse: $("#qualityManifestBrowse"),
    qualityManifestNote: $("#qualityManifestNote"),
    motionGate: $("#motionGate"),
    motionGateNote: $("#motionGateNote"),
    renderError: $("#renderError"),
    renderProgress: $("#renderProgress"),
    renderProgressLabel: $("#renderProgressLabel"),
    renderProgressDetail: $("#renderProgressDetail"),
    renderJob: $("#renderJob"),
    renderJobId: $("#renderJobId"),
    renderCancelButton: $("#renderCancelButton"),
    renderSubmitButton: $("#renderSubmitButton"),
    receiptsSummary: $("#receiptsSummary"),
    toast: $("#toast")
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function text(value, fallback = "—") {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function number(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  // ===========================================================================
  // Published-contract readers (see the file header).
  //
  // Self-contained on purpose: `workbench-contract.test.ts` lifts each function
  // out of this source by its `@contract` marker and runs it against a response
  // produced by a real running debug server. Do not make them depend on the
  // closure helpers above, or the contract test can no longer execute them.
  // ===========================================================================

  /**
   * @contract motion.receipts.panel
   *
   * The panel result is `{ ok, receiptsRoot, receiptCount, failedCount,
   * warningCount, artifactCount, statusCounts, operationCounts, failedReceipts,
   * warningReceipts, warnings, artifacts, recentReceipts }`. The listable rows
   * are `recentReceipts` — capped by the request's `limit`, which is why
   * `receiptCount` can exceed `rows.length` and must be reported separately.
   *
   * This binding previously read `result.receipts` / `result.rows`, neither of
   * which the panel has ever emitted, so every valid receipt rendered as
   * "No receipts found".
   *
   * @param {unknown} result The `result` object of a motion.receipts.panel response.
   * @returns {{rows: object[], receiptCount: number, failedCount: number, warningCount: number, truncated: boolean}}
   */
  function readReceiptsPanelRows(result) {
    const panel = result && typeof result === "object" && !Array.isArray(result) ? result : {};
    const rows = Array.isArray(panel.recentReceipts) ? panel.recentReceipts : [];
    const count = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
    const receiptCount = count(panel.receiptCount, rows.length);
    return {
      rows,
      receiptCount,
      failedCount: count(panel.failedCount, 0),
      warningCount: count(panel.warningCount, 0),
      truncated: receiptCount > rows.length
    };
  }

  /**
   * @contract motion.timeline.panel
   *
   * Decide whether a package actually declares motion, which is what makes a
   * unique-frame gate meaningful. A static title card, hold or freeze frame is
   * valid output: gating it on `minUniqueFrameHashes >= 2` fails a render that
   * did exactly what the package asked for. The engine already reports a static
   * sequence as a warning either way, so nothing is hidden when the gate is off.
   *
   * A package declares motion when any of these is true:
   *  - a layer carries keyframes (`counts.keyframedLayers`);
   *  - a layer carries an in/out transition (`layers[].transitionKinds`);
   *  - it contains a video layer (moving source material);
   *  - a layer enters after the start or leaves before the end, so the composition
   *    visibly changes across the sequence.
   *
   * @param {unknown} timelinePanel The `result` object of a motion.timeline.panel response.
   * @returns {{requiresMotion: boolean, reasons: string[]}}
   */
  function motionDensityRequirement(timelinePanel) {
    const panel = timelinePanel && typeof timelinePanel === "object" && !Array.isArray(timelinePanel) ? timelinePanel : {};
    const counts = panel.counts && typeof panel.counts === "object" && !Array.isArray(panel.counts) ? panel.counts : {};
    const layers = Array.isArray(panel.layers) ? panel.layers : [];
    const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const durationMs = num(panel.durationMs);
    const reasons = [];

    const keyframed = num(counts.keyframedLayers);
    if (keyframed > 0) reasons.push(`${keyframed} keyframed layer${keyframed === 1 ? "" : "s"}`);

    const transitioned = layers.filter((layer) => {
      const kinds = layer && typeof layer === "object" ? layer.transitionKinds : null;
      return Array.isArray(kinds) && kinds.length > 0;
    }).length;
    if (transitioned > 0) reasons.push(`${transitioned} layer${transitioned === 1 ? "" : "s"} with transitions`);

    const videoLayers = num(counts.videoLayers);
    if (videoLayers > 0) reasons.push(`${videoLayers} video layer${videoLayers === 1 ? "" : "s"}`);

    const timed = layers.filter((layer) => {
      if (!layer || typeof layer !== "object") return false;
      const startMs = num(layer.startMs);
      const endMs = typeof layer.endMs === "number" ? num(layer.endMs) : startMs + num(layer.durationMs);
      return startMs > 0 || (durationMs > 0 && endMs < durationMs);
    }).length;
    if (timed > 0) reasons.push(`${timed} layer${timed === 1 ? "" : "s"} enter or leave mid-sequence`);

    return { requiresMotion: reasons.length > 0, reasons };
  }

  /**
   * @contract motion.job.get
   *
   * Read one live job into the four things a progress UI must show, exactly as
   * `docs/public/cut-job-integration-spec.md` defines them:
   *  - switch on `state` (pending | running | succeeded | failed | cancelled | skipped);
   *  - `pending` means waiting for a machine slot with NOTHING being produced —
   *    it must not be reported as "rendering";
   *  - the absence of `pollAfterMs` is the machine-readable "this will not change
   *    again", so it is what stops the poll loop;
   *  - `startedAtMs` is absent while pending.
   *
   * @param {unknown} job The `result.job` object of a motion.job.get response.
   * @returns {{state: string, ended: boolean, started: boolean, pollAfterMs: number, label: string, detail: string}}
   */
  function readJobStatusView(job) {
    const record = job && typeof job === "object" && !Array.isArray(job) ? job : {};
    const known = ["pending", "running", "succeeded", "failed", "cancelled", "skipped"];
    const state = typeof record.state === "string" && known.includes(record.state) ? record.state : "unknown";
    const pollAfterMs = typeof record.pollAfterMs === "number" && Number.isFinite(record.pollAfterMs) && record.pollAfterMs > 0
      ? record.pollAfterMs
      : 0;
    const lane = typeof record.lane === "string" && record.lane ? record.lane : "";
    const operation = typeof record.operation === "string" && record.operation ? record.operation : "";
    const queueWaitMs = typeof record.queueWaitMs === "number" && Number.isFinite(record.queueWaitMs) ? record.queueWaitMs : null;
    const errorMessage = record.error && typeof record.error === "object" && typeof record.error.message === "string"
      ? record.error.message
      : "";
    const labels = {
      pending: "Queued",
      running: "Rendering",
      succeeded: "Render finished",
      failed: "Render failed",
      cancelled: "Render cancelled",
      skipped: "Render skipped",
      unknown: "Job state unavailable"
    };
    const details = {
      // Nothing is being produced yet — saying "rendering" here would be a lie.
      pending: "Waiting for a machine slot. No frames are being produced yet.",
      running: `Producing frames${lane ? ` on the ${lane} lane` : ""}${operation ? ` · ${operation}` : ""}.`,
      succeeded: queueWaitMs === null ? "The engine reported success." : `Queued ${queueWaitMs} ms before work began.`,
      failed: errorMessage || "The engine reported a failure.",
      cancelled: "The job was stopped before it finished.",
      skipped: "The engine skipped this job.",
      unknown: "The job record did not carry a recognised state."
    };
    return {
      state,
      // `pollAfterMs` absent is the contract's terminal signal; the lifecycle
      // field is only a cross-check for a record that omitted the interval.
      ended: pollAfterMs === 0 || record.lifecycle === "ended",
      started: typeof record.startedAtMs === "number" && Number.isFinite(record.startedAtMs),
      pollAfterMs,
      label: labels[state],
      detail: details[state]
    };
  }

  /**
   * Dispatch an authenticated Debug API command over loopback JSON.
   *
   * A rejected call carries the server's typed `code` on the thrown Error, because
   * callers such as the job poll loop must distinguish `job_unknown` (not yet
   * announced, or genuinely gone) from a transport failure.
   */
  async function api(command, args = {}, requestedTier = "read_motion") {
    if (!state.token) throw new Error("Connect to Motion first.");
    const response = await fetch("/debug", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${state.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ command, args, requestedTier })
    });
    const body = await response.json().catch(() => ({ ok: false, error: { message: "Motion did not return a readable response." } }));
    if (response.status === 401) disconnect("The local access key was rejected.");
    if (!response.ok || body.ok !== true) {
      const error = object(body.error);
      const failure = new Error(text(error.message, "The Motion action failed."));
      failure.code = text(error.code, "");
      failure.suggestedAction = text(error.suggestedAction, "");
      throw failure;
    }
    return body;
  }

  function setStatus(message, detail = "ShellX Motion") {
    ui.statusMessage.textContent = message;
    ui.statusDetail.textContent = detail;
  }

  function accessLabel(tier) {
    const labels = {
      read_motion: "Read access",
      draft_motion: "Draft access",
      render_motion: "Render access",
      edit_motion: "Edit access",
      write_local: "Local write access",
      push_remote: "Remote publish access"
    };
    return labels[tier] || "Secure access";
  }

  function setConnected(connected, grantedTier = "") {
    state.connected = connected;
    if (connected) state.grantedTier = grantedTier;
    ui.shell.dataset.state = connected ? "ready" : "disconnected";
    ui.sessionState.lastChild.textContent = connected ? "Ready" : "Disconnected";
    ui.sessionButton.textContent = connected ? "Disconnect" : "Connect";
    ui.packageBrowse.disabled = !connected;
    ui.accessSummary.textContent = connected ? accessLabel(grantedTier) : "Secure workspace";
    updateActionAvailability();
  }

  function updateActionAvailability() {
    const ready = state.connected && Boolean(state.packageRoot);
    ui.refreshButton.disabled = !ready;
    ui.previewButton.disabled = !ready || state.previewBusy;
    ui.renderButton.disabled = !ready;
    ui.playButton.disabled = !ready || state.durationMs <= 0;
    ui.scrubber.disabled = !ready || state.durationMs <= 0;
    ui.zoomIn.disabled = !state.timeline;
    ui.zoomOut.disabled = !state.timeline;
    ui.gpuProofButton.disabled = !state.connected || !tierAllows(state.grantedTier, "render_motion");
  }

  function tierAllows(granted, required) {
    const order = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];
    return order.indexOf(granted) >= order.indexOf(required) && order.indexOf(required) >= 0;
  }

  async function connect(token) {
    state.token = token.trim();
    ui.connectError.hidden = true;
    try {
      const response = await fetch("/debug/contracts", { headers: { authorization: `Bearer ${state.token}` } });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(text(object(body.error).message, "The local access key was rejected."));
      sessionStorage.setItem("shellx-motion-capability", state.token);
      setConnected(true, text(body.grantedTier, "read_motion"));
      ui.connectDialog.close();
      setStatus("Motion is ready.", accessLabel(text(body.grantedTier, "read_motion")));
      adoptHostReceiptsRoot(body);
      if (readWorkbenchPath(ui.packageRoot)) await openPackageRoot(readWorkbenchPath(ui.packageRoot));
    } catch (error) {
      state.token = "";
      sessionStorage.removeItem("shellx-motion-capability");
      ui.connectError.textContent = error instanceof Error ? error.message : String(error);
      ui.connectError.hidden = false;
      setConnected(false);
    }
  }

  /**
   * Adopt the receipt folder THIS server keeps its receipts in, published by `/debug/contracts`.
   *
   * The page used to start with a literal `.scratch/receipts` baked into the markup. A path the
   * browser invented is exactly what the Debug API's receipts-root fence refuses (a caller cannot
   * name a root; only the host can), so on any server whose receipts live elsewhere — which is every
   * shipped one — the queue and receipts panels could only ever answer with a refusal.
   *
   * A folder the person picked here wins: `operatorReceiptRoots` made that selection host-granted for
   * the session, and silently replacing it on every reconnect would undo a deliberate human choice.
   *
   * @param body The parsed `/debug/contracts` payload.
   */
  function adoptHostReceiptsRoot(body) {
    if (readWorkbenchPath(ui.receiptsRoot)) return;
    const hostRoot = text(object(body).receiptsRoot, "");
    if (!hostRoot) return;
    showWorkbenchPath(ui.receiptsRoot, hostRoot, "No receipt location selected");
  }

  function disconnect(reason = "Workbench disconnected.") {
    stopPlayback();
    state.token = "";
    state.connected = false;
    sessionStorage.removeItem("shellx-motion-capability");
    setConnected(false);
    setStatus(reason, "Start Motion to reconnect automatically");
  }

  async function openPackageRoot(root) {
    setStatus("Opening Motion package…", "Reading package and timeline");
    ui.packageBrowse.disabled = true;
    try {
      const response = await api("motion.packages.browse", { packageRoot: root });
      const result = object(response.result);
      const packages = list(result.packages);
      renderPackageList(packages);
      state.warnings = list(response.warnings).filter((entry) => typeof entry === "string");
      if (packages.length === 0) throw new Error("No valid Motion packages were found in that location.");
      await selectPackage(packages[0]);
    } catch (error) {
      showError(error);
      ui.packageList.replaceChildren(element("div", "empty-copy", error instanceof Error ? error.message : String(error)));
      ui.packageCount.textContent = "0";
    } finally {
      ui.packageBrowse.disabled = !state.connected;
    }
  }

  function renderPackageList(packages) {
    ui.packageList.replaceChildren();
    ui.packageCount.textContent = String(packages.length);
    for (const pkg of packages) {
      const row = element("button", "package-row");
      row.type = "button";
      row.dataset.packageRoot = text(pkg.packageRoot, "");
      row.setAttribute("role", "listitem");
      const icon = element("span", "package-icon", text(pkg.packageName, "M").slice(0, 1).toUpperCase());
      const copy = element("span");
      copy.append(element("strong", "", text(pkg.packageName, pkg.packageId)), element("span", "", `${number(pkg.layerCount)} layers · ${formatDuration(number(pkg.durationMs))}`));
      row.append(icon, copy);
      row.addEventListener("click", () => selectPackage(pkg));
      ui.packageList.append(row);
    }
  }

  async function selectPackage(pkg) {
    const root = text(pkg.packageRoot, readWorkbenchPath(ui.packageRoot));
    stopPlayback();
    state.package = pkg;
    state.packageRoot = root;
    state.selectedLayerId = null;
    state.timeline = null;
    state.preview = null;
    state.assets = null;
    state.durationMs = number(pkg.durationMs);
    state.fps = number(pkg.fps, 30);
    state.playheadMs = 0;
    showWorkbenchPath(ui.packageRoot, root, "No package selected");
    $$(".package-row").forEach((row) => row.classList.toggle("selected", row.dataset.packageRoot === root));
    ui.documentName.textContent = text(pkg.packageName, pkg.packageId);
    ui.documentMeta.textContent = `${number(pkg.size?.width)} × ${number(pkg.size?.height)} · ${number(pkg.fps, 30)} fps`;
    ui.renderPackageName.textContent = text(pkg.packageName, pkg.packageId);
    showWorkbenchPath(ui.renderOutputPath, `.scratch/workbench/exports/${safeFileToken(text(pkg.packageId, "motion"))}.mp4`, "Choose a destination");
    if (state.previewObjectUrl) URL.revokeObjectURL(state.previewObjectUrl);
    state.previewObjectUrl = null;
    ui.previewImage.removeAttribute("src");
    ui.previewImage.hidden = true;
    ui.stageEmpty.hidden = false;
    ui.stageEmpty.querySelector("strong").textContent = "Loading package";
    ui.stageEmpty.querySelector("span:last-child").textContent = "Preparing timeline, assets, and preview.";
    ui.timelineSummary.textContent = "Loading…";
    ui.timelineRows.replaceChildren(element("div", "empty-copy", "Loading package timeline…"));
    ui.playhead.hidden = true;
    ui.selectionName.textContent = text(pkg.packageName, pkg.packageId);
    ui.propertyList.replaceChildren();
    addProperty("Status", "Preparing package");
    renderDiagnostics();
    updateTransport();
    setStatus(`Loading ${text(pkg.packageName, pkg.packageId)}…`, root);
    updateActionAvailability();
    try {
      const [timelineResponse, previewResponse, assetsResponse] = await Promise.all([
        api("motion.timeline.panel", { packageRoot: root }),
        api("motion.preview.panel", { packageRoot: root }),
        api("motion.assets.panel", { packageRoot: root })
      ]);
      state.timeline = object(timelineResponse.result);
      state.preview = object(previewResponse.result);
      state.assets = object(assetsResponse.result);
      state.durationMs = number(state.timeline.durationMs, number(pkg.durationMs));
      state.fps = number(state.timeline.fps, number(pkg.fps, 30));
      state.playheadMs = Math.min(state.durationMs, number(object(state.timeline.controls).playheadMs));
      state.warnings = [
        ...state.warnings,
        ...list(timelineResponse.warnings),
        ...list(previewResponse.warnings),
        ...list(assetsResponse.warnings)
      ].filter((entry) => typeof entry === "string");
      renderTimeline();
      renderInspector(null);
      updateTransport();
      refreshMotionGate();
      setStatus(`Ready · ${number(object(state.timeline.counts).layers)} layers`, root);
      await renderPreviewFrame();
    } catch (error) {
      showError(error);
    } finally {
      updateActionAvailability();
    }
  }

  function renderTimeline() {
    const layers = list(state.timeline?.layers);
    const duration = Math.max(1, state.durationMs);
    ui.timelineRows.replaceChildren();
    ui.timelineSummary.textContent = `${layers.length} layers · ${formatDuration(duration)}`;
    ui.timelineScroll.style.setProperty("--timeline-width", `${Math.round(state.zoom * 100)}%`);
    ui.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
    renderRuler(duration);
    if (layers.length === 0) {
      ui.timelineRows.append(element("div", "empty-copy", "This package has no visible timeline layers."));
      return;
    }
    for (const layer of layers) {
      const row = element("div", "timeline-row");
      row.dataset.layerId = text(layer.id);
      row.classList.toggle("selected", layer.id === state.selectedLayerId);
      const label = element("button", "timeline-label");
      label.type = "button";
      label.append(element("span", "layer-kind", text(layer.type, "?").slice(0, 1)), element("span", "", text(layer.displayName, layer.textPreview || layer.id)));
      const track = element("div", "timeline-track");
      const clip = element("button", "layer-clip", text(layer.textPreview, layer.displayName || layer.id));
      clip.type = "button";
      clip.style.left = `${Math.max(0, number(layer.startMs) / duration * 100)}%`;
      clip.style.width = `${Math.max(.35, number(layer.durationMs) / duration * 100)}%`;
      const select = () => {
        state.selectedLayerId = text(layer.id);
        renderTimeline();
        renderInspector(layer);
      };
      label.addEventListener("click", select);
      clip.addEventListener("click", select);
      track.append(clip);
      row.append(label, track);
      ui.timelineRows.append(row);
    }
    ui.playhead.hidden = false;
    updatePlayhead();
  }

  function renderRuler(durationMs) {
    ui.timelineRuler.replaceChildren();
    const steps = 5;
    for (let index = 0; index < steps; index += 1) {
      ui.timelineRuler.append(element("span", "", `${(durationMs / 1000 * index / (steps - 1)).toFixed(index === steps - 1 ? 1 : 0)}s`));
    }
  }

  function renderInspector(layer, assetsResult = null) {
    const selected = layer || (state.selectedLayerId ? list(state.timeline?.layers).find((entry) => entry.id === state.selectedLayerId) : null);
    ui.propertyList.replaceChildren();
    if (selected) {
      ui.selectionName.textContent = text(selected.displayName, selected.textPreview || selected.id);
      addProperty("Layer", text(selected.id));
      addProperty("Type", text(selected.type));
      addProperty("Track", text(selected.trackId, "Unassigned"));
      addProperty("Start", formatDuration(number(selected.startMs)));
      addProperty("Duration", formatDuration(number(selected.durationMs)));
      addProperty("Keyframes", list(selected.keyframeTargets).length);
      addProperty("Transitions", list(selected.transitionKinds).join(", ") || "None");
    } else if (state.timeline) {
      const counts = object(state.timeline.counts);
      ui.selectionName.textContent = text(state.timeline.packageName, state.timeline.packageId);
      addProperty("Package", text(state.timeline.packageId));
      addProperty("Motion", text(state.timeline.motionId));
      addProperty("Canvas", `${number(state.timeline.size?.width)} × ${number(state.timeline.size?.height)}`);
      addProperty("Duration", formatDuration(number(state.timeline.durationMs)));
      addProperty("Frame rate", `${number(state.timeline.fps)} fps`);
      addProperty("Layers", number(counts.layers));
      addProperty("Scenes", number(counts.scenes));
      addProperty("Safe areas", number(counts.safeAreas));
    } else {
      ui.selectionName.textContent = "Nothing selected";
      addProperty("Status", "Waiting for a package");
    }
    renderDiagnostics(assetsResult);
  }

  function addProperty(label, value) {
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    ui.propertyList.append(row);
  }

  function renderDiagnostics(assetsResult = state.assets) {
    ui.diagnostics.replaceChildren();
    const diagnostics = [];
    const missingAssets = number(assetsResult?.missingAssetCount);
    if (missingAssets > 0) diagnostics.push({ kind: "error", text: `${missingAssets} declared asset${missingAssets === 1 ? " is" : "s are"} missing.` });
    if (state.warnings.length) diagnostics.push(...state.warnings.slice(0, 5).map((warning) => ({ kind: "warning", text: warning })));
    if (!diagnostics.length && state.timeline) diagnostics.push({ kind: "success", text: "Package, timeline, and preview are ready." });
    if (!diagnostics.length) diagnostics.push({ kind: "neutral", text: "No diagnostics yet" });
    for (const diagnostic of diagnostics) ui.diagnostics.append(element("span", `diagnostic ${diagnostic.kind}`, diagnostic.text));
  }

  async function renderPreviewFrame() {
    if (!state.packageRoot || state.previewBusy) return;
    const requestedAtMs = Math.round(state.playheadMs);
    const lane = state.previewLane === "gpu" ? "gpu" : "browser";
    const laneLabel = lane === "gpu" ? "strict GPU" : "browser";
    state.previewBusy = true;
    ui.previewRegion.setAttribute("aria-label", `${lane === "gpu" ? "Strict GPU" : "Browser"} preview monitor`);
    ui.stageProgress.setAttribute("aria-label", `Rendering ${laneLabel} preview`);
    ui.stageProgressText.textContent = `Rendering ${laneLabel} preview`;
    ui.stageProgress.hidden = false;
    ui.stageEmpty.hidden = true;
    updateActionAvailability();
    setStatus(
      lane === "gpu" ? `Rendering strict GPU frame at ${formatDuration(requestedAtMs)}…` : `Rendering frame at ${formatDuration(requestedAtMs)}…`,
      lane === "gpu" ? "No browser or CPU fallback is requested" : "Preparing a local preview"
    );
    try {
      const response = await api("motion.preview.frame", { packageRoot: state.packageRoot, lane, atMs: requestedAtMs }, "render_motion");
      const result = object(response.result);
      const output = object(result.output);
      const path = text(output.path, text(result.outputPath, ""));
      if (!path) throw new Error("Motion did not return a preview image.");
      const artifact = await fetch(`/workbench/artifact?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${state.token}` } });
      if (!artifact.ok) {
        const failure = await artifact.json().catch(() => null);
        throw new Error(text(object(failure?.error).message, "The preview image could not be loaded."));
      }
      const blob = await artifact.blob();
      if (state.previewObjectUrl) URL.revokeObjectURL(state.previewObjectUrl);
      state.previewObjectUrl = URL.createObjectURL(blob);
      ui.previewImage.src = state.previewObjectUrl;
      ui.previewImage.alt = lane === "gpu" ? "Strict GPU-rendered Motion preview" : "Browser-rendered Motion preview";
      ui.previewImage.hidden = false;
      ui.previewSize.textContent = `${number(output.width, number(state.timeline?.size?.width))} × ${number(output.height, number(state.timeline?.size?.height))}`;
      state.warnings = [...new Set([
        ...state.warnings,
        ...list(response.warnings).filter((entry) => typeof entry === "string")
      ])];
      renderDiagnostics();
      setStatus(
        `${lane === "gpu" ? "Strict GPU preview" : "Preview"} ready at ${formatDuration(requestedAtMs)}.`,
        text(response.receiptId, "preview receipt")
      );
    } catch (error) {
      ui.stageEmpty.hidden = false;
      ui.stageEmpty.querySelector("strong").textContent = lane === "gpu" ? "Strict GPU preview refused" : "Preview unavailable";
      ui.stageEmpty.querySelector("span:last-child").textContent = error instanceof Error ? error.message : String(error);
      showError(error);
    } finally {
      state.previewBusy = false;
      ui.stageProgress.hidden = true;
      updateActionAvailability();
    }
  }

  function selectPreviewLane(value) {
    const lane = value === "gpu" ? "gpu" : "browser";
    state.previewLane = lane;
    ui.previewRegion.setAttribute("aria-label", `${lane === "gpu" ? "Strict GPU" : "Browser"} preview monitor`);
    for (const button of ui.previewLaneButtons) {
      const selected = button.dataset.previewLane === lane;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    // A frame from the prior lane must not remain labelled as a result of the newly selected one.
    ui.previewImage.hidden = true;
    ui.stageEmpty.hidden = false;
    ui.stageEmpty.querySelector("strong").textContent = lane === "gpu" ? "Strict GPU preview selected" : "Browser preview selected";
    ui.stageEmpty.querySelector("span:last-child").textContent = lane === "gpu"
      ? "Refresh the frame to ask Motion for the GPU lane. Any refusal remains in this lane; no fallback is requested."
      : "Refresh the frame to ask Motion for the browser lane.";
    setStatus(
      lane === "gpu" ? "Strict GPU preview selected." : "Browser preview selected.",
      lane === "gpu" ? "Checking source-only readiness; no hardware availability is inferred" : "Refresh the frame to render"
    );
    if (lane === "gpu") void showGpuReadiness();
  }

  function setPlayhead(value, render = false) {
    state.playheadMs = Math.max(0, Math.min(state.durationMs, value));
    updateTransport();
    if (render) {
      clearTimeout(state.scrubTimer);
      state.scrubTimer = setTimeout(renderPreviewFrame, 220);
    }
  }

  function updateTransport() {
    const duration = Math.max(1, state.durationMs);
    const progress = state.playheadMs / duration;
    ui.scrubber.max = String(Math.round(duration));
    ui.scrubber.value = String(Math.round(state.playheadMs));
    ui.scrubber.style.setProperty("--progress", `${progress * 100}%`);
    ui.timecode.textContent = formatTimecode(state.playheadMs, state.fps);
    ui.durationCode.textContent = formatTimecode(state.durationMs, state.fps);
    updatePlayhead();
  }

  function updatePlayhead() {
    const progress = state.durationMs > 0 ? state.playheadMs / state.durationMs * 100 : 0;
    ui.playhead.style.setProperty("--playhead-x", `${progress}%`);
  }

  function togglePlayback() {
    if (state.playing) stopPlayback();
    else startPlayback();
  }

  function startPlayback() {
    if (!state.packageRoot || state.durationMs <= 0) return;
    if (state.playheadMs >= state.durationMs) setPlayhead(0);
    state.playing = true;
    ui.playButton.classList.add("playing");
    ui.playButton.setAttribute("aria-label", "Pause");
    const startedAt = performance.now();
    const initial = state.playheadMs;
    let lastPreviewAt = -1000;
    const tick = (now) => {
      if (!state.playing) return;
      const elapsed = now - startedAt;
      setPlayhead(initial + elapsed);
      if (elapsed - lastPreviewAt >= 650 && !state.previewBusy) {
        lastPreviewAt = elapsed;
        void renderPreviewFrame();
      }
      if (state.playheadMs >= state.durationMs) stopPlayback();
      else state.playTimer = requestAnimationFrame(tick);
    };
    state.playTimer = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    state.playing = false;
    if (state.playTimer) cancelAnimationFrame(state.playTimer);
    state.playTimer = null;
    ui.playButton.classList.remove("playing");
    ui.playButton.setAttribute("aria-label", "Play");
  }

  async function loadQueue() {
    if (!state.connected) return;
    // No receipt folder means nothing to read a job history out of. Say so, rather than dispatching a
    // call with an invented root that the host's receipts fence can only refuse.
    const root = readWorkbenchPath(ui.receiptsRoot);
    if (!root) {
      ui.queueList.replaceChildren(element("div", "empty-copy", "Choose a receipt location to see render jobs."));
      return;
    }
    ui.queueList.replaceChildren(element("div", "empty-copy", "Loading render jobs…"));
    try {
      const response = await api("motion.render.queue", { receiptsRoot: root });
      const jobs = list(object(response.result).jobs);
      renderOperations(ui.queueList, jobs, "No receipt-backed render jobs found.");
    } catch (error) {
      ui.queueList.replaceChildren(element("div", "empty-copy", error instanceof Error ? error.message : String(error)));
    }
  }

  async function loadReceipts() {
    if (!state.connected) return;
    // Same reason as loadQueue: `motion.receipts.panel` requires a root, and the only root this page
    // may name is one the host published or a person picked.
    const root = readWorkbenchPath(ui.receiptsRoot);
    if (!root) {
      ui.receiptsSummary.textContent = "";
      ui.receiptList.replaceChildren(element("div", "empty-copy", "Choose a receipt location to see receipts."));
      return;
    }
    ui.receiptList.replaceChildren(element("div", "empty-copy", "Loading receipts…"));
    ui.receiptsSummary.textContent = "";
    const limit = 20;
    try {
      const response = await api("motion.receipts.panel", { receiptsRoot: root, limit });
      const panel = readReceiptsPanelRows(response.result);
      renderOperations(ui.receiptList, panel.rows, "No receipts found in this location.");
      // Say what is on disk, not only what is listed: `recentReceipts` is capped by
      // `limit`, so a bare row count would under-report a busy root.
      ui.receiptsSummary.textContent = panel.receiptCount === 0
        ? ""
        : `${panel.rows.length} of ${panel.receiptCount} receipt${panel.receiptCount === 1 ? "" : "s"}`
          + (panel.failedCount > 0 ? ` · ${panel.failedCount} failed` : "")
          + (panel.warningCount > 0 ? ` · ${panel.warningCount} with warnings` : "");
    } catch (error) {
      ui.receiptsSummary.textContent = "";
      ui.receiptList.replaceChildren(element("div", "empty-copy", error instanceof Error ? error.message : String(error)));
    }
  }

  function renderOperations(container, rows, emptyMessage) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(element("div", "empty-copy", emptyMessage));
      return;
    }
    for (const row of rows) {
      const item = element("div", "operation-row");
      const head = element("div");
      const operation = text(row.operation, text(row.id, text(row.receiptId, "Motion operation")));
      const status = text(row.state, text(row.status, "recorded"));
      head.append(element("strong", "", operation), element("span", `status-chip ${safeFileToken(status)}`, status));
      item.append(head, element("span", "", text(row.outputPath, text(row.createdAt, text(row.packageId, "Local receipt")))));
      container.append(item);
    }
  }

  /**
   * A job id the workbench owns from before the work starts.
   *
   * The engine accepts a caller-supplied `jobId` on motion.render.final, which is
   * the only way to watch a render that has not returned yet: the id exists before
   * the request is sent, so motion.job.get can be polled from the first moment.
   * Shape is constrained to `[A-Za-z0-9._:-]` by the engine's id validator.
   */
  function newRenderJobId() {
    const source = globalThis.crypto;
    let suffix;
    if (source && typeof source.getRandomValues === "function") {
      const random = new Uint8Array(6);
      source.getRandomValues(random);
      suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } else {
      // Without a CSPRNG the id only has to be unique, not unguessable: it names a
      // local job, and the capability token is what authorises reading it.
      suffix = Math.random().toString(36).slice(2, 14);
    }
    return `workbench:render-${Date.now().toString(36)}-${suffix}`;
  }

  /** Reflect the derived motion gate into the render dialog before a render starts. */
  function refreshMotionGate() {
    const requirement = motionDensityRequirement(state.timeline);
    const preset = ui.renderPreset.value;
    // A single still frame has no sequence to compare, so the gate is meaningless
    // for it regardless of what the package declares.
    const applicable = preset !== "png-frame";
    ui.motionGate.disabled = !applicable;
    ui.motionGate.checked = applicable && requirement.requiresMotion;
    ui.motionGateNote.textContent = !applicable
      ? "A single still frame has no frame sequence to compare."
      : requirement.requiresMotion
        ? `This package declares motion (${requirement.reasons.join(", ")}), so a render that produced one unchanging frame would be a dead render.`
        : "This package declares no motion — a title card, hold, or freeze frame renders one unchanging frame legitimately. The engine still reports a static sequence as a warning.";
  }

  /** Enable/disable the render form for an in-flight render, leaving Stop watching live. */
  function setRenderFormBusy(busy) {
    $$("#renderForm input, #renderForm select").forEach((control) => { control.disabled = busy; });
    ui.renderOutputBrowse.disabled = busy;
    ui.qualityManifestBrowse.disabled = busy;
    ui.renderSubmitButton.disabled = busy;
    // Deliberately NOT disabled: it is the only control that still does something
    // while a render is in flight.
    ui.renderCancelButton.disabled = false;
    ui.renderCancelButton.textContent = busy ? "Stop watching" : "Cancel";
    if (!busy) {
      refreshMotionGate();
      synchronizeGpuFinalControls();
    }
  }

  function setRenderProgress(label, detail) {
    ui.renderProgress.hidden = false;
    ui.renderProgressLabel.textContent = label;
    ui.renderProgressDetail.textContent = detail;
  }

  /**
   * Watch a named render job through the shared job contract.
   *
   * Runs beside the blocking motion.render.final request rather than after it —
   * that request only returns once the work is over, which is too late to be
   * progress. Stops when the contract says the job will not change again
   * (`pollAfterMs` absent), when the watcher is dismissed, or when the render
   * request itself has already settled.
   */
  async function watchRenderJob(jobId) {
    const watching = () => state.render && state.render.jobId === jobId && state.render.watching;
    // First look sooner than the contract interval: the lease may not exist for a
    // few hundred ms, and a fast failure should not sit behind a 2 s wait.
    let delayMs = 700;
    while (watching()) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!watching()) return;
      try {
        const response = await api("motion.job.get", { jobId }, "read_motion");
        // The watcher can be dismissed during the await, which drops state.render —
        // re-check before touching it or the UI it owns.
        if (!watching()) return;
        const view = readJobStatusView(object(response.result).job);
        state.render.observed = true;
        setRenderProgress(view.label, view.detail);
        setStatus(view.label, view.detail);
        if (view.ended) return;
        delayMs = Math.max(500, view.pollAfterMs || 2000);
      } catch (error) {
        if (!watching()) return;
        const code = error && typeof error === "object" ? String(error.code || "") : "";
        if (code === "job_unknown" && !state.render.observed) {
          // Expected gap: the engine announces the lease as the dispatch begins.
          setRenderProgress("Submitting", "Waiting for the engine to register the job.");
          delayMs = 700;
          continue;
        }
        // job_expired / job_not_visible / transport failures describe the QUERY,
        // never the render, so they must not be reported as a failed render.
        setRenderProgress("Job status unavailable", error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  async function submitRender() {
    const outputPath = readWorkbenchPath(ui.renderOutputPath);
    const preset = ui.renderPreset.value;
    const frameLane = ui.renderFrameLane.value === "gpu" ? "gpu" : "browser";
    const manifest = readWorkbenchPath(ui.qualityManifestPath);
    if (frameLane === "gpu" && !["mp4-h264", "webm-vp9", "webm-vp9-alpha", "mov-prores"].includes(preset)) {
      ui.renderError.textContent = "Strict GPU final rendering accepts streamed FFmpeg video presets only.";
      ui.renderError.hidden = false;
      return;
    }
    const jobId = newRenderJobId();
    ui.renderError.hidden = true;
    ui.renderJob.hidden = false;
    ui.renderJobId.textContent = jobId;
    state.render = { jobId, watching: true, observed: false };
    setRenderFormBusy(true);
    setRenderProgress("Submitting", "Waiting for the engine to register the job.");
    setStatus("Render submitted.", "Waiting for Motion to begin");
    // The request blocks until the render is over. Start the watcher first so the
    // job's pending/running state is visible while that request is outstanding.
    const rendering = api("motion.render.final", {
      packageRoot: state.packageRoot,
      outputPath,
      preset,
      frameLane,
      jobId,
      // Named only when this page actually has a root (host-published or person-picked). An empty
      // string here would be a root nobody chose; omitting it lets the host decide where the receipt
      // lands, which is what the fence's own refusal tells a caller to do.
      ...(readWorkbenchPath(ui.receiptsRoot) ? { receiptsRoot: readWorkbenchPath(ui.receiptsRoot) } : {}),
      // Only gate frame-to-frame change when the package actually declares motion:
      // a static title card renders one unchanging frame legitimately.
      ...(ui.motionGate.checked && !ui.motionGate.disabled ? { minUniqueFrameHashes: 2 } : {}),
      // GPU final deliberately owns no exact-source materialized frames. The engine refuses a
      // manifest too; omitting it here makes the Workbench's request truthful before it reaches it.
      ...(manifest && frameLane !== "gpu" ? { qualityManifestPath: manifest } : {})
    }, "render_motion");
    void watchRenderJob(jobId);
    try {
      const response = await rendering;
      if (state.render?.jobId === jobId) ui.renderDialog.close();
      showToast(`Render passed · ${text(response.receiptId, outputPath)}`);
      setStatus("Final render completed.", outputPath);
      await loadQueue();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state.render?.jobId === jobId) {
        ui.renderError.textContent = message;
        ui.renderError.hidden = false;
      } else {
        showToast(`Render failed · ${message}`);
      }
      setStatus("Final render failed.", message);
    } finally {
      if (state.render?.jobId === jobId) {
        state.render.watching = false;
        state.render = null;
        ui.renderProgress.hidden = true;
        setRenderFormBusy(false);
      }
    }
  }

  /**
   * Stop watching the in-flight render.
   *
   * This is NOT a cancellation and does not claim to be one: Motion exposes no
   * cross-process cancel verb for a render already in flight (motion.render.cancel
   * acts on a receipt, which does not exist until the render has finished). The
   * render continues; the workbench stops waiting on it and keeps the job id so it
   * can be looked up with motion.job.get.
   */
  function stopWatchingRender() {
    const active = state.render;
    if (!active) { ui.renderDialog.close(); return; }
    active.watching = false;
    state.render = null;
    ui.renderProgress.hidden = true;
    setRenderFormBusy(false);
    ui.renderDialog.close();
    showToast("Closed the progress view. The render is still running in the background.");
    setStatus("Render continues in the background.", "You can review it later in Queue or History");
  }

  function openRenderDialog() {
    if (!state.packageRoot) return;
    ui.renderError.hidden = true;
    ui.renderProgress.hidden = true;
    ui.renderJob.hidden = true;
    setRenderFormBusy(false);
    synchronizeGpuFinalControls();
    ui.renderDialog.showModal();
    updateGpuReadinessAnnouncement();
    ui.renderOutputBrowse.focus();
    void showRenderReadiness();
  }

  function synchronizeGpuFinalControls() {
    const gpu = ui.renderFrameLane.value === "gpu";
    const gpuVideoPresets = new Set(["mp4-h264", "webm-vp9", "webm-vp9-alpha", "mov-prores"]);
    for (const option of ui.renderPreset.options) option.disabled = gpu && !gpuVideoPresets.has(option.value);
    if (gpu && !gpuVideoPresets.has(ui.renderPreset.value)) ui.renderPreset.value = "mp4-h264";
    ui.gpuFinalContract.hidden = !gpu;
    ui.renderGpuReadiness.hidden = !gpu;
    ui.qualityManifestField.dataset.unavailable = String(gpu);
    ui.qualityManifestBrowse.disabled = gpu;
    ui.qualityManifestNote.hidden = !gpu;
    updateRenderExtension();
    updateGpuReadinessAnnouncement();
  }

  /**
   * @contract motion.platform.requirements → GPU source-only readiness.
   *
   * The platform response is deliberately not a GPU launch. It may identify a trusted Chromium
   * executable, but that is not evidence that an adapter or device was selected. This binding
   * keeps the distinction visible and preserves the engine's typed refusal text verbatim.
   */
  function readGpuReadinessView(result) {
    const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    const message = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
    const answer = record(result);
    const gpu = record(answer.gpu);
    const refusals = Array.isArray(gpu.refusals)
      ? gpu.refusals.map(record).map((refusal) => ({ code: message(refusal.code), message: message(refusal.message) })).filter((refusal) => refusal.code || refusal.message)
      : [];
    if (answer.ok !== true || typeof gpu.status !== "string") {
      return {
        state: "unverified",
        label: "Could not verify GPU readiness.",
        detail: "This source-only check did not answer; no hardware availability is claimed.",
        refusals: []
      };
    }
    if (gpu.status === "available") {
      const proof = record(gpu.adapterDeviceProof);
      const fingerprint = message(proof.adapterFingerprint);
      // `available` is meaningful only with the same explicit proof shape the engine publishes.
      // A malformed/stale intermediary response must not turn an absent adapter proof into a UI
      // hardware claim merely because its status string says "available".
      if (proof.status !== "active-host-proof" || !fingerprint || fingerprint.length > 512) {
        return {
          state: "unverified",
          label: "Could not verify GPU readiness.",
          detail: "The source-only response reported GPU availability without a valid active adapter/device proof; no hardware availability is claimed.",
          refusals
        };
      }
      return {
        state: "available",
        label: "GPU hardware proof is active.",
        detail: [
          "A host supplied a fresh adapter/device proof to this source-only readiness record.",
          fingerprint ? `Adapter ${fingerprint}.` : ""
        ].filter(Boolean).join(" "),
        refusals
      };
    }
    if (gpu.status === "requires-hardware-proof") {
      return {
        state: "requires-hardware-proof",
        label: "GPU hardware proof is required.",
        detail: refusals.map((refusal) => refusal.message).filter(Boolean).join(" ") || "This source-only check did not establish a GPU adapter or device.",
        refusals
      };
    }
    if (gpu.status === "unsupported") {
      return {
        state: "unsupported",
        label: "GPU lane is unsupported on this platform.",
        detail: refusals.map((refusal) => refusal.message).filter(Boolean).join(" ") || "Motion did not offer GPU hardware readiness on this platform.",
        refusals
      };
    }
    return {
      state: "unverified",
      label: "Could not verify GPU readiness.",
      detail: "This source-only check returned an unknown GPU state; no hardware availability is claimed.",
      refusals
    };
  }

  function renderGpuReadiness(view) {
    ui.gpuReadiness.dataset.state = view.state;
    ui.gpuReadinessLabel.textContent = view.label;
    ui.gpuReadinessDetail.textContent = view.detail;
    ui.renderGpuReadiness.dataset.state = view.state;
    ui.renderGpuReadinessLabel.textContent = view.label;
    ui.renderGpuReadinessDetail.textContent = view.detail;
  }

  function updateGpuReadinessAnnouncement() {
    const announceInRenderDialog = ui.renderDialog.open && ui.renderFrameLane.value === "gpu";
    ui.gpuReadiness.setAttribute("aria-live", announceInRenderDialog ? "off" : "polite");
    ui.renderGpuReadiness.setAttribute("aria-live", announceInRenderDialog ? "polite" : "off");
  }

  async function showGpuReadiness() {
    renderGpuReadiness({
      state: "checking",
      label: "Checking GPU source-only readiness…",
      detail: "This check does not launch WebGPU or infer an adapter from Chromium.",
      refusals: []
    });
    let result = null;
    try {
      result = (await api("motion.platform.requirements", { operation: "render.final" })).result;
    } catch {
      result = null;
    }
    renderGpuReadiness(readGpuReadinessView(result));
  }

  /**
   * @contract motion.platform.gpu.probe → active GPU hardware proof.
   *
   * Accept the only response shape that permits the Workbench to say that the active hardware
   * proof passed. This deliberately validates the returned host-issued proof rather than trusting
   * a successful transport envelope: the API operation can only establish hardware availability
   * with its exact receipt, bounded adapter identity, and governed 4 × 4 readback.
   *
   * Kept self-contained and DOM-free so the Workbench contract suite can lift and execute this
   * exact browser function independently. Any malformed response produces an explicit unverified
   * state; no hardware availability is inferred from a partial proof.
   */
  function readActiveGpuProofView(answer) {
    const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    const response = record(answer);
    const result = record(response.result);
    const proof = record(result.proof);
    const runtime = record(proof.runtime);
    const receipt = record(proof.receipt);
    const frame = record(result.frame);
    const fingerprint = typeof runtime.adapterFingerprint === "string" ? runtime.adapterFingerprint : "";
    const sha256 = typeof frame.sha256 === "string" ? frame.sha256 : "";
    const complete = response.ok === true
      && proof.schema === "shellx-motion/gpu-active-host-proof@1"
      && receipt.operation === "gpu.hardware.probe"
      && receipt.status === "passed"
      && frame.width === 4
      && frame.height === 4
      && /^[a-f0-9]{64}$/.test(sha256)
      && fingerprint.trim().length > 0
      && fingerprint.length <= 512;
    if (!complete) {
      return {
        state: "unverified",
        label: "GPU hardware proof did not pass.",
        detail: "Motion returned an incomplete active GPU proof; hardware availability was not accepted."
      };
    }
    return {
      state: "available",
      label: "GPU hardware proof passed.",
      detail: `Motion rendered and read back the governed 4 × 4 hardware frame · adapter ${fingerprint.slice(0, 16)}…`,
      fingerprint,
      sha256
    };
  }

  async function runActiveGpuProof() {
    ui.gpuProofButton.disabled = true;
    renderGpuReadiness({
      state: "checking",
      label: "Running active GPU proof…",
      detail: "Motion is opening one pre-contained Chromium WebGPU session and reading back a bounded 4 × 4 test frame.",
      refusals: []
    });
    try {
      const answer = await api("motion.platform.gpu.probe", { confirm: true }, "render_motion");
      const view = readActiveGpuProofView(answer);
      if (view.state !== "available") throw new Error(view.detail);
      renderGpuReadiness({
        state: view.state,
        label: view.label,
        detail: view.detail,
        refusals: []
      });
      setStatus("GPU hardware proof passed.", "Strict GPU preview and final remain fail-closed if content is unsupported");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      renderGpuReadiness({ state: "unverified", label: "GPU hardware proof did not pass.", detail, refusals: [] });
      setStatus("GPU hardware proof did not pass.", detail);
    } finally {
      ui.gpuProofButton.disabled = !state.connected || !tierAllows(state.grantedTier, "render_motion");
    }
  }

  /**
   * @contract motion.platform.requirements → the render dialog's readiness row.
   *
   * Turn a scoped `render.final` requirements result (or a failed probe, as `null`) into the three
   * states the row may show. Self-contained and DOM-free so `workbench-contract.test.ts` can lift it
   * out of this file and run it against a REAL server response.
   *
   * Three things this fixes, all the readiness-parity invariant:
   *
   *   1. **Blockers come from the SCOPED operation**, `result.operation.blockedBy`. The row used to
   *      build its message from EVERY non-ready tool, so a machine with FFmpeg present and FFprobe
   *      missing was told "Final encode is unavailable: ffprobe is missing" — an encode the engine
   *      would have completed. FFprobe is not a `render.final` blocker.
   *   2. **FFprobe is reported separately**, as quality-readback status, because that is what it
   *      actually gates: the manifest readback and media evidence, not the encode.
   *   3. **A failed probe returns `unverified`, never an absent row.** Hiding the row leaves the
   *      dialog looking exactly like a healthy machine, which is the one meaning it cannot have.
   *      "Could not verify" is the honest state and it is the state a user can act on.
   *
   * @param result The `result` object of `motion.platform.requirements`, or null when the command
   *   or transport failed.
   * @returns `{ state: "ready"|"blocked"|"unverified", label, detail, blockedBy, quality }`.
   */
  function readRenderReadinessView(result) {
    const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
    const answer = record(result);
    const platform = record(answer.platform);
    const tools = Array.isArray(platform.tools) ? platform.tools.map(record) : [];
    if (answer.ok !== true || tools.length === 0) {
      return {
        state: "unverified",
        label: "Could not verify what this machine can render.",
        detail: "The readiness check did not answer. Rendering may still work — submit and the engine reports its own error if it cannot encode.",
        blockedBy: [],
        quality: ""
      };
    }
    const scoped = record(answer.operation);
    // Prefer the server's scoped answer. The fallback still scopes — by the tool's own
    // `requiredForOperations` — so an older response can never regress to "every non-ready tool".
    const blockedBy = Array.isArray(scoped.blockedBy)
      ? scoped.blockedBy.filter((name) => typeof name === "string")
      : tools
        .filter((tool) => Array.isArray(tool.requiredForOperations)
          && tool.requiredForOperations.includes("render.final")
          && tool.status !== "ready")
        .map((tool) => tool.tool);
    const ffprobe = tools.find((tool) => tool.tool === "ffprobe");
    const quality = !ffprobe
      ? ""
      : ffprobe.status === "ready"
        ? `Quality readback available${ffprobe.version ? ` · ${ffprobe.version}` : ""}.`
        : `Quality readback unavailable: ffprobe is ${ffprobe.status}. Encoding is unaffected.`;
    if (blockedBy.length === 0) {
      const encoder = tools.find((tool) => tool.tool === "ffmpeg");
      return {
        state: "ready",
        label: "This machine can encode final media.",
        detail: [encoder && encoder.version ? encoder.version : "", quality].filter(Boolean).join(" · "),
        blockedBy: [],
        quality
      };
    }
    const first = record(tools.find((tool) => tool.tool === blockedBy[0]));
    const installs = Array.isArray(first.installOptions)
      ? first.installOptions.map((option) => record(option).command).filter(Boolean)
      : [];
    return {
      state: "blocked",
      label: `Final encode is unavailable: ${blockedBy
        .map((name) => `${name} is ${record(tools.find((tool) => tool.tool === name)).status || "unavailable"}`)
        .join(", ")}.`,
      detail: [
        first.problem || "",
        installs.length > 0 ? `Install: ${installs.join("  |  ")}` : "",
        quality
      ].filter(Boolean).join(" "),
      blockedBy,
      quality
    };
  }

  /**
   * Say whether this machine can encode BEFORE the operator commits to a render.
   *
   * The dialog used to discover a missing FFmpeg only after submission, as a failed render — so the
   * one state a user could actually fix looked like an engine fault (the readiness-parity invariant). This reads
   * `motion.platform.requirements`, the shared answer `motion doctor` and every host use, scoped to
   * `render.final`, and paints whatever `readRenderReadinessView` decides. All message logic lives
   * there so it is testable against a real response; this function only moves text into the DOM.
   *
   * Never blocks the form: preview, native rendering and authoring all still work, and the engine
   * refuses the encode with its own typed error if the operator submits anyway.
   */
  async function showRenderReadiness() {
    ui.renderReadiness.hidden = false;
    ui.renderReadiness.dataset.state = "checking";
    ui.renderReadinessLabel.textContent = "Checking what this machine can render…";
    ui.renderReadinessDetail.textContent = "";
    let result = null;
    try {
      result = (await api("motion.platform.requirements", { operation: "render.final" })).result;
    } catch {
      // Swallowed on purpose: a readiness probe that cannot run must not stop a render the engine
      // may well complete, and the "could not verify" state below is what the operator sees.
      result = null;
    }
    const view = readRenderReadinessView(result);
    renderGpuReadiness(readGpuReadinessView(result));
    // The row STAYS. Its state is the message; removing it would say "healthy".
    ui.renderReadiness.hidden = false;
    ui.renderReadiness.dataset.state = view.state;
    ui.renderReadinessLabel.textContent = view.label;
    ui.renderReadinessDetail.textContent = view.detail;
  }

  function updateRenderExtension() {
    const extensions = { "mp4-h264": ".mp4", "webm-vp9": ".webm", "webm-vp9-alpha": ".webm", "mov-prores": ".mov", "gif": ".gif", "png-frame": ".png" };
    const extension = extensions[ui.renderPreset.value] || ".mp4";
    showWorkbenchPath(ui.renderOutputPath, readWorkbenchPath(ui.renderOutputPath).replace(/\.[a-z0-9]+$/i, extension), "Choose a destination");
  }

  function showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.shell.dataset.state = "error";
    setStatus(message, "Your choices were preserved");
    setTimeout(() => { if (state.connected) ui.shell.dataset.state = "ready"; }, 1600);
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { ui.toast.hidden = true; }, 3600);
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return "—";
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 1 : 2)} s`;
  }

  function formatTimecode(milliseconds, fps) {
    const safeFps = Math.max(1, Math.round(fps || 30));
    const totalFrames = Math.max(0, Math.floor(milliseconds / 1000 * safeFps));
    const frames = totalFrames % safeFps;
    const secondsTotal = Math.floor(totalFrames / safeFps);
    const seconds = secondsTotal % 60;
    const minutesTotal = Math.floor(secondsTotal / 60);
    const minutes = minutesTotal % 60;
    const hours = Math.floor(minutesTotal / 60);
    return [hours, minutes, seconds, frames].map((value) => String(value).padStart(2, "0")).join(":");
  }

  function safeFileToken(value) {
    return String(value || "motion").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "motion";
  }

  async function choosePath(purpose, input, afterSelect) {
    try {
      const selected = await pickWorkbenchPath({
        token: state.token,
        purpose,
        currentPath: readWorkbenchPath(input)
      });
      if (!selected) return;
      showWorkbenchPath(input, selected);
      await afterSelect?.(selected);
    } catch (error) {
      showError(error);
    }
  }

  ui.sessionButton.addEventListener("click", () => {
    if (state.connected) disconnect();
    else ui.connectDialog.showModal();
  });
  ui.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void connect(ui.capabilityToken.value);
  });
  ui.packageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (readWorkbenchPath(ui.packageRoot)) void openPackageRoot(readWorkbenchPath(ui.packageRoot));
  });
  ui.packageBrowse.addEventListener("click", () => void choosePath("package-root", ui.packageRoot, openPackageRoot));
  ui.receiptsBrowse.addEventListener("click", () => void choosePath("receipts-root", ui.receiptsRoot, loadReceipts));
  ui.renderOutputBrowse.addEventListener("click", () => void choosePath("render-output", ui.renderOutputPath));
  ui.qualityManifestBrowse.addEventListener("click", () => void choosePath("quality-manifest", ui.qualityManifestPath));
  ui.refreshButton.addEventListener("click", () => state.package && selectPackage(state.package));
  ui.previewButton.addEventListener("click", renderPreviewFrame);
  ui.gpuProofButton.addEventListener("click", () => void runActiveGpuProof());
  ui.playButton.addEventListener("click", togglePlayback);
  ui.scrubber.addEventListener("input", () => {
    stopPlayback();
    setPlayhead(Number(ui.scrubber.value), true);
  });
  ui.zoomIn.addEventListener("click", () => { state.zoom = Math.min(4, state.zoom * 1.25); renderTimeline(); });
  ui.zoomOut.addEventListener("click", () => { state.zoom = Math.max(1, state.zoom / 1.25); renderTimeline(); });
  ui.renderButton.addEventListener("click", openRenderDialog);
  ui.renderPreset.addEventListener("change", () => { updateRenderExtension(); refreshMotionGate(); });
  ui.renderFrameLane.addEventListener("change", () => {
    synchronizeGpuFinalControls();
    void showRenderReadiness();
  });
  ui.renderCancelButton.addEventListener("click", stopWatchingRender);
  ui.renderForm.addEventListener("submit", (event) => { event.preventDefault(); void submitRender(); });
  ui.renderDialog.addEventListener("close", updateGpuReadinessAnnouncement);

  $$("[data-stage]").forEach((button) => button.addEventListener("click", () => {
    $$("[data-stage]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
    ui.previewStage.dataset.background = button.dataset.stage;
  }));
  ui.previewLaneButtons.forEach((button) => button.addEventListener("click", () => selectPreviewLane(button.dataset.previewLane)));
  $$("[role='tab']").forEach((tab) => tab.addEventListener("click", () => {
    $$("[role='tab']").forEach((candidate) => candidate.setAttribute("aria-selected", String(candidate === tab)));
    $$(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== tab.dataset.panel; panel.classList.toggle("active", !panel.hidden); });
    if (tab.dataset.panel === "queuePanel") void loadQueue();
    if (tab.dataset.panel === "receiptsPanel") void loadReceipts();
  }));
  $$("[data-refresh-panel]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.refreshPanel === "queue") void loadQueue();
    else void loadReceipts();
  }));
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.closeDialog);
    if (dialog?.open) dialog.close();
  }));

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    if (typing || document.querySelector("dialog[open]")) return;
    if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      const step = 1000 / Math.max(1, state.fps);
      setPlayhead(state.playheadMs + (event.code === "ArrowRight" ? step : -step), true);
    }
  });

  window.addEventListener("beforeunload", () => {
    stopPlayback();
    if (state.previewObjectUrl) URL.revokeObjectURL(state.previewObjectUrl);
  });

  const requestedPackageRoot = new URLSearchParams(location.search).get("packageRoot");
  if (requestedPackageRoot) showWorkbenchPath(ui.packageRoot, requestedPackageRoot, "No package selected");
  setConnected(false);
  void (async () => {
    try {
      const bootstrapToken = await claimWorkbenchBootstrap();
      if (bootstrapToken) state.token = bootstrapToken;
    } catch (error) {
      ui.connectError.textContent = error instanceof Error ? error.message : String(error);
      ui.connectError.hidden = false;
    }
    if (state.token) {
      ui.capabilityToken.value = state.token;
      await connect(state.token);
    } else {
      setTimeout(() => ui.connectDialog.showModal(), 80);
    }
  })();
})();
