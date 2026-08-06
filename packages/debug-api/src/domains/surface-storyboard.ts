/** Storyboard panel and graph surfaces with bounded host-provided JSON reads. */
import { convertScriptedFramesToMotionPackage } from "@shellx-motion/adapters-script";
import { hashBuffer } from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { objectArg, recordArg, stringArg } from "./args.js";

interface StoryboardPanelView {
  scriptId: string;
  name: unknown;
  workflow: unknown;
  counts: { frames: number; sourceRefs: number; assetRefs: number };
  totalDurationMs: unknown;
  review?: { required?: unknown };
  readiness: { status: unknown; diagnostics: unknown[] };
  warnings: string[];
}

interface StoryboardGraphView {
  scriptId: string;
  name: unknown;
  workflow: unknown;
  counts: { nodes: number; edges: number; frames: number; sourceRefs: number };
  readiness: { status: unknown; diagnostics: unknown[] };
  warnings: string[];
}

export interface SurfaceStoryboardServices {
  readJson?: (path: string) => Promise<unknown>;
  buildStoryboardPanel?: (script: Record<string, unknown>, scriptPath?: string) => StoryboardPanelView;
  buildStoryboardGraph?: (script: Record<string, unknown>, scriptPath?: string) => StoryboardGraphView;
}

export async function dispatchSurfaceStoryboardCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: SurfaceStoryboardServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.storyboard.panel") return panel(args, services);
  if (command === "motion.storyboard.graph") return graph(args, services);
  return null;
}

async function panel(args: unknown, services: SurfaceStoryboardServices): Promise<MotionDebugResult> {
  const loaded = await loadStoryboard("motion.storyboard.panel", args, services);
  if (isResult(loaded)) return loaded;
  if (!services.buildStoryboardPanel) return capabilityUnavailable("Storyboard panel construction is unavailable.");
  try {
    validateStoryboard(loaded);
    const result = services.buildStoryboardPanel(loaded.script, loaded.scriptPath);
    return {
      ok: true,
      receiptId: storyboardReceiptId("panel", result.scriptId, result),
      visibleState: {
        panel: "storyboard", operation: "storyboard.panel", scriptId: result.scriptId,
        name: result.name, workflow: result.workflow, frameCount: result.counts.frames,
        totalDurationMs: result.totalDurationMs, sourceRefCount: result.counts.sourceRefs,
        assetRefCount: result.counts.assetRefs, reviewRequired: result.review?.required === true,
        readinessStatus: result.readiness.status, diagnosticCount: result.readiness.diagnostics.length,
        warningCount: result.warnings.length
      },
      result: { ok: true, ...result }, warnings: result.warnings
    };
  } catch (error) {
    return commandFailure("storyboard_panel_failed", error);
  }
}

async function graph(args: unknown, services: SurfaceStoryboardServices): Promise<MotionDebugResult> {
  const loaded = await loadStoryboard("motion.storyboard.graph", args, services);
  if (isResult(loaded)) return loaded;
  if (!services.buildStoryboardGraph) return capabilityUnavailable("Storyboard graph construction is unavailable.");
  try {
    validateStoryboard(loaded);
    const result = services.buildStoryboardGraph(loaded.script, loaded.scriptPath);
    return {
      ok: true,
      receiptId: storyboardReceiptId("graph", result.scriptId, result),
      visibleState: {
        panel: "storyboard", operation: "storyboard.graph", scriptId: result.scriptId,
        name: result.name, workflow: result.workflow, nodeCount: result.counts.nodes,
        edgeCount: result.counts.edges, frameCount: result.counts.frames,
        sourceRefCount: result.counts.sourceRefs, readinessStatus: result.readiness.status,
        diagnosticCount: result.readiness.diagnostics.length, warningCount: result.warnings.length
      },
      result: { ok: true, ...result }, warnings: result.warnings
    };
  } catch (error) {
    return commandFailure("storyboard_graph_failed", error);
  }
}

interface LoadedStoryboard { script: Record<string, unknown>; scriptPath?: string }

async function loadStoryboard(
  command: "motion.storyboard.panel" | "motion.storyboard.graph",
  args: unknown,
  services: SurfaceStoryboardServices
): Promise<LoadedStoryboard | MotionDebugResult> {
  const pathArg = stringArg(args, "scriptPath") ?? stringArg(args, "storyboardPath") ?? stringArg(args, "path");
  const inline = recordArg(args, "script") ?? recordArg(args, "storyboard");
  if (!pathArg && !inline) return invalidArgs(`${command} requires scriptPath, script, or storyboard.`);
  if (inline) return { script: inline };
  if (!services.readJson) return capabilityUnavailable("Storyboard JSON reading is unavailable.");
  try {
    const scriptPath = resolve(pathArg!);
    const parsed = objectArg(await services.readJson(scriptPath));
    if (!parsed) throw new Error("Scripted-video JSON must be an object.");
    return { script: parsed, scriptPath };
  } catch (error) {
    return commandFailure(command === "motion.storyboard.panel" ? "storyboard_panel_failed" : "storyboard_graph_failed", error);
  }
}

function validateStoryboard(loaded: LoadedStoryboard): void {
  convertScriptedFramesToMotionPackage(loaded.script, { inputPath: loaded.scriptPath ?? "inline-scripted-video.json" });
}

function storyboardReceiptId(kind: string, scriptId: string, value: unknown): string {
  return `storyboard-${kind}-${safeFileToken(scriptId)}-${hashBuffer(Buffer.from(JSON.stringify(value), "utf8")).slice(0, 16)}`;
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "storyboard";
}

function isResult(value: LoadedStoryboard | MotionDebugResult): value is MotionDebugResult {
  return "ok" in value;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
