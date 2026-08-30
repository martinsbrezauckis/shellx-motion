import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type { MotionDebugCommand, MotionDebugContext, ReceiptActor } from "@shellx-motion/debug-api";
import type { CliAuthoringRoots } from "./debug-authoring-roots.js";

export function debugScratchRoot(
  debugName: MotionDebugCommand,
  args: unknown,
  explicitScratchRoot?: string,
): string | undefined {
  if (explicitScratchRoot) return explicitScratchRoot;
  const record = readRecord(args);
  if (!record) return undefined;
  if (debugName === "motion.support.bundle") {
    return typeof record.outDir === "string" ? dirname(resolve(record.outDir)) : undefined;
  }
  if (debugName === "motion.quality.panel") {
    return typeof record.qualityManifestPath === "string"
      ? dirname(resolve(record.qualityManifestPath))
      : undefined;
  }
  if (debugName === "motion.agent.revision.plan") {
    if (typeof record.planPath === "string") return dirname(resolve(record.planPath));
    return typeof record.receiptsRoot === "string" ? resolve(record.receiptsRoot) : undefined;
  }
  return undefined;
}

/** Input directories the local CLI operator explicitly selected for a Debug command. */
export function debugTrustedInputRoots(args: unknown): string[] | undefined {
  const record = readRecord(args);
  if (!record) return undefined;
  const paths = [record.workflowPath, record.qualityManifestPath, record.rowsPath]
    .filter((value): value is string => typeof value === "string")
    .map((path) => dirname(resolve(path)));
  return paths.length > 0 ? [...new Set(paths)] : undefined;
}

/**
 * The direct CLI is the local host, so it derives a closed render authority
 * from its parsed command once. These roots are context, never Debug args, and
 * no remote transport calls this helper.
 */
export function debugRenderRoots(
  debugName: MotionDebugCommand,
  args: unknown,
): { packageRoots: string[]; inputRoots: string[]; outputRoots: string[] } | undefined {
  if (debugName !== "motion.render.final" && debugName !== "motion.render.batch") return undefined;
  const record = readRecord(args);
  if (!record || typeof record.packageRoot !== "string") return undefined;
  const output = debugName === "motion.render.final" ? record.outputPath : record.outDir;
  if (typeof output !== "string") return undefined;
  const packageRoot = resolve(record.packageRoot);
  const inputRoots = [
    packageRoot,
    ...[record.rowsPath, record.workflowPath, record.qualityManifestPath]
      .filter((value): value is string => typeof value === "string")
      .map((path) => dirname(resolve(path)))
  ];
  const outputRoots = [
    nearestExistingDirectory(debugName === "motion.render.final" ? dirname(resolve(output)) : resolve(output)),
    ...[record.framesDir, record.receiptsRoot]
      .filter((value): value is string => typeof value === "string")
      .map((path) => nearestExistingDirectory(resolve(path)))
  ];
  return {
    packageRoots: [packageRoot],
    inputRoots: [...new Set(inputRoots)],
    outputRoots: [...new Set(outputRoots)]
  };
}

interface CliDebugDispatchContextInput {
  debugName: MotionDebugCommand;
  tier: MotionDebugContext["tier"];
  actor: ReceiptActor;
  /** Host-selected lifecycle/job principal; never derived from the actor label. */
  callerId: string;
  scratchRoot?: string;
  cliHostReceiptStore?: { receiptsRoot: string; writeReceipt: NonNullable<MotionDebugContext["hostReceiptWriter"]> };
  cliReceiptsRoot?: string;
  cliDefaultPlatformReceiptsRoot?: string;
  authoringRoots?: { inputRoots: string[]; outputRoots: string[] } | null;
  trustedInputRoots?: string[];
  renderRoots?: NonNullable<ReturnType<typeof debugRenderRoots>>;
  promptRuntime?: MotionDebugContext["promptRuntime"];
  agentRuntime?: MotionDebugContext["agentRuntime"];
  ffmpegRunner?: MotionDebugContext["ffmpegRunner"];
  browserFrameRenderer?: MotionDebugContext["browserFrameRenderer"];
  sourceFetcher?: MotionDebugContext["sourceFetcher"];
  sourceResolver?: MotionDebugContext["sourceResolver"];
}

/**
 * Build the direct CLI's host context without letting Debug request fields add
 * authority. The shell operator is the host, so a parsed receipts-root is
 * host-nominated; Debug API/MCP callers do not use this path across a boundary.
 */
export function cliDebugDispatchContext(input: CliDebugDispatchContextInput): MotionDebugContext {
  return {
    tier: input.tier,
    actor: input.actor,
    callerId: input.callerId,
    // The direct shell operator already owns the local receipt files and is the explicit host.
    // Keep legacy ownerless lifecycle evidence readable without weakening remote transports.
    crossCallerJobScope: true,
    ...(input.scratchRoot
      ? { scratchRoot: input.scratchRoot }
      : input.cliHostReceiptStore
        ? { receiptsRoot: input.cliHostReceiptStore.receiptsRoot, hostReceiptWriter: input.cliHostReceiptStore.writeReceipt }
        : input.cliReceiptsRoot ? { receiptsRoot: input.cliReceiptsRoot }
        : input.cliDefaultPlatformReceiptsRoot ? { receiptsRoot: input.cliDefaultPlatformReceiptsRoot }
        : {}),
    ...(input.authoringRoots ? { authoringInputRoots: input.authoringRoots.inputRoots, authoringOutputRoots: input.authoringRoots.outputRoots, ...(input.debugName === "motion.prompt.run" ? { promptCwdRoots: input.authoringRoots.inputRoots } : {}) } : {}),
    ...(input.trustedInputRoots ? { qualityInputRoots: input.trustedInputRoots } : {}),
    ...(input.renderRoots ? { renderPackageRoots: input.renderRoots.packageRoots, renderInputRoots: input.renderRoots.inputRoots, renderOutputRoots: input.renderRoots.outputRoots } : {}),
    ...(input.promptRuntime ? { promptRuntime: input.promptRuntime } : {}),
    ...(input.agentRuntime ? { agentRuntime: input.agentRuntime } : {}),
    ...(input.ffmpegRunner ? { ffmpegRunner: input.ffmpegRunner } : {}),
    ...(input.browserFrameRenderer ? { browserFrameRenderer: input.browserFrameRenderer } : {}),
    ...(input.sourceFetcher ? { sourceFetcher: input.sourceFetcher } : {}),
    ...(input.sourceResolver ? { sourceResolver: input.sourceResolver } : {})
  };
}

/**
 * The source CLI owns repo-local package reads and COW. It scopes its canonical
 * module-derived source-checkout workspace only when all selected paths already
 * sit below it. argv can select a route but cannot choose the host anchor;
 * external paths retain Core's ordinary full-ancestor policy.
 */
export async function withCliSourceWorkspaceAnchor<T>(
  operationPaths: readonly string[] | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (process.platform === "win32" || typeof process.getuid !== "function" || !operationPaths || operationPaths.length === 0) {
    return await operation();
  }
  const workspace = sourceCheckoutWorkspaceRoot();
  if (!workspace) return await operation();
  if (!operationPaths.every((path) => isWorkspacePath(workspace, resolve(path)))) return await operation();
  let anchor;
  try {
    anchor = await createTrustedWorkspaceAnchor(workspace);
  } catch {
    return await operation();
  }
  return await withTrustedWorkspaceAnchor(anchor, operation);
}

/**
 * Source-checkout paths eligible for the CLI's module-derived workspace anchor.
 * `cliAuthoringRoots` is the single metadata-backed local-path selection for every direct CLI
 * authoring command. Keep source-anchor selection bound to it, rather than growing an independent
 * command list whenever a new COW family is added. The two receipt roots are host/CLI-owned
 * supplements: they are retained so a selected package edit cannot anchor its package and output
 * while omitting a receipt publication path from the same operation.
 */
export function sourceWorkspaceOperationPaths(
  args: unknown,
  authoringRoots: CliAuthoringRoots | null | undefined,
  hostReceiptsRoot?: string,
  rawDebugFileInputs: readonly string[] = [],
): string[] | undefined {
  if (!authoringRoots) return undefined;
  const record = readRecord(args);
  const explicitReceiptsRoot = typeof record?.receiptsRoot === "string" ? record.receiptsRoot : undefined;
  const paths = [
    ...authoringRoots.inputRoots,
    ...authoringRoots.outputRoots,
    ...rawDebugFileInputs,
    ...(explicitReceiptsRoot ? [explicitReceiptsRoot] : []),
    ...(hostReceiptsRoot ? [hostReceiptsRoot] : []),
  ].map((path) => resolve(path));
  return paths.length > 0 ? [...new Set(paths)] : undefined;
}

/**
 * Preserves selected CLI-only file inputs after a typed adapter has decoded their JSON into a
 * public Debug request. This is deliberately argv-only: it neither reads the file nor adds it to
 * Debug/MCP arguments. A selected external file only prevents the source-checkout anchor from
 * activating; it never creates a new authority.
 */
export function rawDebugFileInputPaths(
  argv: readonly string[],
  resolveInputPath: (path: string) => string,
): string[] {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (!/^--[a-z0-9]+(?:-[a-z0-9]+)*-file$/.test(argv[index] ?? "")) continue;
    const value = argv[index + 1];
    if (!value) continue;
    paths.push(resolveInputPath(value));
    index += 1;
  }
  return [...new Set(paths)];
}

/** @deprecated Use sourceWorkspaceOperationPaths for all host-admitted source operations. */
export const packagePatchWorkspacePaths = sourceWorkspaceOperationPaths;

/** Selected authoring roots are often a parent of a source/out leaf, so the checkout root itself
 * is an admissible selection. Core still requires every concrete output target to be a strict
 * descendant of the active trusted-workspace anchor. */
function isWorkspacePath(root: string, path: string): boolean {
  if (root === path) return true;
  const suffix = relative(root, path);
  return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function sourceCheckoutWorkspaceRoot(): string | undefined {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return existsSync(join(root, "pnpm-workspace.yaml")) ? root : undefined;
}

function nearestExistingDirectory(path: string): string {
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
