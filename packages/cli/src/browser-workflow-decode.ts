/**
 * Browser-capture workflow decoding for the ShellX Motion CLI.
 *
 * Role: reads and validates a `shellx-motion/browser-workflow@1` JSON document into the strongly-typed
 * `BrowserCaptureWorkflow` shape used by the `capture-browser` and `render` commands. Extracted verbatim
 * from `main.ts` so the CLI entry file stays under the module-size gate. Pure parsing and validation —
 * no side effects beyond the single `readFile` in `readBrowserCaptureWorkflow`; behavior unchanged.
 *
 * Dependencies: `readFile` (node:fs/promises); the browser-workflow wait-bound constants from
 * `@shellx-motion/core`; the `BrowserCaptureWorkflow` / `BrowserCaptureWorkflowStep` types from
 * `@shellx-motion/renderer-browser`. `readRecord` is a local trivial object-guard mirroring the copy in
 * `debug-context-cli.ts` (same-package convention that avoids importing runtime helpers back from `main.ts`).
 *
 * Primary callers: `packages/cli/src/main.ts` (`captureBrowserCommand`, `renderCommand`).
 */
import { readFile } from "node:fs/promises";
import { MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS, MAX_BROWSER_WORKFLOW_WAIT_MS } from "@shellx-motion/core";
import type { BrowserCaptureWorkflow, BrowserCaptureWorkflowStep } from "@shellx-motion/renderer-browser";

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

export async function readBrowserCaptureWorkflow(path: string): Promise<BrowserCaptureWorkflow> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const workflow = decodeBrowserCaptureWorkflow(parsed);
  if (!workflow) {
    throw new Error(`Invalid browser workflow: ${path}`);
  }
  return workflow;
}

function decodeBrowserCaptureWorkflow(value: unknown): BrowserCaptureWorkflow | null {
  const record = readRecord(value);
  if (!record || record.schema !== "shellx-motion/browser-workflow@1" || !Array.isArray(record.steps)) return null;
  const steps: BrowserCaptureWorkflowStep[] = [];
  let totalWaitMs = 0;
  for (const rawStep of record.steps) {
    const step = decodeBrowserCaptureWorkflowStep(rawStep);
    if (!step) return null;
    if (step.action === "wait") {
      if (step.ms > MAX_BROWSER_WORKFLOW_WAIT_MS) return null;
      totalWaitMs += step.ms;
      if (totalWaitMs > MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS) return null;
    }
    steps.push(step);
  }
  const viewport = decodeBrowserWorkflowViewport(record.viewport);
  if ("viewport" in record && !viewport) return null;
  const cursor = decodeBrowserWorkflowCursor(record.cursor);
  if ("cursor" in record && !cursor) return null;
  if ("networkPolicy" in record && record.networkPolicy !== "blocked-unless-declared" && record.networkPolicy !== "allow") return null;
  return {
    schema: "shellx-motion/browser-workflow@1",
    ...(viewport ? { viewport } : {}),
    ...(record.networkPolicy === "blocked-unless-declared" || record.networkPolicy === "allow" ? { networkPolicy: record.networkPolicy } : {}),
    steps,
    ...(cursor ? { cursor } : {})
  };
}

function decodeBrowserCaptureWorkflowStep(value: unknown): BrowserCaptureWorkflowStep | null {
  const entry = readRecord(value);
  if (!entry) return null;
  if (entry.action === "wait") {
    const ms = readNonNegativeFiniteNumber(entry.ms);
    return ms === null ? null : { action: "wait", ms };
  }
  if (entry.action === "click") {
    return typeof entry.selector === "string" ? { action: "click", selector: entry.selector } : null;
  }
  if (entry.action === "verify") {
    if (typeof entry.selector !== "string") return null;
    return typeof entry.text === "string" ? { action: "verify", selector: entry.selector, text: entry.text } : { action: "verify", selector: entry.selector };
  }
  if (entry.action === "type") {
    return typeof entry.selector === "string" && typeof entry.text === "string" ? { action: "type", selector: entry.selector, text: entry.text } : null;
  }
  if (entry.action === "press") {
    return typeof entry.selector === "string" && typeof entry.key === "string" ? { action: "press", selector: entry.selector, key: entry.key } : null;
  }
  if (entry.action === "scroll") {
    const x = "x" in entry ? readFiniteNumber(entry.x) : 0;
    const y = "y" in entry ? readFiniteNumber(entry.y) : 0;
    if (x === null || y === null) return null;
    return { action: "scroll", x, y };
  }
  return null;
}

function decodeBrowserWorkflowViewport(value: unknown): BrowserCaptureWorkflow["viewport"] | null {
  if (value === undefined) return null;
  const record = readRecord(value);
  if (!record) return null;
  const width = readPositiveFiniteNumber(record.width);
  const height = readPositiveFiniteNumber(record.height);
  if (width === null || height === null) return null;
  let deviceScaleFactor: number | undefined;
  if ("deviceScaleFactor" in record) {
    const decodedDeviceScaleFactor = readPositiveFiniteNumber(record.deviceScaleFactor);
    if (decodedDeviceScaleFactor === null) return null;
    deviceScaleFactor = decodedDeviceScaleFactor;
  }
  return {
    width,
    height,
    ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {})
  };
}

function decodeBrowserWorkflowCursor(value: unknown): BrowserCaptureWorkflow["cursor"] | null {
  if (value === undefined) return null;
  const record = readRecord(value);
  if (!record) return null;
  const cursor: NonNullable<BrowserCaptureWorkflow["cursor"]> = {};
  if ("visible" in record) {
    if (typeof record.visible !== "boolean") return null;
    cursor.visible = record.visible;
  }
  if ("path" in record) {
    if (!Array.isArray(record.path)) return null;
    const path: Array<{ x: number; y: number; atMs: number }> = [];
    for (const point of record.path) {
      const pointRecord = readRecord(point);
      if (!pointRecord) return null;
      const x = readFiniteNumber(pointRecord.x);
      const y = readFiniteNumber(pointRecord.y);
      const atMs = readNonNegativeFiniteNumber(pointRecord.atMs);
      if (x === null || y === null || atMs === null) return null;
      path.push({ x, y, atMs });
    }
    cursor.path = path;
  }
  return cursor;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeFiniteNumber(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function readPositiveFiniteNumber(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}
