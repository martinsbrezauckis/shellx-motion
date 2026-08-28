import type { AgentScriptExecutionEvidence } from "@shellx-motion/core";
import type { BrowserFrameResult } from "./index";
import type { BrowserStreamingFrameRangeEvidence } from "./browser-streaming-frame-range";

const MAX_STREAMED_WARNING_EVIDENCE = 64;
const MAX_STREAMED_INPUT_HASH_EVIDENCE = 256;
const DERIVED_PER_FRAME_INPUT_HASH_KEYS = new Set(["html"]);

export interface BrowserStreamingTerminalFrameEvidence {
  index: number;
  atMs: number;
  /** Frame evidence excluding ephemeral paths, artifacts, and outer-job resource evidence. */
  output: Omit<BrowserFrameResult["output"], "path" | "resources" | "artifacts" | "workflowTracePath" | "workflowCatalogPath">;
  /** The final receipt identity/status without output paths or unbounded warning/hash collections. */
  receipt: Omit<BrowserFrameResult["receipt"], "output" | "artifacts" | "warnings" | "inputHashes">;
}

export interface BrowserStreamingSessionEvidence {
  state: "idle" | "opening" | "rendering" | "closing" | "closed" | "not_opened" | "open_failed" | "cleanup_failed";
  cleanup: "not_started" | "pending" | "complete" | "failed";
}

/**
 * Playwright does not expose a Chromium worker PID. The admitted job watches the host Node process
 * tree as a conservative cooperative fallback; that tree can overlap the encoder's watched FFmpeg
 * child, so its RSS is not an exact browser-only or exact per-job measurement. FFmpeg containment
 * must not be treated as Chromium containment by the eventual final-render adapter.
 */
export interface BrowserStreamingProcessMonitoringEvidence {
  readonly mode: "cooperative-browser-session";
  readonly chromiumPid: "unavailable";
  readonly watchedRoot: "host-node-process";
  readonly rssScope: "host-node-process-tree";
  readonly measurement: "conservative-fallback-not-exact-per-job";
  readonly encoderRssOverlap: "possible";
  readonly encoderContainmentCoversChromium: false;
  readonly reasonCode: "worker_process_unavailable";
}

/**
 * Bounded delivery evidence for the current producer attempt. It keeps a capped unique warning
 * union, a capped stable-input-hash union, and exactly one path-sanitized terminal frame — never a
 * frame result list. Known derived frame hashes (currently `html`) are intentionally excluded from
 * mutation comparison. The outer FFmpeg job owns resource/sandbox receipt persistence.
 */
export interface BrowserStreamingFrameProducerEvidence {
  readonly schema: "shellx-motion/browser-streaming-producer@1";
  /** Present for a producer attempt; terminal evidence never implies all timeline frames were rendered. */
  readonly range?: Readonly<BrowserStreamingFrameRangeEvidence>;
  readonly warningUnion: readonly string[];
  readonly warningsOmitted: number;
  readonly stableInputHashUnion: Readonly<Record<string, string>>;
  readonly stableInputHashKeysOmitted: number;
  readonly stableInputHashConflictKeys: readonly string[];
  readonly stableInputHashConflictKeysOmitted: number;
  readonly processMonitoring: Readonly<BrowserStreamingProcessMonitoringEvidence>;
  /** One session-owned script verdict, identical across every observed browser frame. */
  readonly scriptExecution?: Readonly<AgentScriptExecutionEvidence>;
  readonly terminalFrame?: BrowserStreamingTerminalFrameEvidence;
  readonly session: Readonly<BrowserStreamingSessionEvidence>;
}

export interface MutableBrowserStreamingFrameProducerEvidence {
  schema: "shellx-motion/browser-streaming-producer@1";
  range?: BrowserStreamingFrameRangeEvidence;
  warningUnion: string[];
  warningsOmitted: number;
  stableInputHashUnion: Record<string, string>;
  stableInputHashKeysOmitted: number;
  stableInputHashConflictKeys: string[];
  stableInputHashConflictKeysOmitted: number;
  processMonitoring: BrowserStreamingProcessMonitoringEvidence;
  scriptExecution?: AgentScriptExecutionEvidence;
  terminalFrame?: BrowserStreamingTerminalFrameEvidence;
  session: BrowserStreamingSessionEvidence;
}

export function emptyStreamingEvidence(
  range?: BrowserStreamingFrameRangeEvidence
): MutableBrowserStreamingFrameProducerEvidence {
  return {
    schema: "shellx-motion/browser-streaming-producer@1",
    ...(range ? { range: { ...range } } : {}),
    warningUnion: [],
    warningsOmitted: 0,
    stableInputHashUnion: {},
    stableInputHashKeysOmitted: 0,
    stableInputHashConflictKeys: [],
    stableInputHashConflictKeysOmitted: 0,
    processMonitoring: {
      mode: "cooperative-browser-session",
      chromiumPid: "unavailable",
      watchedRoot: "host-node-process",
      rssScope: "host-node-process-tree",
      measurement: "conservative-fallback-not-exact-per-job",
      encoderRssOverlap: "possible",
      encoderContainmentCoversChromium: false,
      reasonCode: "worker_process_unavailable"
    },
    session: { state: "idle", cleanup: "not_started" }
  };
}

export function observeFrameEvidence(
  evidence: MutableBrowserStreamingFrameProducerEvidence,
  result: BrowserFrameResult,
  index: number,
  atMs: number
): void {
  const scriptExecution = scriptExecutionFromFrame(result);
  if (evidence.scriptExecution && !sameJson(evidence.scriptExecution, scriptExecution)) {
    throw new BrowserStreamingScriptEvidenceError("Browser streamed frame script evidence changed during one session.");
  }
  evidence.scriptExecution = scriptExecution;
  const conflicts: string[] = [];
  for (const warning of result.receipt.warnings) {
    addBoundedUnique(evidence.warningUnion, warning, MAX_STREAMED_WARNING_EVIDENCE, () => {
      evidence.warningsOmitted += 1;
    });
  }
  for (const [key, value] of Object.entries(result.receipt.inputHashes)) {
    if (DERIVED_PER_FRAME_INPUT_HASH_KEYS.has(key)) continue;
    const known = evidence.stableInputHashUnion[key];
    if (known === undefined) {
      if (Object.keys(evidence.stableInputHashUnion).length >= MAX_STREAMED_INPUT_HASH_EVIDENCE) {
        evidence.stableInputHashKeysOmitted += 1;
      } else {
        evidence.stableInputHashUnion[key] = value;
      }
    } else if (known !== value) {
      addBoundedUnique(evidence.stableInputHashConflictKeys, key, MAX_STREAMED_INPUT_HASH_EVIDENCE, () => {
        evidence.stableInputHashConflictKeysOmitted += 1;
      });
      if (!conflicts.includes(key)) conflicts.push(key);
    }
  }
  evidence.terminalFrame = sanitizeTerminalFrame(result, index, atMs);
  if (conflicts.length > 0) throw new BrowserStreamingInputMutationError(conflicts);
}

function addBoundedUnique(values: string[], value: string, capacity: number, onOmitted: () => void): void {
  if (values.includes(value)) return;
  if (values.length >= capacity) {
    onOmitted();
    return;
  }
  values.push(value);
}

function sanitizeTerminalFrame(
  result: BrowserFrameResult,
  index: number,
  atMs: number
): BrowserStreamingTerminalFrameEvidence {
  const {
    path: _path,
    resources: _resources,
    artifacts: _artifacts,
    workflowTracePath: _workflowTracePath,
    workflowCatalogPath: _workflowCatalogPath,
    ...output
  } = result.output;
  const {
    output: _receiptOutput,
    artifacts: _receiptArtifacts,
    warnings: _receiptWarnings,
    inputHashes: _receiptInputHashes,
    ...receipt
  } = result.receipt;
  return {
    index,
    atMs,
    output,
    receipt
  };
}

export class BrowserStreamingInputMutationError extends Error {
  readonly code = "browser_streaming_input_mutated";

  constructor(readonly conflictKeys: readonly string[]) {
    super(`Browser streamed frame input hashes changed during production: ${conflictKeys.join(", ")}.`);
    this.name = "BrowserStreamingInputMutationError";
    Object.setPrototypeOf(this, BrowserStreamingInputMutationError.prototype);
  }
}

export class BrowserStreamingScriptEvidenceError extends Error {
  readonly code = "browser_streaming_script_evidence_invalid";

  constructor(message: string) {
    super(message);
    this.name = "BrowserStreamingScriptEvidenceError";
    Object.setPrototypeOf(this, BrowserStreamingScriptEvidenceError.prototype);
  }
}

function scriptExecutionFromFrame(result: BrowserFrameResult): AgentScriptExecutionEvidence {
  const outputEvidence = result.output.scriptExecution;
  const receiptOutput = plainRecord(result.receipt.output);
  const receiptEvidence = receiptOutput?.scriptExecution;
  if (!outputEvidence || !receiptEvidence || !sameJson(outputEvidence, receiptEvidence)) {
    throw new BrowserStreamingScriptEvidenceError(
      "Browser streamed frame omitted or contradicted its session-owned script evidence."
    );
  }
  return outputEvidence;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
