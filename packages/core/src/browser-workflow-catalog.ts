import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compareCodeUnits } from "./canonical-json";

export type BrowserWorkflowDriftStatus = "new" | "matched" | "changed";

export interface BrowserWorkflowCatalogCapture {
  packageId: string;
  workflowHash: string;
  atMs: number;
  outputSha256: string;
  outputPath: string;
  receiptPath: string;
  tracePath?: string;
  createdAt?: string;
  browser?: { name?: string; version?: string };
  viewport?: { width?: number; height?: number; deviceScaleFactor?: number };
  workflow?: { stepCount?: number; networkPolicy?: string };
  captureReadiness?: BrowserWorkflowCatalogCaptureReadiness;
}

export interface BrowserWorkflowCatalogSnapshot {
  capturedAt: string;
  outputSha256: string;
  outputPath: string;
  receiptPath: string;
  tracePath?: string;
  browser?: { name?: string; version?: string };
  viewport?: { width?: number; height?: number; deviceScaleFactor?: number };
  workflow?: { stepCount?: number; networkPolicy?: string };
  captureReadiness?: BrowserWorkflowCatalogCaptureReadiness;
}

export interface BrowserWorkflowCatalogCaptureReadiness {
  schema: "shellx-motion/browser-capture-readiness@1";
  page?: "loaded";
  stylesheets?: "settled";
  fonts?: "ready" | "unsupported" | "timeout" | "error";
  animationPolicy?: "screenshot-disabled";
  media?: "settled-after-time-seek";
  waitMs?: number;
  diagnostics?: {
    stylesheetLinkCount?: number;
    fontFaceCount?: number;
    fontFaceLoadAttemptCount?: number;
    fontFaceLoadedCount?: number;
    finiteAnimationCount?: number;
    finiteAnimationMaxMs?: number;
    finiteTransitionCount?: number;
    finiteTransitionMaxMs?: number;
  };
}

export interface BrowserWorkflowDriftSummary {
  status: BrowserWorkflowDriftStatus;
  key: string;
  baselineOutputSha256: string;
  currentOutputSha256: string;
  previousOutputSha256?: string;
}

export interface BrowserWorkflowCatalogEntry {
  key: string;
  packageId: string;
  workflowHash: string;
  atMs: number;
  firstSeenAt: string;
  updatedAt: string;
  baseline: BrowserWorkflowCatalogSnapshot;
  latest: BrowserWorkflowCatalogSnapshot;
  drift: BrowserWorkflowDriftSummary;
  history: BrowserWorkflowCatalogSnapshot[];
}

export interface BrowserWorkflowCatalog {
  schema: "shellx-motion/browser-workflow-catalog@1";
  entries: BrowserWorkflowCatalogEntry[];
}

export interface UpsertBrowserWorkflowCatalogInput {
  catalogPath: string;
  capture: BrowserWorkflowCatalogCapture;
}

export interface UpsertBrowserWorkflowCatalogResult {
  ok: true;
  catalogPath: string;
  drift: BrowserWorkflowDriftSummary;
  entry: BrowserWorkflowCatalogEntry;
  catalog: BrowserWorkflowCatalog;
}

export async function readBrowserWorkflowCatalog(catalogPath: string): Promise<BrowserWorkflowCatalog> {
  try {
    const parsed: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
    return normalizeBrowserWorkflowCatalog(parsed);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return emptyBrowserWorkflowCatalog();
    }
    throw error;
  }
}

export async function upsertBrowserWorkflowCatalog(input: UpsertBrowserWorkflowCatalogInput): Promise<UpsertBrowserWorkflowCatalogResult> {
  const catalogPath = resolve(input.catalogPath);
  const catalog = await readBrowserWorkflowCatalog(catalogPath);
  const key = browserWorkflowCatalogKey(input.capture);
  const now = input.capture.createdAt ?? new Date().toISOString();
  const current = browserWorkflowCatalogSnapshot(input.capture, now);
  const existingIndex = catalog.entries.findIndex((entry) => entry.key === key);
  let entry: BrowserWorkflowCatalogEntry;

  if (existingIndex < 0) {
    const drift: BrowserWorkflowDriftSummary = {
      status: "new",
      key,
      baselineOutputSha256: current.outputSha256,
      currentOutputSha256: current.outputSha256
    };
    entry = {
      key,
      packageId: input.capture.packageId,
      workflowHash: input.capture.workflowHash,
      atMs: input.capture.atMs,
      firstSeenAt: now,
      updatedAt: now,
      baseline: current,
      latest: current,
      drift,
      history: [current]
    };
    catalog.entries.push(entry);
  } else {
    const existing = catalog.entries[existingIndex];
    const status: BrowserWorkflowDriftStatus = existing.baseline.outputSha256 === current.outputSha256 ? "matched" : "changed";
    const drift: BrowserWorkflowDriftSummary = {
      status,
      key,
      baselineOutputSha256: existing.baseline.outputSha256,
      previousOutputSha256: existing.latest.outputSha256,
      currentOutputSha256: current.outputSha256
    };
    entry = {
      ...existing,
      updatedAt: now,
      latest: current,
      drift,
      history: [...existing.history, current]
    };
    catalog.entries[existingIndex] = entry;
  }

  // Code-unit order, not localeCompare: this sort runs immediately before the catalog is written,
  // so it fixes the BYTES on disk. Under a locale-sensitive comparator the same capture history
  // produced a different catalog file — and therefore a different hash — per machine.
  catalog.entries.sort((left, right) => compareCodeUnits(left.key, right.key));
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return {
    ok: true,
    catalogPath,
    drift: entry.drift,
    entry,
    catalog
  };
}

export function browserWorkflowCatalogKey(capture: Pick<BrowserWorkflowCatalogCapture, "packageId" | "workflowHash" | "atMs">): string {
  return `${capture.packageId}:${capture.workflowHash}:${capture.atMs}`;
}

function emptyBrowserWorkflowCatalog(): BrowserWorkflowCatalog {
  return { schema: "shellx-motion/browser-workflow-catalog@1", entries: [] };
}

function browserWorkflowCatalogSnapshot(capture: BrowserWorkflowCatalogCapture, capturedAt: string): BrowserWorkflowCatalogSnapshot {
  return {
    capturedAt,
    outputSha256: capture.outputSha256,
    outputPath: capture.outputPath,
    receiptPath: capture.receiptPath,
    ...(capture.tracePath ? { tracePath: capture.tracePath } : {}),
    ...(capture.browser ? { browser: capture.browser } : {}),
    ...(capture.viewport ? { viewport: capture.viewport } : {}),
    ...(capture.workflow ? { workflow: capture.workflow } : {}),
    ...(capture.captureReadiness ? { captureReadiness: capture.captureReadiness } : {})
  };
}

function normalizeBrowserWorkflowCatalog(value: unknown): BrowserWorkflowCatalog {
  const record = objectRecord(value);
  if (!record || record.schema !== "shellx-motion/browser-workflow-catalog@1") {
    throw new Error("Browser workflow catalog schema must be shellx-motion/browser-workflow-catalog@1.");
  }
  if (!Array.isArray(record.entries)) {
    throw new Error("Browser workflow catalog entries must be an array.");
  }
  return {
    schema: "shellx-motion/browser-workflow-catalog@1",
    entries: record.entries.map((entry, index) => normalizeBrowserWorkflowCatalogEntry(entry, index))
  };
}

function normalizeBrowserWorkflowCatalogEntry(value: unknown, index: number): BrowserWorkflowCatalogEntry {
  const record = objectRecord(value);
  if (!record) throw new Error(`Browser workflow catalog entry ${index + 1} must be an object.`);
  const key = readString(record.key);
  const packageId = readString(record.packageId);
  const workflowHash = readString(record.workflowHash);
  const atMs = readFiniteNumber(record.atMs);
  const firstSeenAt = readString(record.firstSeenAt);
  const updatedAt = readString(record.updatedAt);
  if (!key || !packageId || !workflowHash || atMs === null || !firstSeenAt || !updatedAt) {
    throw new Error(`Browser workflow catalog entry ${index + 1} is missing required fields.`);
  }
  const baseline = normalizeSnapshot(record.baseline, `entry ${index + 1} baseline`);
  const latest = normalizeSnapshot(record.latest, `entry ${index + 1} latest`);
  const drift = normalizeDrift(record.drift, key, baseline.outputSha256, latest.outputSha256);
  const history = Array.isArray(record.history)
    ? record.history.map((snapshot, snapshotIndex) => normalizeSnapshot(snapshot, `entry ${index + 1} history ${snapshotIndex + 1}`))
    : [];
  return {
    key,
    packageId,
    workflowHash,
    atMs,
    firstSeenAt,
    updatedAt,
    baseline,
    latest,
    drift,
    history
  };
}

function normalizeSnapshot(value: unknown, label: string): BrowserWorkflowCatalogSnapshot {
  const record = objectRecord(value);
  if (!record) throw new Error(`Browser workflow catalog ${label} must be an object.`);
  const capturedAt = readString(record.capturedAt);
  const outputSha256 = readString(record.outputSha256);
  const outputPath = readString(record.outputPath);
  const receiptPath = readString(record.receiptPath);
  if (!capturedAt || !outputSha256 || !outputPath || !receiptPath) {
    throw new Error(`Browser workflow catalog ${label} is missing required fields.`);
  }
  const browser = readBrowserInfo(record.browser);
  const viewport = readViewportInfo(record.viewport);
  const workflow = readWorkflowInfo(record.workflow);
  const captureReadiness = readCaptureReadinessInfo(record.captureReadiness);
  return {
    capturedAt,
    outputSha256,
    outputPath,
    receiptPath,
    ...(typeof record.tracePath === "string" ? { tracePath: record.tracePath } : {}),
    ...(browser ? { browser } : {}),
    ...(viewport ? { viewport } : {}),
    ...(workflow ? { workflow } : {}),
    ...(captureReadiness ? { captureReadiness } : {})
  };
}

function normalizeDrift(value: unknown, key: string, baselineOutputSha256: string, currentOutputSha256: string): BrowserWorkflowDriftSummary {
  const record = objectRecord(value);
  const status = record?.status === "matched" || record?.status === "changed" || record?.status === "new"
    ? record.status
    : baselineOutputSha256 === currentOutputSha256 ? "matched" : "changed";
  return {
    status,
    key,
    baselineOutputSha256,
    ...(typeof record?.previousOutputSha256 === "string" ? { previousOutputSha256: record.previousOutputSha256 } : {}),
    currentOutputSha256
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBrowserInfo(value: unknown): BrowserWorkflowCatalogSnapshot["browser"] | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {})
  };
}

function readViewportInfo(value: unknown): BrowserWorkflowCatalogSnapshot["viewport"] | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const width = readFiniteNumber(record.width);
  const height = readFiniteNumber(record.height);
  const deviceScaleFactor = readFiniteNumber(record.deviceScaleFactor);
  return {
    ...(width !== null ? { width } : {}),
    ...(height !== null ? { height } : {}),
    ...(deviceScaleFactor !== null ? { deviceScaleFactor } : {})
  };
}

function readWorkflowInfo(value: unknown): BrowserWorkflowCatalogSnapshot["workflow"] | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const stepCount = readFiniteNumber(record.stepCount);
  return {
    ...(stepCount !== null ? { stepCount } : {}),
    ...(typeof record.networkPolicy === "string" ? { networkPolicy: record.networkPolicy } : {})
  };
}

function readCaptureReadinessInfo(value: unknown): BrowserWorkflowCatalogSnapshot["captureReadiness"] | undefined {
  const record = objectRecord(value);
  if (!record || record.schema !== "shellx-motion/browser-capture-readiness@1") return undefined;
  const waitMs = readFiniteNumber(record.waitMs);
  const diagnostics = readCaptureReadinessDiagnostics(record.diagnostics);
  return {
    schema: "shellx-motion/browser-capture-readiness@1",
    ...(record.page === "loaded" ? { page: "loaded" as const } : {}),
    ...(record.stylesheets === "settled" ? { stylesheets: "settled" as const } : {}),
    ...(isCaptureReadinessFontStatus(record.fonts) ? { fonts: record.fonts } : {}),
    ...(record.animationPolicy === "screenshot-disabled" ? { animationPolicy: "screenshot-disabled" as const } : {}),
    ...(record.media === "settled-after-time-seek" ? { media: "settled-after-time-seek" as const } : {}),
    ...(waitMs !== null ? { waitMs } : {}),
    ...(diagnostics ? { diagnostics } : {})
  };
}

function readCaptureReadinessDiagnostics(value: unknown): NonNullable<BrowserWorkflowCatalogCaptureReadiness["diagnostics"]> | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const diagnostics: NonNullable<BrowserWorkflowCatalogCaptureReadiness["diagnostics"]> = {};
  for (const field of [
    "stylesheetLinkCount",
    "fontFaceCount",
    "fontFaceLoadAttemptCount",
    "fontFaceLoadedCount",
    "finiteAnimationCount",
    "finiteAnimationMaxMs",
    "finiteTransitionCount",
    "finiteTransitionMaxMs"
  ] as const) {
    const value = readFiniteNumber(record[field]);
    if (value !== null) diagnostics[field] = value;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function isCaptureReadinessFontStatus(value: unknown): value is BrowserWorkflowCatalogCaptureReadiness["fonts"] {
  return value === "ready" || value === "unsupported" || value === "timeout" || value === "error";
}

function isErrnoCode(error: unknown, code: string): boolean {
  return objectRecord(error)?.code === code;
}
