/**
 * Candidate-local retained FFmpeg/FFprobe descriptors for the one sealed three-slot diagnostic.
 * This is deliberately source-relative: callers get no pathname or selectable tool capability.
 */
import { resolveFfmpegExecutable, resolveFfprobeExecutable } from "./index.js";
import {
  assertCurrentHeldToolResolution,
  assertHeldTool,
  openHeldTool,
  type HeldTool,
} from "./linear-srgb-sdr-final-held-media-files.js";

declare const toolsBrand: unique symbol;

export interface StrictSdrCandidateThreeSlotHeldTools { readonly [toolsBrand]: never; }

export type StrictSdrCandidateThreeSlotHeldToolCompletion = Readonly<{
  schema: "shellx-motion/strict-sdr-candidate-three-slot-held-tools@1";
  state: "complete" | "closed-after-refusal";
  ffmpeg: Readonly<{ sha256: string }>;
  ffprobe: Readonly<{ sha256: string }>;
  descriptorsClosed: true;
}>;

type Slot = "f2a" | "f2b-screen" | "f2b-screen-controls";
type State = "idle" | "borrowed" | "pair-finalizing" | "failed-settling" | "failed-ready-for-close" | "closing" | "closed";
type Borrow = Readonly<{ slot: Slot; ffmpeg: HeldTool; ffprobe: HeldTool }>;
type ToolsState = {
  readonly ffmpeg: HeldTool;
  readonly ffprobe: HeldTool;
  state: State;
  next: number;
  borrow: Borrow | undefined;
};

const slots: readonly Slot[] = ["f2a", "f2b-screen", "f2b-screen-controls"];
const states = new WeakMap<object, ToolsState>();

/** Open both exact resolver-backed descriptors once, before the first literal candidate slot. */
export async function openStrictSdrCandidateThreeSlotHeldTools(): Promise<StrictSdrCandidateThreeSlotHeldTools> {
  let ffmpeg: HeldTool | undefined;
  let ffprobe: HeldTool | undefined;
  try {
    ffmpeg = await openHeldTool(resolveFfmpegExecutable(), "FFmpeg");
    ffprobe = await openHeldTool(resolveFfprobeExecutable(), "FFprobe");
    await assertRetainedTools(ffmpeg, ffprobe, "three-slot owner open");
    const tools = Object.freeze({}) as StrictSdrCandidateThreeSlotHeldTools;
    states.set(tools as object, { ffmpeg, ffprobe, state: "idle", next: 0, borrow: undefined });
    return tools;
  } catch (primary) {
    const cleanup: unknown[] = [];
    await ffprobe?.handle.close().catch((error) => cleanup.push(error));
    await ffmpeg?.handle.close().catch((error) => cleanup.push(error));
    if (cleanup.length === 0) throw primary;
    throw new AggregateError([primary, ...cleanup], "Strict-SDR three-slot held-tool open failed and partial descriptor cleanup was uncertain.");
  }
}

/** Internal source-relative borrow only; the literal wrappers below own the slot choice. */
export async function borrowStrictSdrCandidateThreeSlotF2aTools(tools: StrictSdrCandidateThreeSlotHeldTools): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }>> {
  return await borrow(tools, "f2a");
}

/** Internal source-relative borrow only; no caller-selected slot enters this boundary. */
export async function borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools: StrictSdrCandidateThreeSlotHeldTools): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }>> {
  return await borrow(tools, "f2b-screen");
}

/** Internal source-relative borrow only; no caller-selected slot enters this boundary. */
export async function borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools: StrictSdrCandidateThreeSlotHeldTools): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }>> {
  return await borrow(tools, "f2b-screen-controls");
}

/** A successful named pair finalizer is the only path that makes the next literal slot borrowable. */
export function settleStrictSdrCandidateThreeSlotF2aTools(tools: StrictSdrCandidateThreeSlotHeldTools, settled: boolean): void { settle(tools, "f2a", settled); }
export function settleStrictSdrCandidateF2bScreenThreeSlotTools(tools: StrictSdrCandidateThreeSlotHeldTools, settled: boolean): void { settle(tools, "f2b-screen", settled); }
export function settleStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools: StrictSdrCandidateThreeSlotHeldTools, settled: boolean): void { settle(tools, "f2b-screen-controls", settled); }

/** Close exactly once after all successful pairs, or after the first failed pair fully settled. */
export async function closeStrictSdrCandidateThreeSlotHeldTools(
  tools: StrictSdrCandidateThreeSlotHeldTools,
): Promise<StrictSdrCandidateThreeSlotHeldToolCompletion> {
  const state = requireState(tools);
  if (state.state === "closed") throw new Error("Strict-SDR three-slot held-tool owner was already closed.");
  if (state.state === "closing") throw new Error("Strict-SDR three-slot held-tool owner close is already in progress.");
  if (state.state === "borrowed" || state.state === "pair-finalizing" || state.state === "failed-settling") {
    throw new Error("Strict-SDR three-slot held-tool owner cannot close before its current pair fully settles.");
  }
  const completed = state.state === "idle" && state.next === slots.length;
  if (!completed && state.state !== "failed-ready-for-close") {
    throw new Error("Strict-SDR three-slot held-tool owner cannot close before all slots complete or a refused slot settles.");
  }
  state.state = "closing";
  const errors: unknown[] = [];
  try { await assertRetainedTools(state.ffmpeg, state.ffprobe, "three-slot owner before descriptor close"); } catch (error) { errors.push(error); }
  await state.ffprobe.handle.close().catch((error) => errors.push(error));
  await state.ffmpeg.handle.close().catch((error) => errors.push(error));
  state.state = "closed";
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Strict-SDR three-slot held-tool close was uncertain.");
  return Object.freeze({
    schema: "shellx-motion/strict-sdr-candidate-three-slot-held-tools@1",
    state: completed ? "complete" : "closed-after-refusal",
    ffmpeg: Object.freeze({ sha256: state.ffmpeg.sha256 }),
    ffprobe: Object.freeze({ sha256: state.ffprobe.sha256 }),
    descriptorsClosed: true,
  });
}

async function borrow(tools: StrictSdrCandidateThreeSlotHeldTools, slot: Slot): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }>> {
  const state = requireState(tools);
  if (state.state !== "idle" || slots[state.next] !== slot || state.borrow) {
    throw new Error("Strict-SDR three-slot held-tool owner refused an out-of-order, duplicate, or failed slot borrow.");
  }
  state.borrow = Object.freeze({ slot, ffmpeg: state.ffmpeg, ffprobe: state.ffprobe });
  state.state = "borrowed";
  try {
    await assertRetainedTools(state.ffmpeg, state.ffprobe, `three-slot ${slot} before borrow`);
  } catch (error) {
    state.borrow = undefined;
    state.state = "failed-ready-for-close";
    throw error;
  }
  return Object.freeze({ ffmpeg: state.ffmpeg, ffprobe: state.ffprobe });
}

function settle(tools: StrictSdrCandidateThreeSlotHeldTools, slot: Slot, settled: boolean): void {
  const state = requireState(tools);
  if (!state.borrow || state.borrow.slot !== slot || (state.state !== "borrowed" && state.state !== "pair-finalizing" && state.state !== "failed-settling")) {
    throw new Error("Strict-SDR three-slot held-tool settlement did not match its active literal borrow.");
  }
  const failed = state.state === "failed-settling" || !settled;
  state.state = "pair-finalizing";
  state.borrow = undefined;
  if (failed) {
    state.state = "failed-ready-for-close";
    return;
  }
  state.next += 1;
  state.state = "idle";
}

export function markStrictSdrCandidateThreeSlotF2aToolsFailure(tools: StrictSdrCandidateThreeSlotHeldTools): void { markFailure(tools, "f2a"); }
export function markStrictSdrCandidateF2bScreenThreeSlotToolsFailure(tools: StrictSdrCandidateThreeSlotHeldTools): void { markFailure(tools, "f2b-screen"); }
export function markStrictSdrCandidateF2bScreenControlsThreeSlotToolsFailure(tools: StrictSdrCandidateThreeSlotHeldTools): void { markFailure(tools, "f2b-screen-controls"); }

function markFailure(tools: StrictSdrCandidateThreeSlotHeldTools, slot: Slot): void {
  const state = requireState(tools);
  if (!state.borrow || state.borrow.slot !== slot) {
    throw new Error("Strict-SDR three-slot held-tool failure did not match its active literal borrow.");
  }
  if (state.state === "borrowed" || state.state === "pair-finalizing") state.state = "failed-settling";
}

export async function currentStrictSdrCandidateThreeSlotHeldToolsForActiveBorrow(
  tools: StrictSdrCandidateThreeSlotHeldTools,
): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }>> {
  const state = requireState(tools);
  if (state.state === "closed" || !state.borrow) throw new Error("Strict-SDR three-slot held-tool descriptors are not actively borrowed.");
  await assertRetainedTools(state.ffmpeg, state.ffprobe, "three-slot active held-media borrow");
  return Object.freeze({ ffmpeg: state.ffmpeg, ffprobe: state.ffprobe });
}

async function assertRetainedTools(ffmpeg: HeldTool, ffprobe: HeldTool, label: string): Promise<void> {
  assertCurrentHeldToolResolution(ffmpeg, resolveFfmpegExecutable, `FFmpeg ${label}`);
  await assertHeldTool(ffmpeg, `FFmpeg ${label}`);
  assertCurrentHeldToolResolution(ffprobe, resolveFfprobeExecutable, `FFprobe ${label}`);
  await assertHeldTool(ffprobe, `FFprobe ${label}`);
}

function requireState(tools: StrictSdrCandidateThreeSlotHeldTools): ToolsState {
  const state = states.get(tools as object);
  if (!state) throw new TypeError("Strict-SDR three-slot held-tool owner is forged or expired.");
  return state;
}
