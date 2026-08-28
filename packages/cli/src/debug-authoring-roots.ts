import { dirname, resolve } from "node:path";
import { debugCommandDefinition, type MotionDebugCommand } from "@shellx-motion/debug-api";
import { modularDebugAuthoringRoots } from "./modular-debug-cli";
import { revisionTransactionPlanAuthoringRoots } from "./revision-transaction-cli";

export interface CliAuthoringRoots {
  inputRoots: string[];
  outputRoots: string[];
}

/**
 * The shell CLI is the local embedding host, so it derives narrow authoring roots
 * from its own typed paths. Debug API and MCP callers remain host-configured.
 */
export function cliAuthoringRoots(command: MotionDebugCommand, args: unknown): CliAuthoringRoots | null {
  return modularDebugAuthoringRoots(command, args)
    ?? revisionTransactionPlanAuthoringRoots(command, args)
    ?? directAuthoringRoots(command, args)
    ?? copyOnWriteEditRoots(command, args);
}

/**
 * Most edit-motion Debug commands share the same packageRoot/outDir COW
 * contract. The direct CLI is the local host, so it declares their exact
 * parents once instead of relying on an omitted-root compatibility default.
 * Commands with additional authoring inputs retain their more specific mapper
 * above; Debug/MCP never calls this CLI-only function.
 */
function copyOnWriteEditRoots(command: MotionDebugCommand, args: unknown): CliAuthoringRoots | null {
  const definition = debugCommandDefinition(command);
  if (!definition?.mutates || definition.permission !== "edit_motion" || !isRecord(args)) return null;
  return rootsFor(args.packageRoot, args.outDir ?? args.packageDir);
}

function directAuthoringRoots(command: MotionDebugCommand, args: unknown): CliAuthoringRoots | null {
  if (!isRecord(args)) return null;
  switch (command) {
    case "motion.script.compile":
      return rootsFor(args.scriptPath, args.packageDir, args.script === undefined);
    case "motion.storyboard.panel":
    case "motion.storyboard.graph":
      return storyboardReadRoots(args);
    case "motion.html.snippet.export":
      return rootsFor(args.packageRoot, args.outDir);
    case "motion.html.snippet.import":
      return rootsFor(args.htmlPath, args.packageDir);
    case "motion.otio.export":
      return rootsFor(args.packageRoot, args.outPath);
    case "motion.otio.import":
      return rootsFor(args.otioPath, args.packageDir);
    case "motion.source.import":
      return rootsFor(undefined, args.outDir, false);
    case "motion.source.to_scripted_video":
    case "motion.connector.source_to_cut":
      return rootsFor(args.sourcePath, args.outDir);
    case "motion.connector.canvas_to_mp4":
    case "motion.connector.canvas_to_cut":
      return rootsFor(args.canvasSelectionPath, args.outDir);
    case "motion.connector.script_to_cut":
    case "motion.connector.cut_generate_to_cut":
      return scriptedConnectorRoots(args);
    case "motion.connector.template_to_cut":
      return packageConnectorRoots(args);
    case "motion.canvas.bridge_export":
      return outputOnlyRoots(args.outPath ?? args.path);
    case "motion.prompt.run":
      return promptRunRoots(args);
    case "motion.timeline.caption.import":
      return captionImportRoots(args);
    case "motion.template.media.replace":
      return templateMediaReplaceRoots(args);
    case "motion.timeline.shape.geometry-keyframes.inspect":
      return shapeGeometryKeyframeInspectionRoots(args);
    case "motion.timeline.shape.geometry-keyframes.upsert":
    case "motion.timeline.shape.geometry-keyframes.delete":
    case "motion.timeline.shape.geometry-keyframes.move":
    case "motion.timeline.behaviors.upsert":
    case "motion.timeline.behaviors.remove":
      return rootsFor(args.packageRoot, args.outDir);
    case "motion.timeline.behaviors.inspect":
      return shapeGeometryKeyframeInspectionRoots(args);
    case "motion.browser.workflow.capture":
      return browserWorkflowCaptureRoots(args);
    default:
      return null;
  }
}

function templateMediaReplaceRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const packageRoot = parentPath(args.packageRoot);
  const assetRoot = parentPath(args.assetPath);
  const outputRoot = parentPath(args.outDir ?? args.packageDir);
  if (!packageRoot || !assetRoot || !outputRoot) return null;
  return { inputRoots: [...new Set([packageRoot, assetRoot])], outputRoots: [outputRoot] };
}

function promptRunRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const cwd = exactDirectoryRoot(args.cwd);
  return cwd ? { inputRoots: [cwd], outputRoots: [cwd] } : null;
}

/** Read-only storyboard panels still need an explicit local input authority for path-backed JSON. */
function storyboardReadRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const path = typeof args.scriptPath === "string"
    ? args.scriptPath
    : typeof args.storyboardPath === "string"
      ? args.storyboardPath
      : args.path;
  const root = parentPath(path);
  return root ? { inputRoots: [root], outputRoots: [root] } : null;
}

function captionImportRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const outputRoot = parentPath(args.outDir);
  const packageRoot = parentPath(args.packageRoot);
  const captionsRoot = parentPath(args.captionsPath);
  if (!outputRoot || !packageRoot || !captionsRoot) return null;
  return { inputRoots: [packageRoot, captionsRoot], outputRoots: [outputRoot] };
}

function shapeGeometryKeyframeInspectionRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const packageRoot = parentPath(args.packageRoot);
  return packageRoot ? { inputRoots: [packageRoot], outputRoots: [packageRoot] } : null;
}

function browserWorkflowCaptureRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const outDir = parentPath(args.outDir);
  if (!outDir) return null;
  return {
    // Browser workflow capture reads its Motion package through the ordinary package loader; this
    // inert root only satisfies the shared CLI context shape. The admitted capture directory is
    // the sole output authority; auxiliary evidence remains subordinate to it in Debug.
    inputRoots: [outDir],
    outputRoots: [outDir]
  };
}

function rootsFor(inputPath: unknown, outputPath: unknown, requireInput = true): CliAuthoringRoots | null {
  const outputRoot = parentPath(outputPath);
  if (!outputRoot) return null;
  const inputRoot = parentPath(inputPath);
  if (requireInput && !inputRoot) return null;
  return {
    inputRoots: [inputRoot ?? outputRoot],
    outputRoots: [outputRoot]
  };
}

function scriptedConnectorRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const outputRoot = parentPath(args.outDir);
  const inputRoot = parentPath(args.scriptPath);
  const hasInlineInput = isRecord(args.script) || isRecord(args.storyboard);
  if (!outputRoot || (!inputRoot && !hasInlineInput)) return null;
  return {
    inputRoots: inputRoot ? [inputRoot] : [],
    outputRoots: [outputRoot]
  };
}

function packageConnectorRoots(args: Record<string, unknown>): CliAuthoringRoots | null {
  const inputRoot = exactDirectoryRoot(args.packageRoot);
  const outputRoot = parentPath(args.outDir);
  if (!inputRoot || !outputRoot) return null;
  return { inputRoots: [inputRoot], outputRoots: [outputRoot] };
}

function outputOnlyRoots(path: unknown): CliAuthoringRoots | null {
  const outputRoot = parentPath(path);
  return outputRoot ? { inputRoots: [], outputRoots: [outputRoot] } : null;
}

function parentPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  return dirname(resolve(value));
}

function exactDirectoryRoot(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
