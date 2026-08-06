/**
 * receipt-card.js — pure, DOM-free view-model builder for the engine-room History
 * (receipts) timeline.
 *
 * Role: turn a full `OperationReceipt` (as returned by the `motion.receipts.read`
 * Debug API command, `result.receipt`) into a flat, render-ready card model that
 * answers, at a glance, the four questions a user asks when they doubt what an
 * agent did over MCP:
 *
 *   WHEN  → createdAt (timestamp)
 *   WHO   → actor attribution (createdBy / provenance.sourceApp / agent label),
 *           honestly "unattributed" when the receipt carries no actor field
 *   WHAT  → operation, lane, encoder (hardware/software + reason), gate pass/fail
 *   WHERE → output file path(s), surfaced prominently for the "Open folder" action
 *
 * The receipt `output` field is typed `unknown` in the schema (its shape varies by
 * operation), so every read here is defensive: missing fields degrade to null/empty
 * rather than throwing or inventing values. Keeping this logic DOM-free lets both
 * the browser module (history.js) and the Node test (receipt-card.test.ts) exercise
 * the exact same mapping.
 *
 * Dependencies: none (ES module, browser + Node compatible).
 * Primary callers: history.js (DOM rendering), receipt-card.test.ts (unit tests).
 */

/** Human labels for the four render-encoder reason codes emitted by renderer-ffmpeg. */
const ENCODER_REASON_LABELS = {
  "probe-selected-hardware": "Hardware (probe-verified)",
  "forced-software": "Software (forced)",
  "hardware-fallback": "Software (hardware fallback)",
  "software-default": "Software (default)"
};

/** Human labels for receipt status values. */
const STATUS_LABELS = {
  passed: "Passed",
  failed: "Failed",
  warning: "Warning",
  not_run: "Not run"
};

// ----- small defensive readers (the receipt output is `unknown`) -----
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");
const asFiniteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Human labels for the receipt actor transports (the wire an operation arrived on). Mirrors the
 * `ReceiptActorTransport` union in packages/core/src/types.ts.
 */
const ACTOR_TRANSPORT_LABELS = {
  cli: "CLI",
  http: "Local integration",
  ws: "Live integration",
  mcp: "Agent",
  sdk: "App integration",
  connector: "Connector"
};

const ACCESS_LABELS = {
  read_motion: "Read access",
  draft_motion: "Draft access",
  render_motion: "Render access",
  edit_motion: "Edit access",
  write_local: "Local write access",
  push_remote: "Publish access"
};

/**
 * Derive actor attribution ("BY WHO") from a receipt. Receipts written since actor attribution
 * shipped carry a first-class `actor` field, stamped at the transport choke point (CLI, HTTP, WS,
 * MCP, SDK); we prefer it and surface its observed transport/session/tier facts alongside the
 * (possibly caller-claimed) label. Older receipts have no `actor`, so we fall back to the legacy
 * honest chain — `output.createdBy` → agent label → `provenance.sourceApp` — and, when nothing is
 * present, return an explicit "unattributed" marker rather than guessing.
 *
 * IMPORTANT — attribution evidence, not authentication: `label`/`kind` may be a caller claim, while
 * `transport`/`sessionId`/`grantedTier`/`clientInfo` were observed by the dispatch layer and cannot
 * be spoofed. The `via` string carries those observed facts so a claimed label always rides visibly
 * with its real transport.
 *
 * @param {object} receipt A receipt-like object.
 * @returns {{
 *   label: string, source: string, attributed: boolean,
 *   kind: string, transport: string, transportLabel: string,
 *   clientInfo: string, sessionId: string, grantedTier: string, via: string
 * }}
 */
export function receiptActor(receipt) {
  const source = asObject(receipt);
  const output = asObject(source.output);
  const provenance = asObject(output.provenance);
  const agent = asObject(output.agent);

  // First-class actor field (present on receipts stamped at a transport choke point).
  const actor = asObject(source.actor);
  const actorLabel = asString(actor.label);
  if (actorLabel) {
    const kind = asString(actor.kind) || "unknown";
    const transport = asString(actor.transport);
    const clientInfo = asString(actor.clientInfo);
    const sessionId = asString(actor.sessionId);
    const grantedTier = asString(actor.grantedTier);
    return {
      label: humanActorLabel(actorLabel, transport),
      source: "actor",
      attributed: true,
      kind,
      transport,
      transportLabel: ACTOR_TRANSPORT_LABELS[transport] ?? transport,
      clientInfo,
      sessionId,
      grantedTier,
      via: formatActorVia({ transport, clientInfo, sessionId, grantedTier })
    };
  }

  // Legacy fallbacks for receipts written before the actor field existed.
  const base = { kind: "", transport: "", transportLabel: "", clientInfo: "", sessionId: "", grantedTier: "", via: "" };
  const createdBy = asString(output.createdBy);
  if (createdBy) return { label: createdBy, source: "createdBy", attributed: true, ...base };

  const agentLabel = asString(agent.label) || asString(output.label) || asString(output.agentId);
  if (agentLabel) return { label: agentLabel, source: "agent", attributed: true, ...base };

  const sourceApp = asString(provenance.sourceApp) || asString(output.sourceApp);
  if (sourceApp) return { label: sourceApp, source: "sourceApp", attributed: true, ...base };

  return { label: "unattributed", source: "none", attributed: false, ...base };
}

/** Replace transport-generated placeholder names with the product role a person recognizes. */
function humanActorLabel(label, transport) {
  const generated = new Set(["http client", "ws client", "mcp client"]);
  if (!generated.has(label.toLowerCase())) return label;
  if (transport === "mcp") return "Agent";
  return "Local app";
}

/**
 * Build the honest "via" line from a receipt actor's OBSERVED transport facts, e.g.
 * "via MCP · client local-agent/1.0 · session srv-ab12:ws-3c4d · tier render_motion". Returns "" when
 * no observed facts are present. These facts cannot be spoofed by the caller, so they anchor a
 * (possibly claimed) label to the real transport.
 *
 * @param {{ transport: string, clientInfo: string, sessionId: string, grantedTier: string }} facts
 * @returns {string} A human "via …" string, or "".
 */
export function formatActorVia(facts) {
  const parts = [];
  const transport = asString(facts.transport);
  if (transport) parts.push(`via ${ACTOR_TRANSPORT_LABELS[transport] ?? transport}`);
  const clientInfo = asString(facts.clientInfo);
  if (clientInfo) parts.push(`client ${clientInfo}`);
  const grantedTier = asString(facts.grantedTier);
  if (grantedTier) parts.push(ACCESS_LABELS[grantedTier] ?? "Secure access");
  return parts.join(" · ");
}

/**
 * Derive the render encoder summary ("hardware/software + reason") from a receipt
 * output. Only render receipts that engaged the encoder system carry these fields;
 * for everything else this returns null and the card simply omits the encoder chip.
 *
 * @param {object} receipt A receipt-like object.
 * @returns {null | {
 *   name: string,
 *   source: "hardware"|"software"|"",
 *   reason: string,
 *   reasonLabel: string,
 *   fallback: null | { attemptedEncoder: string, reason: string }
 * }}
 */
export function receiptEncoder(receipt) {
  const output = asObject(asObject(receipt).output);
  const name = asString(output.encoder);
  const source = asString(output.encoderSource);
  const reason = asString(output.encoderReason);
  if (!name && !source && !reason) return null;

  const fallbackRaw = asObject(output.encoderFallback);
  const fallback = asString(fallbackRaw.attemptedEncoder)
    ? { attemptedEncoder: asString(fallbackRaw.attemptedEncoder), reason: asString(fallbackRaw.reason) }
    : null;

  return {
    name,
    source: source === "hardware" || source === "software" ? source : "",
    reason,
    reasonLabel: ENCODER_REASON_LABELS[reason] ?? (reason || (source ? `${source} encoder` : "")),
    fallback
  };
}

/**
 * Collect the output artifact(s) a receipt produced ("WHERE + WHAT"), merging the
 * primary `output.path` (with any width/height/duration/codec metadata) and the
 * `artifacts[]` list, de-duplicated by resolved path. The first entry flagged
 * primary (or the primary output path) is marked so the card can feature it.
 *
 * @param {object} receipt A receipt-like object.
 * @returns {Array<{
 *   path: string,
 *   role: string,
 *   status: string,
 *   primary: boolean,
 *   mediaType: string,
 *   width: number|null,
 *   height: number|null,
 *   durationMs: number|null,
 *   dimensionsLabel: string
 * }>}
 */
export function receiptOutputs(receipt) {
  const output = asObject(asObject(receipt).output);
  const byPath = new Map();

  const put = (entry) => {
    const path = asString(entry.path);
    if (!path) return;
    const existing = byPath.get(path);
    if (existing) {
      // Merge: prefer any concrete dimension/role/status/primary already known.
      byPath.set(path, {
        ...existing,
        role: existing.role || entry.role,
        status: existing.status || entry.status,
        mediaType: existing.mediaType || entry.mediaType,
        primary: existing.primary || entry.primary,
        width: existing.width ?? entry.width,
        height: existing.height ?? entry.height,
        durationMs: existing.durationMs ?? entry.durationMs
      });
      return;
    }
    byPath.set(path, entry);
  };

  // Primary media output from `output.path` (+ any dimension metadata).
  const primaryPath = asString(output.path);
  if (primaryPath) {
    put({
      path: primaryPath,
      role: asString(output.role) || "output",
      status: "available",
      primary: true,
      mediaType: asString(output.mediaType) || asString(output.container),
      width: asFiniteNumber(output.width),
      height: asFiniteNumber(output.height),
      durationMs: asFiniteNumber(output.durationMs)
    });
  }

  // Declared artifacts (role/path/status/primary/mediaType).
  for (const artifact of asArray(receipt.artifacts)) {
    const record = asObject(artifact);
    put({
      path: asString(record.path),
      role: asString(record.role) || "artifact",
      status: asString(record.status) || "available",
      primary: record.primary === true,
      mediaType: asString(record.mediaType),
      width: null,
      height: null,
      durationMs: null
    });
  }

  return [...byPath.values()].map((entry) => ({
    ...entry,
    dimensionsLabel: formatDimensions(entry.width, entry.height, entry.durationMs)
  }));
}

/**
 * Build a compact dimensions/duration label from output metadata, e.g.
 * "1920 × 1080 · 4.0s". Returns "" when nothing is known.
 *
 * @param {number|null} width Pixel width.
 * @param {number|null} height Pixel height.
 * @param {number|null} durationMs Duration in milliseconds.
 * @returns {string} A human dimensions label, or "".
 */
export function formatDimensions(width, height, durationMs) {
  const parts = [];
  if (width && height) parts.push(`${width} × ${height}`);
  if (durationMs && durationMs > 0) parts.push(`${(durationMs / 1000).toFixed(durationMs % 1000 === 0 ? 0 : 1)}s`);
  return parts.join(" · ");
}

/**
 * Summarize quality gate outcomes ("pass/fail of gates") from a receipt. The
 * top-level receipt `status` is the authoritative overall result; this also
 * surfaces any per-run `output.qualityCheck` and per-job `output.jobs[].qualityCheck`
 * detail so the card can show what actually passed or failed.
 *
 * @param {object} receipt A receipt-like object.
 * @returns {{
 *   status: string,
 *   checks: Array<{ label: string, status: string, message: string }>,
 *   passedCount: number,
 *   failedCount: number
 * }}
 */
export function receiptGates(receipt) {
  const output = asObject(asObject(receipt).output);
  const checks = [];

  const pushCheck = (label, qc) => {
    const record = asObject(qc);
    const status = asString(record.status);
    if (!status && !asString(record.message) && !asString(record.code)) return;
    checks.push({
      label,
      status: status || "recorded",
      message: asString(record.message) || asString(asObject(record.error).message)
    });
  };

  pushCheck("Quality check", output.qualityCheck);
  for (const job of asArray(output.jobs)) {
    const record = asObject(job);
    pushCheck(`Job ${asString(record.rowId) || asString(record.packageId) || "quality"}`, record.qualityCheck);
  }

  const passedCount = checks.filter((check) => check.status === "passed" || check.status === "ok").length;
  const failedCount = checks.filter((check) => check.status === "failed" || check.status === "error").length;
  return { status: asString(receipt.status) || "unknown", checks, passedCount, failedCount };
}

/**
 * Read a receipt's `inputHashes` map into a stable, sorted table of key/hash rows.
 *
 * @param {object} receipt A receipt-like object.
 * @returns {Array<{ key: string, hash: string }>}
 */
export function receiptInputHashes(receipt) {
  const hashes = asObject(asObject(receipt).inputHashes);
  return Object.keys(hashes)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, hash: asString(hashes[key]) }))
    .filter((row) => row.hash !== "");
}

/**
 * Build the full History card view-model for one receipt. Every field is derived
 * defensively; the raw receipt is carried through under `raw` for the card's
 * raw-JSON toggle.
 *
 * @param {object} receipt A full OperationReceipt-like object (result.receipt).
 * @param {{ path?: string }} [meta] Optional list metadata (the on-disk receipt path).
 * @returns {object} The render-ready card model.
 */
export function buildReceiptCard(receipt, meta = {}) {
  const source = asObject(receipt);
  const status = asString(source.status) || "unknown";
  const outputs = receiptOutputs(source);
  const primaryOutput = outputs.find((entry) => entry.primary) ?? outputs[0] ?? null;

  return {
    id: asString(source.id) || "(no id)",
    operation: asString(source.operation) || "unknown",
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    createdAt: asString(source.createdAt),
    packageId: asString(source.packageId) || "(no package)",
    lane: asString(source.lane) || "—",
    receiptPath: asString(meta.path) || asString(source.path),
    actor: receiptActor(source),
    encoder: receiptEncoder(source),
    outputs,
    primaryOutputPath: primaryOutput ? primaryOutput.path : "",
    gates: receiptGates(source),
    warnings: asArray(source.warnings).filter((warning) => typeof warning === "string"),
    warningsCount: asArray(source.warnings).filter((warning) => typeof warning === "string").length,
    inputHashes: receiptInputHashes(source),
    raw: receipt
  };
}

/**
 * Extract the distinct filter facets (packages, operations) present across a set
 * of receipt summaries or cards, for the History filter controls. Accepts either
 * raw summaries (from motion.receipts.list) or built cards — both expose
 * `packageId` and `operation`.
 *
 * @param {Array<{ packageId?: string, operation?: string }>} items Receipts or cards.
 * @returns {{ packages: string[], operations: string[] }}
 */
export function receiptFacets(items) {
  const packages = new Set();
  const operations = new Set();
  for (const item of asArray(items)) {
    const record = asObject(item);
    const packageId = asString(record.packageId);
    const operation = asString(record.operation);
    if (packageId) packages.add(packageId);
    if (operation) operations.add(operation);
  }
  return {
    packages: [...packages].sort((left, right) => left.localeCompare(right)),
    operations: [...operations].sort((left, right) => left.localeCompare(right))
  };
}
