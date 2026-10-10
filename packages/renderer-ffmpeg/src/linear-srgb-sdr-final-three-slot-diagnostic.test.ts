import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalMotionJobContext, LocalMotionJobEvidence, LocalMotionJobGovernor, OperationReceipt } from "@shellx-motion/core";
import {
  abortStrictSdrCandidateHeldPair,
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  commitStrictSdrCandidateHeldPair,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeStrictSdrCandidateHeldPair,
  createStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  recordStrictSdrCandidateHeldMediaStage,
  stageStrictSdrCandidateFinalReceipt,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldPairObservation,
  type StrictSdrCandidateHeldPairRendererBinding,
  type StrictSdrCandidateHeldWorkspace,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import {
  captureCurrentStrictSdrCandidateThreeSlotFrame,
  evaluateStrictSdrCandidateF2bScreenControlsThreeSlotHeldPair,
  evaluateStrictSdrCandidateF2bScreenThreeSlotHeldPair,
  evaluateStrictSdrCandidateThreeSlotF2aHeldPair,
  strictSdrCandidateF2bScreenControlsThreeSlotFinalization,
  strictSdrCandidateF2bScreenThreeSlotFinalization,
  strictSdrCandidateThreeSlotF2aFinalization,
  transferCurrentStrictSdrCandidateThreeSlotLease,
  withStrictSdrCandidateF2bScreenControlsThreeSlotEvaluation,
  withStrictSdrCandidateF2bScreenThreeSlotEvaluation,
  withStrictSdrCandidateThreeSlotF2aEvaluation,
  type StrictSdrCandidateThreeSlotLeaseOwner,
} from "./linear-srgb-sdr-final-three-slot-diagnostic.js";
import {
  borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools,
  borrowStrictSdrCandidateF2bScreenThreeSlotTools,
  closeStrictSdrCandidateThreeSlotHeldTools,
  markStrictSdrCandidateF2bScreenThreeSlotToolsFailure,
  markStrictSdrCandidateThreeSlotF2aToolsFailure,
  openStrictSdrCandidateThreeSlotHeldTools,
  settleStrictSdrCandidateThreeSlotF2aTools,
  settleStrictSdrCandidateF2bScreenThreeSlotTools,
  type StrictSdrCandidateThreeSlotHeldTools,
} from "./linear-srgb-sdr-final-three-slot-held-tools.js";
import { portableFfmpegContainmentEvidence } from "./ffmpeg-process-control.js";
import {
  readStrictSdrCandidateF2bScreenControlsFrame0Pack,
  readStrictSdrCandidateF2bScreenFrame0Pack,
  readStrictSdrCandidateThreeSlotF2aFrame0Pack,
  initializeCurrentStrictSdrCandidateFrame0Pack,
  withStrictSdrCandidateF2bScreenControlsFrame0Pack,
  withStrictSdrCandidateF2bScreenFrame0Pack,
  withStrictSdrCandidateThreeSlotF2aFrame0Pack,
  type StrictSdrCandidateFrame0PackSealed,
} from "./linear-srgb-sdr-final-three-slot-frame0-pack.js";
import { strictSdrCandidateFrame0PackLeafNames, type StrictSdrCandidateFrame0PackAllocation, type StrictSdrCandidateFrame0PackSlot } from "./linear-srgb-sdr-final-three-slot-frame0-pack-layout.js";
import type { HeldFileFacts, HeldLeaf } from "./linear-srgb-sdr-final-held-media-files.js";
import {
  readStrictSdrCandidateF2bScreenAllDeliveredFrameObservation,
  readStrictSdrCandidateF2bScreenControlsAllDeliveredFrameObservation,
  readStrictSdrCandidateThreeSlotF2aAllDeliveredFrameObservation,
  withStrictSdrCandidateF2bScreenAllDeliveredFrameObservation,
  withStrictSdrCandidateF2bScreenControlsAllDeliveredFrameObservation,
  withStrictSdrCandidateThreeSlotF2aAllDeliveredFrameObservation,
} from "./linear-srgb-sdr-final-three-slot-temporal-observation.js";

const PREPARATION = "a".repeat(64);
const oldFfmpeg = process.env.SHELLX_MOTION_FFMPEG;
const oldFfprobe = process.env.SHELLX_MOTION_FFPROBE;
const owners: StrictSdrCandidateThreeSlotHeldTools[] = [];
const TEMPORAL_BINDING = Object.freeze({ schema: "shellx-motion/strict-sdr-candidate-all-delivered-frame-observation@1", width: 1280, height: 720, rgbaFrameBytes: 3_686_400, fps: 30, durationMs: 2_000, frameCount: 60, decodedByteLength: 221_184_000, maxAdmittedChunkBytes: 1_048_576, maxSlotReportBytes: 98_304, maxChildReportBytes: 294_912 });
type LiteralSlot = "f2a" | "f2b-screen" | "f2b-screen-controls";
type LiteralMeasurement = Awaited<ReturnType<typeof evaluateStrictSdrCandidateThreeSlotF2aHeldPair>>
  | Awaited<ReturnType<typeof evaluateStrictSdrCandidateF2bScreenThreeSlotHeldPair>>
  | Awaited<ReturnType<typeof evaluateStrictSdrCandidateF2bScreenControlsThreeSlotHeldPair>>;

afterEach(async () => {
  if (oldFfmpeg === undefined) delete process.env.SHELLX_MOTION_FFMPEG;
  else process.env.SHELLX_MOTION_FFMPEG = oldFfmpeg;
  if (oldFfprobe === undefined) delete process.env.SHELLX_MOTION_FFPROBE;
  else process.env.SHELLX_MOTION_FFPROBE = oldFfprobe;
  while (owners.length > 0) {
    const tools = owners.pop()!;
    try { markStrictSdrCandidateThreeSlotF2aToolsFailure(tools); settleStrictSdrCandidateThreeSlotF2aTools(tools, false); } catch { /* already terminal */ }
    await closeStrictSdrCandidateThreeSlotHeldTools(tools).catch(() => undefined);
  }
});

describe.skipIf(process.platform !== "linux")("three-slot diagnostic scopes", () => {
  it("holds the exact tool descriptors through the consumed F2a pair and releases the literal next borrower only after finalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-evaluator-"));
    const tools = await owner(), route = routeFor("f2a"), frame = frameFor(route), caller = new AbortController(), fresh = new AbortController();
    let workspace: StrictSdrCandidateHeldWorkspace | undefined;
    let pair: StrictSdrCandidateHeldPair | undefined;
    let completedPair: StrictSdrCandidateHeldPair | undefined;
    let binding: StrictSdrCandidateHeldPairRendererBinding | undefined;
    let sourceFd = -1, closeCalls = 0;
    let measurement: Awaited<ReturnType<typeof evaluateStrictSdrCandidateThreeSlotF2aHeldPair>> | undefined;
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
        await withStrictSdrCandidateThreeSlotF2aEvaluation(tools, PREPARATION, async () => {
          await withStrictSdrCandidateHeldWorkspace(workspace!, PREPARATION, async () => {
            pair = await openStrictSdrCandidateHeldPair(workspace!);
            const opened = pair;
            completedPair = opened;
            await withStrictSdrCandidateHeldPairRendering(opened, PREPARATION, async () => {
              binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(
                strictSdrCandidateOutputPublication(opened), PREPARATION, strictSdrCandidateTerminalBinding(opened).outputPath,
              );
              if (!binding) throw new Error("expected private renderer binding");
              consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
              captureCurrentStrictSdrCandidateThreeSlotFrame(route, frame);
              expect(transferCurrentStrictSdrCandidateThreeSlotLease(leaseOwner(frame, fresh.signal, (fd) => { sourceFd = fd; }, () => { closeCalls += 1; }), {
                binding: binding!, preparation: PREPARATION, governor: governor(fresh.signal, caller.signal), scratchRoot: root, signal: caller.signal, callerId: "three-slot-test",
              })).toBe(true);
              const media = Buffer.from("three-slot committed media", "utf8");
              const mediaEvidence = await strictSdrCandidateOutputPublication(opened).writePrivateFile(media, { label: "three-slot committed media", maxBytes: 256 * 1024 * 1024 });
              await recordStrictSdrCandidateHeldMediaStage(binding!, strictSdrCandidateOutputPublication(opened));
              await stageStrictSdrCandidateFinalReceipt(opened, receipt(strictSdrCandidateOutputPublication(opened).stagingPath, mediaEvidence.sha256, mediaEvidence.byteLength), mediaEvidence);
            });
            await commitStrictSdrCandidateHeldPair(opened);
            measurement = await consumeStrictSdrCandidateHeldPair(opened, async (observation) => await evaluateStrictSdrCandidateThreeSlotF2aHeldPair(opened, observation));
            pair = undefined;
            expect(sourceFd).toBeGreaterThan(2);
            expect(measurement).toBeDefined();
            expect(measurement).toMatchObject({ schema: "shellx-motion/strict-sdr-candidate-three-slot-f2a-measurement@1", sourceFrame: { sha256: frame.rgba8SrgbSha256 } });
            expect(measurement).not.toHaveProperty("accepted");
            expect(closeCalls).toBe(1);
          });
        });
        expect(completedPair).toBeDefined();
        expect(strictSdrCandidateThreeSlotF2aFinalization(completedPair!)).toMatchObject({ state: "complete", heldToolDescriptorsRetained: true, privateRootClosed: true });
        const screen = await runCommittedLiteralSlot(anchor, root, tools, "f2b-screen", caller, fresh);
        const controls = await runCommittedLiteralSlot(anchor, root, tools, "f2b-screen-controls", caller, fresh);
        expect(screen.measurement).toMatchObject({ schema: "shellx-motion/strict-sdr-candidate-f2b-screen-three-slot-measurement@1" });
        expect(screen.measurement).not.toHaveProperty("accepted");
        expect(controls.measurement).toMatchObject({ schema: "shellx-motion/strict-sdr-candidate-f2b-screen-controls-three-slot-measurement@1" });
        const samples = "samples" in controls.measurement ? controls.measurement.samples : undefined;
        expect(samples).toMatchObject([
          { name: "screen-saturated-overlays", x: 240, y: 356, sourceRgba8: [128, 128, 128, 255], decodedRgba8: [128, 128, 128, 255] },
          { name: "screen-partial-alpha-control", x: 640, y: 356, sourceRgba8: [128, 128, 128, 255], decodedRgba8: [128, 128, 128, 255] },
          { name: "transparent-screen-zero-alpha-control", x: 1040, y: 356, sourceRgba8: [128, 128, 128, 255], decodedRgba8: [128, 128, 128, 255] },
        ]);
        expect(controls.measurement).not.toHaveProperty("accepted");
        expect(strictSdrCandidateF2bScreenThreeSlotFinalization(screen.pair)).toMatchObject({ state: "complete", heldToolDescriptorsRetained: true });
        expect(strictSdrCandidateF2bScreenControlsThreeSlotFinalization(controls.pair)).toMatchObject({ state: "complete", heldToolDescriptorsRetained: true });
      });
      await closeOwnedToolsExpecting(tools, "complete");
    } finally {
      if (pair) await abortStrictSdrCandidateHeldPair(pair);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seals the fixed frame-zero whole and literal crop tuples during each serial Core pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-frame0-"));
    const tools = await owner(), caller = new AbortController(), fresh = new AbortController();
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        const f2a = await runFramedCommittedLiteralSlot(anchor, root, tools, "f2a", caller, fresh);
        const screen = await runFramedCommittedLiteralSlot(anchor, root, tools, "f2b-screen", caller, fresh);
        const controls = await runFramedCommittedLiteralSlot(anchor, root, tools, "f2b-screen-controls", caller, fresh);
        expect(f2a.pack).toMatchObject({ slot: "f2a", frameIndex: 0, descriptorsClosed: true, pairFinalization: { state: "complete", heldToolDescriptorsRetained: true } });
        expect(Object.isFrozen(f2a.pack.evidence.inverseJob)).toBe(true);
        expect(Object.isFrozen(f2a.pack.evidence.inverseJob.policy)).toBe(true);
        expect(Object.isFrozen(f2a.pack.evidence.inverseJob.scratch)).toBe(true);
        expect(f2a.pack.evidence.inverseJob).toEqual(f2a.measurement.inverseJob);
        expect(screen.pack.evidence.inverseJob).toEqual(screen.measurement.inverseJob);
        expect(controls.pack.evidence.inverseJob).toEqual(controls.measurement.inverseJob);
        expect(f2a.pack.images.map((image) => image.name)).toEqual(["sourceWhole", "decodedWhole", "sourceLinearBlackWhite", "decodedLinearBlackWhite", "sourceRadialThreeStop", "decodedRadialThreeStop"]);
        expect(screen.pack.images.map((image) => [image.name, image.x, image.y, image.width, image.height])).toEqual([
          ["sourceWhole", 0, 0, 1280, 720], ["decodedWhole", 0, 0, 1280, 720],
          ["sourceNormal", 700, 156, 420, 408], ["decodedNormal", 700, 156, 420, 408],
          ["sourceRadial", 760, 216, 280, 288], ["decodedRadial", 760, 216, 280, 288],
          ["sourceLeftOverlap", 360, 236, 220, 248], ["decodedLeftOverlap", 360, 236, 220, 248],
        ]);
        expect(controls.pack.images.map((image) => [image.name, image.x, image.y, image.width, image.height])).toEqual([
          ["sourceWhole", 0, 0, 1280, 720], ["decodedWhole", 0, 0, 1280, 720],
          ["sourceSaturatedOverlays", 64, 180, 352, 352], ["decodedSaturatedOverlays", 64, 180, 352, 352],
          ["sourcePartialAlpha", 464, 180, 352, 352], ["decodedPartialAlpha", 464, 180, 352, 352],
          ["sourceTransparentZeroAlpha", 864, 180, 352, 352], ["decodedTransparentZeroAlpha", 864, 180, 352, 352],
        ]);
        expect(screen.measurement).not.toHaveProperty("accepted");
        expect(controls.measurement).not.toHaveProperty("accepted");
      });
      await closeOwnedToolsExpecting(tools, "complete");
    } finally {
      await closeOwnedToolsAfterFailure(tools);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seals all sixty natural-EOF frame observations in literal F2a, screen, and controls order", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-temporal-"));
    const tools = await owner(), caller = new AbortController(), fresh = new AbortController();
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        const f2a = await runTemporalCommittedLiteralSlot(anchor, root, tools, "f2a", caller, fresh);
        const screen = await runTemporalCommittedLiteralSlot(anchor, root, tools, "f2b-screen", caller, fresh);
        const controls = await runTemporalCommittedLiteralSlot(anchor, root, tools, "f2b-screen-controls", caller, fresh);
        expect([f2a, screen, controls].map((value) => [value.slot, value.frames.length, value.decodedByteLength]))
          .toEqual([["f2a", 60, 221_184_000], ["f2b-screen", 60, 221_184_000], ["f2b-screen-controls", 60, 221_184_000]]);
        expect(f2a.frames.every((frame, index) => frame.frameIndex === index && frame.samples === undefined)).toBe(true);
        expect(screen.frames.every((frame) => frame.samples === undefined)).toBe(true);
        expect(controls.frames.every((frame) => frame.samples?.map((sample) => sample.name))).toEqual(true);
        expect([f2a, screen, controls].map((value) => value.inverseJob.operation)).toEqual([
          "ffmpeg.strict-sdr-candidate-three-slot-f2a-all-delivered-frame-inverse",
          "ffmpeg.strict-sdr-candidate-three-slot-f2b-screen-all-delivered-frame-inverse",
          "ffmpeg.strict-sdr-candidate-three-slot-f2b-screen-controls-all-delivered-frame-inverse",
        ]);
      });
      await closeOwnedToolsExpecting(tools, "complete");
    } finally {
      await closeOwnedToolsAfterFailure(tools);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains failed-settling tools when a resolved pair escapes before its deferred consumer finalizes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-deferred-"));
    const tools = await owner(), route = routeFor("f2a"), frame = frameFor(route), caller = new AbortController(), fresh = new AbortController();
    let workspace: StrictSdrCandidateHeldWorkspace | undefined;
    let pair: StrictSdrCandidateHeldPair | undefined;
    let completedPair: StrictSdrCandidateHeldPair | undefined;
    const entered = deferred<void>(), release = deferred<void>();
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
        await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
          pair = await openStrictSdrCandidateHeldPair(workspace!);
          const opened = pair;
          completedPair = opened;
          await expect(withStrictSdrCandidateThreeSlotF2aEvaluation(tools, PREPARATION, async () => {
            await withStrictSdrCandidateHeldPairRendering(opened, PREPARATION, async () => {
              const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(
                strictSdrCandidateOutputPublication(opened), PREPARATION, strictSdrCandidateTerminalBinding(opened).outputPath,
              );
              if (!binding) throw new Error("expected private renderer binding");
              consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
              captureCurrentStrictSdrCandidateThreeSlotFrame(route, frame);
              expect(transferCurrentStrictSdrCandidateThreeSlotLease(leaseOwner(frame, fresh.signal, () => undefined, () => undefined), {
                binding, preparation: PREPARATION, governor: governor(fresh.signal, caller.signal), scratchRoot: root, signal: caller.signal, callerId: "three-slot-deferred",
              })).toBe(true);
              const media = Buffer.from("three-slot deferred committed media", "utf8");
              const mediaEvidence = await strictSdrCandidateOutputPublication(opened).writePrivateFile(media, { label: "three-slot deferred committed media", maxBytes: 256 * 1024 * 1024 });
              await recordStrictSdrCandidateHeldMediaStage(binding, strictSdrCandidateOutputPublication(opened));
              await stageStrictSdrCandidateFinalReceipt(opened, receipt(strictSdrCandidateOutputPublication(opened).stagingPath, mediaEvidence.sha256, mediaEvidence.byteLength), mediaEvidence);
            });
          })).rejects.toThrow(/before its Core pair finalizer completed/i);
          await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).rejects.toThrow(/current pair fully settles/i);

          await commitStrictSdrCandidateHeldPair(opened);
          const pending = consumeStrictSdrCandidateHeldPair(opened, async (observation) => {
            entered.resolve(undefined);
            await release.promise;
            return await evaluateStrictSdrCandidateThreeSlotF2aHeldPair(opened, observation);
          });
          await entered.promise;
          await expect(borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools)).rejects.toThrow(/out-of-order|failed/i);
          await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).rejects.toThrow(/current pair fully settles/i);
          release.resolve(undefined);
          await expect(pending).resolves.toMatchObject({ schema: "shellx-motion/strict-sdr-candidate-three-slot-f2a-measurement@1" });
          pair = undefined;
          expect(() => strictSdrCandidateThreeSlotF2aFinalization(completedPair!)).toThrow(/finalization is absent/i);
          await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).rejects.toThrow(/current pair fully settles/i);
        });
      });
    } finally {
      release.resolve(undefined);
      if (pair) await abortStrictSdrCandidateHeldPair(pair).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures only the literal F2a route once and latches the owner when no pair lease transfers", async () => {
    const tools = await owner();
    const route = routeFor("f2a"), frame = frameFor(route);
    await expect(withStrictSdrCandidateThreeSlotF2aEvaluation(tools, PREPARATION, async () => {
      captureCurrentStrictSdrCandidateThreeSlotFrame(route, frame);
      expect(() => captureCurrentStrictSdrCandidateThreeSlotFrame(route, frame)).toThrow(/duplicated/i);
      await expect(withStrictSdrCandidateF2bScreenThreeSlotEvaluation(tools, PREPARATION, async () => undefined)).rejects.toThrow(/nonnestable/i);
    })).rejects.toThrow(/literal pair lease/i);
    await expect(withStrictSdrCandidateF2bScreenThreeSlotEvaluation(tools, PREPARATION, async () => undefined)).rejects.toThrow(/out-of-order|failed/i);
    await closeOwnedToolsExpecting(tools, "closed-after-refusal");
  });

  it("refuses a screen route in the literal F2a scope before a frame copy survives", async () => {
    const tools = await owner();
    const screen = routeFor("screen");
    await expect(withStrictSdrCandidateThreeSlotF2aEvaluation(tools, PREPARATION, async () => {
      captureCurrentStrictSdrCandidateThreeSlotFrame(screen, frameFor(screen));
    })).rejects.toThrow(/literal admitted route/i);
    await closeOwnedToolsExpecting(tools, "closed-after-refusal");
  });

  it("refuses a pack initializer that has no live matching pack scope before consuming its Core binding", () => {
    expect(() => initializeCurrentStrictSdrCandidateFrame0Pack("f2a", {} as StrictSdrCandidateHeldPairRendererBinding, PREPARATION, undefined))
      .toThrow(/active literal Core transfer/i);
  });

  it("refuses an unexpected descriptor-relative root entry before a pack can transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-frame0-entry-"));
    try {
      const allocation = await frame0Allocation(root, "f2a");
      const extra = await open(join(allocation.root.path, "unexpected.png"), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
      await extra.close();
      await expect(withTemporalScope("f2a", async () => await withFrame0Scope("f2a", allocation, async () => undefined))).rejects.toThrow(/entry set/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("latches a settled refusal when a post-inverse consumer throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-three-slot-consumer-failure-"));
    const tools = await owner(), caller = new AbortController(), fresh = new AbortController();
    let pair: StrictSdrCandidateHeldPair | undefined;
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        await runCommittedLiteralSlot(anchor, root, tools, "f2a", caller, fresh);
        const allocation = await frame0Allocation(root, "f2b-screen");
        await expect(withTemporalScope("f2b-screen", async () => await withFrame0Scope("f2b-screen", allocation, async () => await runCommittedLiteralSlot(anchor, root, tools, "f2b-screen", caller, fresh, (opened) => { pair = opened; }, true, true))))
          .rejects.toThrow(/synthetic post-inverse consumer failure/i);
      });
      await expect(borrowStrictSdrCandidateF2bScreenThreeSlotTools(tools)).rejects.toThrow(/out-of-order|failed/i);
      await expect(borrowStrictSdrCandidateF2bScreenControlsThreeSlotTools(tools)).rejects.toThrow(/out-of-order|failed/i);
      expect(() => strictSdrCandidateF2bScreenThreeSlotFinalization(pair!)).toThrow(/finalization is absent/i);
      await closeOwnedToolsExpecting(tools, "closed-after-refusal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runFramedCommittedLiteralSlot(
  anchor: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>,
  root: string,
  tools: StrictSdrCandidateThreeSlotHeldTools,
  slot: LiteralSlot,
  caller: AbortController,
  fresh: AbortController,
): Promise<Readonly<{ pair: StrictSdrCandidateHeldPair; measurement: LiteralMeasurement; pack: StrictSdrCandidateFrame0PackSealed }>> {
  const allocation = await frame0Allocation(root, slot);
  let pack: StrictSdrCandidateFrame0PackSealed | undefined;
  const completed = await withTemporalScope(slot, async () => await withFrame0Scope(slot, allocation, async () => {
    const result = await runCommittedLiteralSlot(anchor, root, tools, slot, caller, fresh, () => undefined, false, true);
    pack = readFrame0Pack(slot, result.pair);
    readTemporalObservation(slot, result.pair);
    return result;
  }));
  if (!pack) throw new Error("expected sealed literal frame-zero review pack");
  return Object.freeze({ ...completed, pack });
}

async function runTemporalCommittedLiteralSlot(
  anchor: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>,
  root: string,
  tools: StrictSdrCandidateThreeSlotHeldTools,
  slot: LiteralSlot,
  caller: AbortController,
  fresh: AbortController,
) {
  const allocation = await frame0Allocation(root, slot);
  return await withTemporalScope(slot, async () => await withFrame0Scope(slot, allocation, async () => {
    const completed = await runCommittedLiteralSlot(anchor, root, tools, slot, caller, fresh, () => undefined, false, true);
    const temporal = readTemporalObservation(slot, completed.pair);
    readFrame0Pack(slot, completed.pair);
    return temporal;
  }));
}

async function runCommittedLiteralSlot(
  anchor: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>,
  root: string,
  tools: StrictSdrCandidateThreeSlotHeldTools,
  slot: LiteralSlot,
  caller: AbortController,
  fresh: AbortController,
  onPair: (pair: StrictSdrCandidateHeldPair) => void = () => undefined,
  throwAfterMeasurement = false,
  temporal = false,
): Promise<Readonly<{ pair: StrictSdrCandidateHeldPair; measurement: LiteralMeasurement }>> {
  const route = routeFor(slot === "f2a" ? "f2a" : slot === "f2b-screen" ? "screen" : "controls"), frame = frameFor(route);
  let pair: StrictSdrCandidateHeldPair | undefined;
  let measurement: LiteralMeasurement | undefined;
  await withLiteralScope(slot, tools, async () => {
    const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
    await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
      const opened = await openStrictSdrCandidateHeldPair(workspace);
      pair = opened;
      onPair(opened);
      await withStrictSdrCandidateHeldPairRendering(opened, PREPARATION, async () => {
        const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(
          strictSdrCandidateOutputPublication(opened), PREPARATION, strictSdrCandidateTerminalBinding(opened).outputPath,
        );
        if (!binding) throw new Error("expected private renderer binding");
        consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
        captureCurrentStrictSdrCandidateThreeSlotFrame(route, frame);
        expect(transferCurrentStrictSdrCandidateThreeSlotLease(leaseOwner(frame, fresh.signal, () => undefined, () => undefined), {
          binding, preparation: PREPARATION, governor: governor(fresh.signal, caller.signal, `ffmpeg.strict-sdr-candidate-three-slot-${slot}-${temporal ? "all-delivered-frame-" : ""}inverse`), scratchRoot: root, signal: caller.signal, callerId: `three-slot-${slot}`,
        })).toBe(true);
        const media = Buffer.from(`three-slot ${slot} committed media`, "utf8");
        const mediaEvidence = await strictSdrCandidateOutputPublication(opened).writePrivateFile(media, {
          label: `three-slot ${slot} committed media`, maxBytes: 256 * 1024 * 1024,
        });
        await recordStrictSdrCandidateHeldMediaStage(binding, strictSdrCandidateOutputPublication(opened));
        await stageStrictSdrCandidateFinalReceipt(opened, receipt(strictSdrCandidateOutputPublication(opened).stagingPath, mediaEvidence.sha256, mediaEvidence.byteLength), mediaEvidence);
      });
      await commitStrictSdrCandidateHeldPair(opened);
      measurement = await consumeStrictSdrCandidateHeldPair(opened, async (observation) => {
        const evaluated = await evaluateLiteralSlot(slot, opened, observation);
        if (throwAfterMeasurement) throw new Error("synthetic post-inverse consumer failure");
        return evaluated;
      });
    });
  });
  if (!pair || !measurement) throw new Error("expected committed literal three-slot result");
  return Object.freeze({ pair, measurement });
}

async function withLiteralScope<T>(slot: LiteralSlot, tools: StrictSdrCandidateThreeSlotHeldTools, operation: () => Promise<T>): Promise<T> {
  return slot === "f2a"
    ? await withStrictSdrCandidateThreeSlotF2aEvaluation(tools, PREPARATION, operation)
    : slot === "f2b-screen"
    ? await withStrictSdrCandidateF2bScreenThreeSlotEvaluation(tools, PREPARATION, operation)
    : await withStrictSdrCandidateF2bScreenControlsThreeSlotEvaluation(tools, PREPARATION, operation);
}

function withFrame0Scope<T>(slot: LiteralSlot, allocation: StrictSdrCandidateFrame0PackAllocation, operation: () => Promise<T>): Promise<T> {
  if (slot === "f2a") return withStrictSdrCandidateThreeSlotF2aFrame0Pack(allocation as Parameters<typeof withStrictSdrCandidateThreeSlotF2aFrame0Pack>[0], PREPARATION, operation);
  if (slot === "f2b-screen") return withStrictSdrCandidateF2bScreenFrame0Pack(allocation as Parameters<typeof withStrictSdrCandidateF2bScreenFrame0Pack>[0], PREPARATION, operation);
  return withStrictSdrCandidateF2bScreenControlsFrame0Pack(allocation as Parameters<typeof withStrictSdrCandidateF2bScreenControlsFrame0Pack>[0], PREPARATION, operation);
}
async function withTemporalScope<T>(slot: LiteralSlot, operation: () => Promise<T>): Promise<T> {
  return slot === "f2a"
    ? await withStrictSdrCandidateThreeSlotF2aAllDeliveredFrameObservation(TEMPORAL_BINDING, PREPARATION, operation)
    : slot === "f2b-screen"
      ? await withStrictSdrCandidateF2bScreenAllDeliveredFrameObservation(TEMPORAL_BINDING, PREPARATION, operation)
      : await withStrictSdrCandidateF2bScreenControlsAllDeliveredFrameObservation(TEMPORAL_BINDING, PREPARATION, operation);
}
function readTemporalObservation(slot: LiteralSlot, pair: StrictSdrCandidateHeldPair) {
  return slot === "f2a" ? readStrictSdrCandidateThreeSlotF2aAllDeliveredFrameObservation(pair)
    : slot === "f2b-screen" ? readStrictSdrCandidateF2bScreenAllDeliveredFrameObservation(pair)
      : readStrictSdrCandidateF2bScreenControlsAllDeliveredFrameObservation(pair);
}
function readFrame0Pack(slot: LiteralSlot, pair: StrictSdrCandidateHeldPair): StrictSdrCandidateFrame0PackSealed {
  return slot === "f2a" ? readStrictSdrCandidateThreeSlotF2aFrame0Pack(pair)
    : slot === "f2b-screen" ? readStrictSdrCandidateF2bScreenFrame0Pack(pair)
      : readStrictSdrCandidateF2bScreenControlsFrame0Pack(pair);
}
async function frame0Allocation(root: string, slot: StrictSdrCandidateFrame0PackSlot): Promise<StrictSdrCandidateFrame0PackAllocation> {
  const directory = join(root, `frame0-${slot}`);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const leaves: Record<string, HeldLeaf> = {};
  try {
    for (const name of strictSdrCandidateFrame0PackLeafNames(slot)) {
      const path = join(directory, `${name}.png`);
      const leafHandle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
      await leafHandle.chmod(0o600);
      leaves[name] = Object.freeze({ path, handle: leafHandle, identity: heldFacts(await leafHandle.stat()) });
    }
    return Object.freeze({ root: Object.freeze({ path: directory, handle, identity: heldFacts(await handle.stat()) }), leaves: Object.freeze(leaves) }) as StrictSdrCandidateFrame0PackAllocation;
  } catch (error) {
    for (const leaf of Object.values(leaves)) await leaf.handle.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    throw error;
  }
}
function heldFacts(stat: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }>): HeldFileFacts {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, nlink: stat.nlink });
}

async function evaluateLiteralSlot(slot: LiteralSlot, pair: StrictSdrCandidateHeldPair, observation: StrictSdrCandidateHeldPairObservation): Promise<LiteralMeasurement> {
  return slot === "f2a"
    ? await evaluateStrictSdrCandidateThreeSlotF2aHeldPair(pair, observation)
    : slot === "f2b-screen"
    ? await evaluateStrictSdrCandidateF2bScreenThreeSlotHeldPair(pair, observation)
    : await evaluateStrictSdrCandidateF2bScreenControlsThreeSlotHeldPair(pair, observation);
}

async function owner(): Promise<StrictSdrCandidateThreeSlotHeldTools> {
  process.env.SHELLX_MOTION_FFMPEG = process.execPath;
  process.env.SHELLX_MOTION_FFPROBE = process.execPath;
  const tools = await openStrictSdrCandidateThreeSlotHeldTools();
  owners.push(tools);
  return tools;
}

async function closeOwnedToolsExpecting(tools: StrictSdrCandidateThreeSlotHeldTools, state: "complete" | "closed-after-refusal"): Promise<void> {
  await expect(closeStrictSdrCandidateThreeSlotHeldTools(tools)).resolves.toMatchObject({ state }); owners.pop();
}

async function closeOwnedToolsAfterFailure(tools: StrictSdrCandidateThreeSlotHeldTools): Promise<void> {
  const index = owners.indexOf(tools);
  if (index < 0) return;
  owners.splice(index, 1);
  try { markStrictSdrCandidateThreeSlotF2aToolsFailure(tools); settleStrictSdrCandidateThreeSlotF2aTools(tools, false); } catch { /* already terminal */ }
  await closeStrictSdrCandidateThreeSlotHeldTools(tools).catch(() => undefined);
}

function routeFor(kind: "f2a" | "screen" | "controls"): LinearSrgbSdrFinalRoute {
  const resolved = resolveLinearSrgbSdrFinalRoute({
    schema: "shellx-motion/motion@1", id: `three-slot-${kind}`, name: `Three slot ${kind}`, width: 1280, height: 720, durationMs: 2000, fps: 30, background: "#101820",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "three-slot-test" },
    layers: kind === "f2a"
      ? [{ id: "gradient", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 2000, gradient: { type: "linear" as const, angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 0, y: 0, width: 1280, height: 720 } }]
      : kind === "screen" ? [
          { id: "gradient", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 2000, gradient: { type: "linear" as const, angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 0, y: 0, width: 1280, height: 720 } },
          { id: "screen", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 2000, fill: "#ff0040", opacity: 0.4, blendMode: "screen" as const, transform: { x: 0, y: 0, width: 1280, height: 720 } },
        ] : [
          { id: "base", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 2000, fill: "#101820", transform: { x: 0, y: 0, width: 1280, height: 720 } },
          { id: "screen", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 2000, fill: "#ff0040", opacity: 0.4, blendMode: "screen" as const, transform: { x: 0, y: 0, width: 1280, height: 720 } },
        ],
  }, { target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function frameFor(route: LinearSrgbSdrFinalRoute): LinearSrgbSdrFinalWebGpuFrame {
  const rgba8Srgb = Buffer.alloc(route.canvas.width * route.canvas.height * 4, 128);
  for (let offset = 3; offset < rgba8Srgb.byteLength; offset += 4) rgba8Srgb[offset] = 255;
  return Object.freeze({ schema: "shellx-motion/linear-srgb-sdr-final-webgpu-frame@1", routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, width: route.canvas.width, height: route.canvas.height, bytesPerRow: route.canvas.width * 4, rgba8SrgbSha256: createHash("sha256").update(rgba8Srgb).digest("hex"), rgba8Srgb });
}

function leaseOwner(
  frame: LinearSrgbSdrFinalWebGpuFrame,
  freshSignal: AbortSignal,
  observed: (fd: number) => void,
  closed: () => void,
): StrictSdrCandidateThreeSlotLeaseOwner {
  return Object.freeze({
    async runThreeSlotInverse(input) {
      observed(input.sourceFd);
      expect(input.job.signal).toBe(freshSignal);
      input.job.reportProcessContainment(portableFfmpegContainmentEvidence("unix-process-group"));
      return Object.freeze({ decoded: Object.freeze({ sha256: frame.rgba8SrgbSha256, byteLength: frame.rgba8Srgb.byteLength }), measurement: await input.measureDecoded(Buffer.from(frame.rgba8Srgb)), inverseCommandSha256: "d".repeat(64) });
    },
    async runThreeSlotAllDeliveredFrames(input) {
      observed(input.sourceFd);
      expect(input.job.signal).toBe(freshSignal);
      input.job.reportProcessContainment(portableFfmpegContainmentEvidence("unix-process-group"));
      const frames = [];
      for (let frameIndex = 0; frameIndex < 60; frameIndex += 1) {
        frames.push(await input.observeFrame({
          frame: Object.freeze({ frameIndex, decoded: Object.freeze({ sha256: frame.rgba8SrgbSha256, byteLength: frame.rgba8Srgb.byteLength }) }),
          withOwnedRgba: async (operation) => {
            const borrowed = Buffer.from(frame.rgba8Srgb);
            try { return await operation(borrowed); } finally { borrowed.fill(0); }
          },
        }));
      }
      return Object.freeze({ frames: Object.freeze(frames), heldFfmpeg: Object.freeze({ sha256: "e".repeat(64) }), inverseCommandSha256: "d".repeat(64), decodedByteLength: 221_184_000 });
    },
    async close() { closed(); },
  });
}

function governor(signal: AbortSignal, originalCallerSignal: AbortSignal, expectedOperation = "ffmpeg.strict-sdr-candidate-three-slot-f2a-inverse"): LocalMotionJobGovernor {
  const evidence: LocalMotionJobEvidence = { schema: "shellx-motion/local-job-resources@1", jobId: "three-slot-fresh", lane: "ffmpeg", operation: "ffmpeg.strict-sdr-candidate-three-slot-f2a-inverse", state: "passed", queueWaitMs: 0, durationMs: 1, policy: { maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 1_000, maxWallClockMs: 1_000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 256 * 1024 * 1024, rssPollIntervalMs: 1_000 }, scratch: { pathSafety: "canonical-no-symlink", freeBytesAtStart: 1_000_000_000, reservedBytes: 0, minFreeBytes: 0 }, peakProcessTreeRssBytes: 0, watchedProcessCount: 0, rssScope: "unavailable" };
  return {
    policy: evidence.policy,
    async run<T>(request: Record<string, unknown>, operation: (context: LocalMotionJobContext) => Promise<T>) {
      expect(request.signal).toBe(originalCallerSignal);
      expect(request.operation).toBe(expectedOperation);
      const actualEvidence = Object.freeze({ ...evidence, operation: expectedOperation });
      return { value: await operation({ jobId: evidence.jobId, signal, scratchRoot: request.scratchRoot as string, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} }), evidence: actualEvidence };
    },
  } as unknown as LocalMotionJobGovernor;
}

function receipt(path: string, sha256: string, byteLength: number): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "three-slot-evaluator", operation: "render.final", status: "passed", packageId: "pkg_three_slot", createdAt: "2026-09-08T00:00:00.000Z", lane: "ffmpeg",
    inputHashes: { motion: "b".repeat(64), "linear-srgb-sdr-route": "c".repeat(64), "linear-srgb-sdr-preparation": PREPARATION, "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64), "linear-srgb-sdr-webgpu-producer": "e".repeat(64), "linear-srgb-sdr-producer-frame": "f".repeat(64), "linear-srgb-sdr-comparison-policy": "0".repeat(64), "linear-srgb-sdr-execution": "1".repeat(64) },
    output: { path, sha256, byteLength, frameTransport: { schema: "shellx-motion/linear-srgb-sdr-final-transport@2", privateOutputAdoption: { schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1", verifiedOutput: { sha256, byteLength }, privatePublicationStage: { sha256, byteLength } } } }, warnings: [],
  };
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T | PromiseLike<T>): void }> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resume) => { resolve = resume; });
  return Object.freeze({ promise, resolve });
}
