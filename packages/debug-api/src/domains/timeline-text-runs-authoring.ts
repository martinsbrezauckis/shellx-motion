/** Read-only inspection plus one-COW-receipt styled-text mutations. */
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionLayer, MotionTextRuns } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import { isTimelineTextRunsCommand, readTimelineTextRunsIntent, type TimelineTextRunsIntent } from "./timeline-text-runs.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

interface TextRunsInspection {
  layerId: string;
  textRuns: MotionTextRuns;
  plainText: string;
  fingerprint: string;
  fontAssetIds: readonly string[];
}
interface TextRunsMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "replaced" | "removed";
  changedPaths: readonly string[];
  previousFingerprint: string;
  fingerprint: string | null;
  plainText: string;
  fontAssetIds: readonly string[];
  outputMotionSha256: string;
}

export interface TimelineTextRunsCore {
  inspectMotionTextRuns(motion: MotionDocument, input: { layerId: string }): TextRunsInspection;
  replaceMotionTextRuns(motion: MotionDocument, input: { layerId: string; textRuns: MotionTextRuns }): TextRunsMutation;
  removeMotionTextRuns(motion: MotionDocument, input: { layerId: string; expectedPlainText: string }): TextRunsMutation;
}
export interface TimelineTextRunsAuthoringServices extends TimelinePackageEditServices { textRuns?: TimelineTextRunsCore; }

export async function dispatchTimelineTextRunsAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineTextRunsAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineTextRunsCommand(command)) return null;
  const parsed = readTimelineTextRunsIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, args, services);
  const common = readTimelineCommonEditArgs(command as MotionDebugCommand, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commit(command, parsed.intent, common, services);
}

/** Test seam proving parser discriminators never cross the one-to-one Core boundary. */
export function applyTimelineTextRunsIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineTextRunsIntent, { kind: "inspect" }>,
  services: TimelineTextRunsAuthoringServices,
): TextRunsMutation {
  const core = textRunsCore(services);
  if (intent.kind === "replace") return core.replaceMotionTextRuns(motion, { layerId: intent.layerId, textRuns: intent.textRuns });
  return core.removeMotionTextRuns(motion, { layerId: intent.layerId, expectedPlainText: intent.expectedPlainText });
}

async function inspect(
  command: string,
  intent: Extract<TimelineTextRunsIntent, { kind: "inspect" }>,
  args: unknown,
  services: TimelineTextRunsAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = readPackageRoot(args);
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!services.packageLoader) return unavailable("Timeline text-runs inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = textRunsCore(services).inspectMotionTextRuns(pkg.motion, { layerId: intent.layerId });
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) { return failure("timeline_text_runs_inspect_failed", error); }
}

function commit(
  command: string,
  intent: Exclude<TimelineTextRunsIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineTextRunsAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-text-runs-${intent.kind}`;
  return commitAtomicTimelineMutation<TextRunsMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_text_runs_invalid",
    failureCode: "timeline_text_runs_failed",
    services,
    mutate: (pkg) => applyTimelineTextRunsIntent(pkg.motion, intent, services),
    outputFacts: facts,
    resultFacts: facts,
    visibleFacts: facts,
  });
}

function facts(mutation: TextRunsMutation): Record<string, unknown> {
  return {
    ...timelineMutationFacts(mutation),
    textRuns: {
      action: mutation.action,
      previousFingerprint: mutation.previousFingerprint,
      ...(mutation.fingerprint === null ? {} : { fingerprint: mutation.fingerprint }),
      plainTextSha256: Core.canonicalJsonSha256(mutation.plainText),
      fontAssetIds: [...mutation.fontAssetIds],
    },
    outputMotionSha256: mutation.outputMotionSha256,
  };
}
function textRunsCore(services: TimelineTextRunsAuthoringServices): TimelineTextRunsCore {
  const core = services.textRuns ?? Core as unknown as TimelineTextRunsCore;
  if (typeof core.inspectMotionTextRuns !== "function") throw new Error("Core text-runs export inspectMotionTextRuns is unavailable.");
  return core;
}
function readPackageRoot(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, "packageRoot");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.trim().length > 0 ? descriptor.value : null;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
