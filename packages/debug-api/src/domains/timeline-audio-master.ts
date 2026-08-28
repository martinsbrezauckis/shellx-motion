/** Document-level audio master and exact two-layer crossfade edits. */
import {
  setMotionAudioCrossfade,
  setMotionAudioMaster,
  type MotionDocument,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, nonNegativeNumberArg, objectArg, recordArg, stringArg } from "./args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelineCommonEditArgs,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

export interface TimelineAudioMasterServices extends TimelinePackageEditServices {}

export async function dispatchTimelineAudioMasterCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineAudioMasterServices,
): Promise<MotionDebugResult | null> {
  if (command === "motion.audio.master.set") return masterSet(args, services);
  if (command === "motion.audio.crossfade.set") return crossfadeSet(args, services);
  return null;
}

async function masterSet(args: unknown, services: TimelineAudioMasterServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.audio.master.set", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const input = objectArg(args);
  if (!input) return invalid("motion.audio.master.set args must be an object.");
  const master = recordArg(args, "master");
  const clear = booleanArg(args, "clear");
  if (Object.hasOwn(input, "master") && !master) return invalid("motion.audio.master.set master must be an object.");
  if (Object.hasOwn(input, "clear") && clear === null) return invalid("motion.audio.master.set clear must be a boolean.");
  if (clear === false) return invalid("motion.audio.master.set clear must be true when supplied.");
  if (clear === true && master) return invalid("motion.audio.master.set accepts either master or clear, not both.");
  if (clear !== true && !master) return invalid("motion.audio.master.set requires master or clear: true.");
  return execute(common, {
    command: "motion.audio.master.set",
    receiptPrefix: "audio-master-set",
    invalidCode: "audio_master_invalid",
    failureCode: "audio_master_failed",
    services,
    mutate: (motion) => setMotionAudioMaster(motion, clear ? null : master),
    output: (result) => ({ oldMaster: result.oldMaster, newMaster: result.newMaster, changedPaths: result.changedPaths, action: result.action }),
  });
}

async function crossfadeSet(args: unknown, services: TimelineAudioMasterServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.audio.crossfade.set", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const input = objectArg(args);
  if (!input) return invalid("motion.audio.crossfade.set args must be an object.");
  const fromLayerId = stringArg(args, "fromLayerId") ?? stringArg(args, "fromLayer");
  const toLayerId = stringArg(args, "toLayerId") ?? stringArg(args, "toLayer");
  const durationMs = nonNegativeNumberArg(args, "durationMs");
  const curve = stringArg(args, "curve");
  if (!fromLayerId || !toLayerId) return invalid("motion.audio.crossfade.set requires fromLayerId and toLayerId.");
  if (durationMs === false || durationMs === null || durationMs <= 0) return invalid("motion.audio.crossfade.set durationMs must be a positive finite number.");
  if ((Object.hasOwn(input, "curve") && curve === null) || (curve !== null && curve !== "linear" && curve !== "equal-power")) {
    return invalid('motion.audio.crossfade.set curve must be "linear" or "equal-power".');
  }
  return execute(common, {
    command: "motion.audio.crossfade.set",
    receiptPrefix: "audio-crossfade-set",
    invalidCode: "audio_crossfade_invalid",
    failureCode: "audio_crossfade_failed",
    services,
    mutate: (motion) => setMotionAudioCrossfade(motion, { fromLayerId, toLayerId, durationMs, ...(curve ? { curve } : {}) }),
    output: (result) => ({ fromLayerId: result.fromLayerId, toLayerId: result.toLayerId, durationMs: result.durationMs, curve: result.curve, changedPaths: result.changedPaths }),
  });
}

function execute<T extends { motion: MotionDocument; changedPaths: string[] }>(
  common: TimelineCommonEditArgs,
  input: {
    command: MotionDebugCommand;
    receiptPrefix: string;
    invalidCode: string;
    failureCode: string;
    services: TimelineAudioMasterServices;
    mutate: (motion: MotionDocument) => T;
    output: (result: T) => Record<string, unknown>;
  },
): Promise<MotionDebugResult> {
  return commitAtomicTimelineMutation({
    ...common,
    command: input.command,
    receiptPrefix: input.receiptPrefix,
    receiptFileName: `${input.receiptPrefix}.receipt.json`,
    invalidCode: input.invalidCode,
    failureCode: input.failureCode,
    services: input.services,
    mutate: (pkg) => input.mutate(pkg.motion),
    outputFacts: input.output,
    resultFacts: input.output,
    visibleFacts: input.output,
  });
}

function invalid(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
