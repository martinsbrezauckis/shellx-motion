import { MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS, MAX_BROWSER_WORKFLOW_WAIT_MS } from "@shellx-motion/core";
import type { BrowserCaptureWorkflow } from "@shellx-motion/renderer-browser";
import { objectArg } from "./args.js";

export function readBrowserWorkflowArg(args: unknown, key: string): BrowserCaptureWorkflow | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  return parseBrowserWorkflow(record[key]);
}

export function parseBrowserWorkflow(value: unknown): BrowserCaptureWorkflow | false {
  const record = objectArg(value);
  if (!record || !Object.hasOwn(record, "schema") || !Object.hasOwn(record, "steps")
    || record.schema !== "shellx-motion/browser-workflow@1" || !Array.isArray(record.steps)) return false;
  const steps = readBrowserWorkflowSteps(record.steps);
  if (!steps) return false;
  const viewportValue = Object.hasOwn(record, "viewport") ? record.viewport : undefined;
  const viewport = readBrowserWorkflowViewport(viewportValue);
  if (viewportValue !== undefined && !viewport) return false;
  const networkPolicyValue = Object.hasOwn(record, "networkPolicy") ? record.networkPolicy : undefined;
  const networkPolicy = readBrowserWorkflowNetworkPolicy(networkPolicyValue);
  if (networkPolicyValue !== undefined && !networkPolicy) return false;
  const cursorValue = Object.hasOwn(record, "cursor") ? record.cursor : undefined;
  const cursor = readBrowserWorkflowCursor(cursorValue);
  if (cursorValue !== undefined && !cursor) return false;
  return {
    schema: "shellx-motion/browser-workflow@1", steps,
    ...(viewport ? { viewport } : {}), ...(networkPolicy ? { networkPolicy } : {}), ...(cursor ? { cursor } : {})
  };
}

function readBrowserWorkflowSteps(value: unknown[]): BrowserCaptureWorkflow["steps"] | null {
  const steps: BrowserCaptureWorkflow["steps"] = [];
  let totalWaitMs = 0;
  for (const step of value) {
    const record = objectArg(step);
    if (!record || !Object.hasOwn(record, "action") || typeof record.action !== "string") return null;
    if (record.action === "wait") {
      if (!Object.hasOwn(record, "ms") || typeof record.ms !== "number" || !Number.isFinite(record.ms) || record.ms < 0) return null;
      if (record.ms > MAX_BROWSER_WORKFLOW_WAIT_MS) return null;
      totalWaitMs += record.ms;
      if (totalWaitMs > MAX_BROWSER_WORKFLOW_TOTAL_WAIT_MS) return null;
      steps.push({ action: "wait", ms: record.ms });
      continue;
    }
    if (record.action === "click") {
      if (!Object.hasOwn(record, "selector") || typeof record.selector !== "string") return null;
      steps.push({ action: "click", selector: record.selector });
      continue;
    }
    if (record.action === "type") {
      if (!Object.hasOwn(record, "selector") || !Object.hasOwn(record, "text") || typeof record.selector !== "string" || typeof record.text !== "string") return null;
      steps.push({ action: "type", selector: record.selector, text: record.text });
      continue;
    }
    if (record.action === "press") {
      if (!Object.hasOwn(record, "selector") || !Object.hasOwn(record, "key") || typeof record.selector !== "string" || typeof record.key !== "string") return null;
      steps.push({ action: "press", selector: record.selector, key: record.key });
      continue;
    }
    if (record.action === "scroll") {
      const x = Object.hasOwn(record, "x") ? record.x : undefined;
      const y = Object.hasOwn(record, "y") ? record.y : undefined;
      if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x))) return null;
      if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) return null;
      steps.push({ action: "scroll", ...(typeof x === "number" ? { x } : {}), ...(typeof y === "number" ? { y } : {}) });
      continue;
    }
    if (record.action === "verify") {
      const text = Object.hasOwn(record, "text") ? record.text : undefined;
      if (!Object.hasOwn(record, "selector") || typeof record.selector !== "string" || (text !== undefined && typeof text !== "string")) return null;
      steps.push({ action: "verify", selector: record.selector, ...(typeof text === "string" ? { text } : {}) });
      continue;
    }
    return null;
  }
  return steps;
}

function readBrowserWorkflowViewport(value: unknown): BrowserCaptureWorkflow["viewport"] | null {
  const record = objectArg(value);
  if (!record) return null;
  if (!Object.hasOwn(record, "width") || typeof record.width !== "number" || !Number.isFinite(record.width) || record.width <= 0) return null;
  if (!Object.hasOwn(record, "height") || typeof record.height !== "number" || !Number.isFinite(record.height) || record.height <= 0) return null;
  const deviceScaleFactor = Object.hasOwn(record, "deviceScaleFactor") ? record.deviceScaleFactor : undefined;
  if (deviceScaleFactor !== undefined && (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0)) return null;
  return { width: record.width, height: record.height, ...(typeof deviceScaleFactor === "number" ? { deviceScaleFactor } : {}) };
}

function readBrowserWorkflowNetworkPolicy(value: unknown): BrowserCaptureWorkflow["networkPolicy"] | null {
  return value === "blocked-unless-declared" || value === "allow" ? value : null;
}

function readBrowserWorkflowCursor(value: unknown): BrowserCaptureWorkflow["cursor"] | null {
  const record = objectArg(value);
  if (!record) return null;
  const visible = Object.hasOwn(record, "visible") ? record.visible : undefined;
  if (visible !== undefined && typeof visible !== "boolean") return null;
  const cursor: NonNullable<BrowserCaptureWorkflow["cursor"]> = { ...(typeof visible === "boolean" ? { visible } : {}) };
  const cursorPath = Object.hasOwn(record, "path") ? record.path : undefined;
  if (cursorPath !== undefined) {
    if (!Array.isArray(cursorPath)) return null;
    const path: Array<{ x: number; y: number; atMs: number }> = [];
    for (const item of cursorPath) {
      const point = objectArg(item);
      if (!point || !Object.hasOwn(point, "x") || !Object.hasOwn(point, "y") || !Object.hasOwn(point, "atMs")
        || typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y)
        || typeof point.atMs !== "number" || !Number.isFinite(point.atMs) || point.atMs < 0) return null;
      path.push({ x: point.x, y: point.y, atMs: point.atMs });
    }
    cursor.path = path;
  }
  return cursor;
}
