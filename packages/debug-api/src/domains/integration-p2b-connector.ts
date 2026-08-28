/** P2B connector admission and committed-delivery observation for Debug. */
import { resolve } from "node:path";
import {
  runCanvasToCutConnector,
  runScriptToCutConnector,
  runSourceToCutConnector
} from "@shellx-motion/connectors";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { nonNegativeIntegerArg, positiveIntegerArg, recordArg, stringArg } from "./args.js";
import {
  assertConfiguredAuthoringInputFile,
  assertConfiguredAuthoringOutputRoot,
  configuredAuthoringInputRoot
} from "./authoring-root-policy.js";
import type { IntegrationDomainServices as IntegrationServices } from "./integration-services.js";
import { connectorException, connectorResult } from "./integration-connector-observer.js";

const P2B_COMMANDS = new Set<MotionDebugCommand>([
  "motion.connector.canvas_to_cut",
  "motion.connector.script_to_cut",
  "motion.connector.source_to_cut"
]);

export async function dispatchP2bConnectorCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: IntegrationServices
): Promise<MotionDebugResult | null> {
  if (!P2B_COMMANDS.has(command)) return null;
  if (command === "motion.connector.canvas_to_cut") return dispatchCanvas(command, args, services);
  if (command === "motion.connector.source_to_cut") return dispatchSource(command, args, services);
  return dispatchScript(command, args, services);
}

async function dispatchCanvas(command: MotionDebugCommand, args: unknown, services: IntegrationServices): Promise<MotionDebugResult> {
  const canvasSelectionPath = stringArg(args, "canvasSelectionPath");
  const outDir = stringArg(args, "outDir");
  const modeArg = stringArg(args, "cutImportMode");
  if (!canvasSelectionPath) return invalidArgs("motion.connector.canvas_to_cut requires canvasSelectionPath.");
  if (!outDir) return invalidArgs("motion.connector.canvas_to_cut requires outDir.");
  if (modeArg !== null && modeArg !== "rendered_media") return invalidArgs("motion.connector.canvas_to_cut P2B accepts only cutImportMode rendered_media.");
  const platformRefusal = p2bPlatformRefusal(command);
  if (platformRefusal) return platformRefusal;
  if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
    return capabilityUnavailable("Canvas-to-Cut P2B requires host-approved authoring input and output roots.");
  }
  try {
    await assertConfiguredAuthoringInputFile(canvasSelectionPath, services.authoringInputRoots, "Canvas-to-Cut selection");
    await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "Canvas-to-Cut P2B output");
    const result = await runCanvasToCutConnector({ canvasSelectionPath, outDir });
    return connectorResult(command, redactP2bInputPaths(result, [canvasSelectionPath]), services, {
      panel: "receipts", operation: "connector.canvas_to_cut", ok: result.ok, cutPlanPath: result.cutPlanPath, receiptPath: result.receiptPath
    }, {}, { atomic: true });
  } catch (error) {
    return p2bConnectorException(error, [canvasSelectionPath]);
  }
}

async function dispatchSource(command: MotionDebugCommand, args: unknown, services: IntegrationServices): Promise<MotionDebugResult> {
  const sourcePath = stringArg(args, "sourcePath");
  const outDir = stringArg(args, "outDir");
  const modeArg = stringArg(args, "cutImportMode");
  const optionValues = {
    maxFrames: positiveIntegerArg(args, "maxFrames"),
    frameDurationMs: positiveIntegerArg(args, "frameDurationMs"),
    width: positiveIntegerArg(args, "width"),
    height: positiveIntegerArg(args, "height"),
    fps: positiveIntegerArg(args, "fps")
  };
  if (!sourcePath) return invalidArgs("motion.connector.source_to_cut requires sourcePath.");
  if (!outDir) return invalidArgs("motion.connector.source_to_cut requires outDir.");
  for (const [label, value] of Object.entries(optionValues)) {
    if (value === false) return invalidArgs(`${label} must be a positive integer.`);
  }
  if (modeArg !== null && modeArg !== "rendered_media") return invalidArgs("motion.connector.source_to_cut P2B accepts only cutImportMode rendered_media.");
  const platformRefusal = p2bPlatformRefusal(command);
  if (platformRefusal) return platformRefusal;
  if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
    return capabilityUnavailable("Source-to-Cut P2B requires host-approved authoring input and output roots.");
  }
  let sourceInputRoot: string | undefined;
  try {
    await assertConfiguredAuthoringInputFile(sourcePath, services.authoringInputRoots, "Source-to-Cut Markdown");
    const configuredInputRoot = configuredAuthoringInputRoot(sourcePath, services.authoringInputRoots, "Source-to-Cut Markdown");
    sourceInputRoot = configuredInputRoot;
    await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "Source-to-Cut P2B output");
    const result = await runSourceToCutConnector({
      sourcePath,
      sourceInputRoot: configuredInputRoot,
      outDir,
      ...(typeof optionValues.maxFrames === "number" ? { maxFrames: optionValues.maxFrames } : {}),
      ...(typeof optionValues.frameDurationMs === "number" ? { frameDurationMs: optionValues.frameDurationMs } : {}),
      ...(typeof optionValues.width === "number" ? { width: optionValues.width } : {}),
      ...(typeof optionValues.height === "number" ? { height: optionValues.height } : {}),
      ...(typeof optionValues.fps === "number" ? { fps: optionValues.fps } : {})
    });
    return connectorResult(command, redactP2bInputPaths(result, [sourcePath, configuredInputRoot]), services, {
      panel: "receipts", operation: "connector.source_to_cut", ok: result.ok, sourceInput: "markdown",
      scriptPath: result.storyboard.scriptPath, packageDir: result.packageDir,
      ...(result.preview.outputPath ? { previewFramePath: result.preview.outputPath } : {}),
      ...(result.render.outputPath ? { renderedMediaPath: result.render.outputPath } : {}),
      cutPlanPath: result.cutPlanPath, receiptPath: result.receiptPath
    }, {}, { atomic: true });
  } catch (error) {
    return p2bConnectorException(error, [sourcePath, ...(sourceInputRoot ? [sourceInputRoot] : [])]);
  }
}

async function dispatchScript(command: MotionDebugCommand, args: unknown, services: IntegrationServices): Promise<MotionDebugResult> {
  const scriptPathArg = stringArg(args, "scriptPath");
  const inlineScript = recordArg(args, "script");
  const storyboard = recordArg(args, "storyboard");
  const outDir = stringArg(args, "outDir");
  const modeArg = stringArg(args, "cutImportMode");
  const startMs = nonNegativeIntegerArg(args, "startMs");
  const durationMs = positiveIntegerArg(args, "durationMs");
  const track = stringArg(args, "track");
  if (inputSourceCount(scriptPathArg, inlineScript, storyboard) !== 1) return invalidArgs("motion.connector.script_to_cut requires exactly one input source: scriptPath, script, or storyboard.");
  if (!outDir) return invalidArgs("motion.connector.script_to_cut requires outDir.");
  if (modeArg !== null && modeArg !== "rendered_media") return invalidArgs("motion.connector.script_to_cut P2B accepts only cutImportMode rendered_media.");
  if (startMs === false || durationMs === false) return invalidArgs("Script-to-Cut placement startMs/durationMs must be safe integers, with durationMs positive.");
  if (track !== null && !track.trim()) return invalidArgs("Script-to-Cut placement track must be non-empty.");
  const platformRefusal = p2bPlatformRefusal(command);
  if (platformRefusal) return platformRefusal;
  if (!services.authoringOutputRoots?.length || (scriptPathArg && !services.authoringInputRoots?.length)) {
    return capabilityUnavailable("Script-to-Cut P2B requires a host-approved output root and an approved input root for scriptPath.");
  }
  try {
    if (scriptPathArg) await assertConfiguredAuthoringInputFile(scriptPathArg, services.authoringInputRoots, "Script-to-Cut script");
    await assertConfiguredAuthoringOutputRoot(outDir, services.authoringOutputRoots, "Script-to-Cut P2B output");
    const script = inlineScript ?? storyboard;
    const cutPlacement = {
      ...(typeof startMs === "number" ? { startMs } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      ...(track ? { track } : {})
    };
    const result = await runScriptToCutConnector({
      ...(scriptPathArg ? { scriptPath: scriptPathArg } : { script: script! }),
      outDir,
      ...(Object.keys(cutPlacement).length > 0 ? { cutPlacement } : {})
    });
    return connectorResult(command, redactP2bInputPaths(result, scriptPathArg ? [scriptPathArg] : []), services, {
      panel: "receipts", operation: "connector.script_to_cut", ok: result.ok,
      scriptInput: scriptPathArg ? "file" : "inline",
      packageDir: result.packageDir,
      ...(result.preview.outputPath ? { previewFramePath: result.preview.outputPath } : {}),
      ...(result.render.outputPath ? { renderedMediaPath: result.render.outputPath } : {}),
      cutPlanPath: result.cutPlanPath, receiptPath: result.receiptPath
    }, { scriptInput: scriptPathArg ? "file" : "inline" }, { atomic: true });
  } catch (error) {
    return p2bConnectorException(error, scriptPathArg ? [scriptPathArg] : []);
  }
}

function p2bPlatformRefusal(command: MotionDebugCommand): MotionDebugResult | undefined {
  return process.platform === "linux" ? undefined : {
    ok: false,
    error: { code: "platform_inapplicable", message: `${command} P2B is Linux-only Browser-to-FFmpeg rendered_media delivery.` },
    warnings: []
  };
}

function inputSourceCount(scriptPath: string | null, script: Record<string, unknown> | null, storyboard: Record<string, unknown> | null): number {
  return Number(Boolean(scriptPath)) + Number(Boolean(script)) + Number(Boolean(storyboard));
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function redactP2bInputPaths<T>(value: T, paths: string[]): T {
  const privatePaths = new Set(paths);
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === "string") return privatePaths.has(candidate) ? undefined : candidate;
    if (Array.isArray(candidate)) return candidate.map(redact).filter((entry) => entry !== undefined);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate).flatMap(([key, entry]) => {
      const redacted = redact(entry);
      return redacted === undefined ? [] : [[key, redacted]];
    }));
  };
  return redact(value) as T;
}

/** P2B external inputs are evidence only, including when a lower layer throws their path. */
function p2bConnectorException(error: unknown, paths: string[]): MotionDebugResult {
  const result = connectorException(error);
  const privatePaths = [...new Set(paths.flatMap((path) => [path, resolve(path)]))].sort((left, right) => right.length - left.length);
  const redactText = (candidate: unknown): unknown => {
    if (typeof candidate === "string") return privatePaths.reduce((text, path) => text.replaceAll(path, "[P2B input]"), candidate);
    if (Array.isArray(candidate)) return candidate.map(redactText);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, redactText(entry)]));
  };
  return redactText(result) as MotionDebugResult;
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message }, warnings: [] };
}
