/** Caption import/upsert with bounded source reads and atomic package commits. */
import {
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  hashBuffer,
  importTimelineCaptions,
  readBoundedStableFile,
  upsertTimelineCaption
} from "@shellx-motion/core";
import { isAbsolute, relative, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { nonNegativeNumberArg, positiveNumberArg, recordArg, stringArg } from "./args.js";
import { assertConfiguredAuthoringInputFile } from "./authoring-root-policy.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineCaptionsServices extends TimelinePackageEditServices {
  authoringInputRoots?: string[];
  readCaptionSource?: (path: string, roots: string[] | undefined) => Promise<{ text: string; sha256: string }>;
}

export async function dispatchTimelineCaptionsCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineCaptionsServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.caption.import") return importCaptions(args, services);
  if (command === "motion.timeline.caption.upsert") return upsertCaption(args, services);
  return null;
}

async function importCaptions(args: unknown, services: TimelineCaptionsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.caption.import", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const captionsPathArg = stringArg(args, "captionsPath") ?? stringArg(args, "captionsFile") ?? stringArg(args, "path");
  const captionsText = stringArg(args, "captionsText") ?? stringArg(args, "source");
  const format = captionFormatArg(args);
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track") ?? undefined;
  const trackName = stringArg(args, "trackName") ?? undefined;
  const layerPrefix = stringArg(args, "layerPrefix") ?? undefined;
  const transform = recordArg(args, "transform") ?? undefined;
  const style = recordArg(args, "style") ?? undefined;
  if (!captionsPathArg && !captionsText) return invalidArgs("motion.timeline.caption.import requires captionsPath or captionsText.");
  if (format === false) return unsupportedEnumValue("format", stringArg(args, "format"), "captionFormat");
  const captionsPath = captionsText === null && captionsPathArg ? resolve(captionsPathArg) : undefined;
  if (captionsPath && !services.readCaptionSource) {
    return capabilityUnavailable("Caption source file reading is unavailable.");
  }
  let sourcePromise: Promise<{ text: string; sha256: string }> | undefined;
  const source = () => sourcePromise ??= captionsText !== null
    ? Promise.resolve({ text: captionsText, sha256: hashBuffer(Buffer.from(captionsText, "utf8")) })
    : services.readCaptionSource!(captionsPath!, services.authoringInputRoots);
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.caption.import",
    receiptPrefix: "timeline-caption-import",
    receiptFileName: "timeline-caption-import.receipt.json",
    invalidCode: "timeline_caption_import_invalid",
    failureCode: "timeline_caption_import_failed",
    services,
    additionalInputHashes: async () => ({
      ...(captionsPath ? { [captionsPath]: (await source()).sha256 } : {}),
      ...(captionsText ? { captionsText: (await source()).sha256 } : {})
    }),
    mutate: async (pkg) => importTimelineCaptions(pkg.motion, {
      source: (await source()).text,
      ...(format ? { format } : {}), ...(trackId ? { trackId } : {}),
      ...(trackName ? { trackName } : {}), ...(layerPrefix ? { layerPrefix } : {}),
      ...(transform ? { transform } : {}), ...(style ? { style } : {})
    }),
    outputFacts: (result) => ({
      ...(captionsPath ? { captionsPath } : {}), format: result.format, trackId: result.trackId,
      cueCount: result.cueCount, insertedLayerIds: result.insertedLayerIds,
      replacedLayerIds: result.replacedLayerIds, trackCreated: result.trackCreated, changedPaths: result.changedPaths
    }),
    resultFacts: (result) => ({
      format: result.format, trackId: result.trackId, cueCount: result.cueCount,
      insertedLayerIds: result.insertedLayerIds, replacedLayerIds: result.replacedLayerIds,
      trackCreated: result.trackCreated, changedPaths: result.changedPaths, track: result.track
    }),
    visibleFacts: (result) => ({
      trackId: result.trackId, cueCount: result.cueCount,
      insertedLayerIds: result.insertedLayerIds, replacedLayerIds: result.replacedLayerIds
    })
  });
}

export async function readApprovedCaptionSource(
  path: string,
  roots: string[] | undefined,
): Promise<{ text: string; sha256: string }> {
  await assertConfiguredAuthoringInputFile(path, roots, "Caption source");
  const lexical = resolve(path);
  const approvedRoot = roots?.map((root) => resolve(root)).find((root) => {
    const relation = relative(root, lexical);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  });
  if (!approvedRoot) throw new Error("Caption source must be inside an approved authoring input root.");
  const snapshot = await readBoundedStableFile(lexical, {
    label: "Caption source",
    maxBytes: DEFAULT_HOST_INTERCHANGE_LIMITS.maxFileBytes,
    withinRoot: approvedRoot,
  });
  return { text: snapshot.bytes.toString("utf8"), sha256: snapshot.sha256 };
}

async function upsertCaption(args: unknown, services: TimelineCaptionsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.caption.upsert", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "id") ?? stringArg(args, "layerId") ?? stringArg(args, "layer");
  const text = stringArg(args, "text");
  const startMs = nonNegativeNumberArg(args, "startMs");
  const durationMs = positiveNumberArg(args, "durationMs");
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track") ?? undefined;
  const trackName = stringArg(args, "trackName") ?? undefined;
  const transform = recordArg(args, "transform") ?? undefined;
  const style = recordArg(args, "style") ?? undefined;
  if (!layerId) return invalidArgs("motion.timeline.caption.upsert requires caption id.");
  if (!text) return invalidArgs("motion.timeline.caption.upsert requires text.");
  if (startMs === null || startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (durationMs === null || durationMs === false) return invalidArgs("durationMs must be a positive number.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.caption.upsert",
    receiptPrefix: "timeline-caption-upsert",
    receiptFileName: "timeline-caption-upsert.receipt.json",
    invalidCode: "timeline_caption_upsert_invalid",
    failureCode: "timeline_caption_upsert_failed",
    services,
    mutate: (pkg) => upsertTimelineCaption(pkg.motion, {
      id: layerId, text, startMs, durationMs,
      ...(trackId ? { trackId } : {}), ...(trackName ? { trackName } : {}),
      ...(transform ? { transform } : {}), ...(style ? { style } : {})
    }),
    outputFacts: (result) => ({ layerId, text, startMs, durationMs, trackId: result.trackId, action: result.action, changedPaths: result.changedPaths, trackCreated: result.trackCreated }),
    resultFacts: (result) => ({ changedPaths: result.changedPaths, action: result.action, layer: result.layer, previousLayer: result.previousLayer, trackCreated: result.trackCreated, track: result.track }),
    visibleFacts: (result) => ({ layerId, trackId: result.trackId, action: result.action })
  });
}

function captionFormatArg(args: unknown): "srt" | "vtt" | "plain" | false | undefined {
  const value = stringArg(args, "format");
  if (value === null) return undefined;
  return value === "srt" || value === "vtt" || value === "plain" ? value : false;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
