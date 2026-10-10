import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  type StrictSdrCandidateHeldPairRendererBinding,
  type StrictSdrCandidateHeldWorkspace,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import { compareLinearSrgbSdrFinalFrames } from "./linear-srgb-sdr-final-compare.js";
import { portableFfmpegContainmentEvidence } from "./ffmpeg-process-control.js";
import {
  captureCurrentStrictSdrCandidateF2aFrame,
  evaluateStrictSdrCandidateF2aHeldPair,
  strictSdrCandidateF2aFinalization,
  transferCurrentStrictSdrCandidateF2aLease,
  withStrictSdrCandidateF2aEvaluation,
  type StrictSdrCandidateF2aLeaseOwner,
} from "./linear-srgb-sdr-final-f2a-evaluator.js";

const PREPARATION = "a".repeat(64);

describe("candidate-local strict-SDR evaluator", () => {
  it.skipIf(process.platform !== "linux")("retains only the exact consumed binding, uses Core FD4, and finalizes after the fresh inverse", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-f2a-evaluator-"));
    const route = f2aRoute(), frame = f2aFrame(route), caller = new AbortController();
    const fresh = new AbortController();
    let workspace: StrictSdrCandidateHeldWorkspace | undefined;
    let pair: StrictSdrCandidateHeldPair | undefined;
    let binding: StrictSdrCandidateHeldPairRendererBinding | undefined;
    let closeCalls = 0, sourceFd = -1, request: Record<string, unknown> | undefined;
    const containment: unknown[] = [];
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
        await withStrictSdrCandidateHeldWorkspace(workspace, PREPARATION, async () => {
          pair = await openStrictSdrCandidateHeldPair(workspace!);
          const openedPair = pair;
          try {
            await withStrictSdrCandidateHeldPairRendering(openedPair, PREPARATION, async () => {
              binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(
                strictSdrCandidateOutputPublication(openedPair), PREPARATION, strictSdrCandidateTerminalBinding(openedPair).outputPath,
              );
              if (!binding) throw new Error("expected Core renderer binding");
              consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
              await withStrictSdrCandidateF2aEvaluation(PREPARATION, async () => {
                const snapshot = captureCurrentStrictSdrCandidateF2aFrame(route, frame);
                if (!snapshot) throw new Error("expected captured F2a frame snapshot");
                expect(transferCurrentStrictSdrCandidateF2aLease(snapshot, owner(frame, () => { closeCalls += 1; }, (fd) => { sourceFd = fd; }, fresh.signal), {
                  binding: binding!, preparation: PREPARATION, governor: freshGovernor(fresh.signal, (value) => { request = value; }, (evidence) => containment.push(evidence)), scratchRoot: root, signal: caller.signal, callerId: "candidate-f2a",
                })).toBe(true);
              });
              const media = Buffer.from("strict SDR candidate F2a evaluator media", "utf8");
              const mediaEvidence = await strictSdrCandidateOutputPublication(openedPair).writePrivateFile(media, {
                label: "strict SDR candidate F2a evaluator media", maxBytes: 256 * 1024 * 1024,
              });
              await recordStrictSdrCandidateHeldMediaStage(binding, strictSdrCandidateOutputPublication(openedPair));
              await stageStrictSdrCandidateFinalReceipt(
                openedPair,
                strictReceipt(strictSdrCandidateOutputPublication(openedPair).stagingPath, mediaEvidence.sha256, mediaEvidence.byteLength),
                mediaEvidence,
              );
            });
            await expect(evaluateStrictSdrCandidateF2aHeldPair(openedPair, {
              media: { sha256: "b".repeat(64), byteLength: 17 }, receipt: { sha256: "c".repeat(64), byteLength: 19 },
              async withF2aCommittedMediaDescriptor(operation) { return await operation({ fd: 4, media: { sha256: "b".repeat(64), byteLength: 17 } }); },
              async withThreeSlotF2aCommittedMediaDescriptor(_operation) { throw new Error("unexpected three-slot F2a descriptor request"); },
              async withF2bScreenCommittedMediaDescriptor(_operation) { throw new Error("unexpected F2b screen descriptor request"); },
              async withF2bScreenControlsCommittedMediaDescriptor(_operation) { throw new Error("unexpected F2b screen controls descriptor request"); },
              async hashMedia() { return { sha256: "b".repeat(64), byteLength: 17 }; }, async readReceipt() { return Buffer.from("{}", "utf8"); },
              async verifyCurrentPair() { throw new Error("unexpected fresh pair verification"); },
            })).rejects.toThrow(/exact active pair observation/i);
            await commitStrictSdrCandidateHeldPair(openedPair);
            expect(() => strictSdrCandidateF2aFinalization(openedPair)).toThrow(/absent/i);
            const measurement = await consumeStrictSdrCandidateHeldPair(
              openedPair,
              async (observation) => await evaluateStrictSdrCandidateF2aHeldPair(openedPair, observation),
            ).finally(() => { pair = undefined; });
            expect(sourceFd).toBeGreaterThan(2);
            expect(measurement).toMatchObject({ schema: "shellx-motion/strict-sdr-candidate-f2a-measurement@1", sourceFrame: { sha256: frame.rgba8SrgbSha256 }, comparison: { accepted: true } });
            expect(request).toMatchObject({ lane: "ffmpeg", operation: "ffmpeg.strict-sdr-candidate-f2a-inverse", scratchRoot: root, signal: caller.signal, callerId: "candidate-f2a" });
            expect(request).not.toHaveProperty("jobId");
            expect(containment).toEqual([portableFfmpegContainmentEvidence("unix-process-group")]);
            expect(closeCalls).toBe(1);
            expect(strictSdrCandidateF2aFinalization(openedPair)).toMatchObject({ state: "complete", sourceFrameReleased: true, heldToolDescriptorsClosed: true, privateRootClosed: true });
          } finally {
            if (pair) {
              await abortStrictSdrCandidateHeldPair(pair);
              pair = undefined;
            }
          }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses nested scope and leaves ordinary rendering with no retained F2a snapshot", async () => {
    const route = f2aRoute(), frame = f2aFrame(route);
    expect(captureCurrentStrictSdrCandidateF2aFrame(route, frame)).toBeUndefined();
    expect(transferCurrentStrictSdrCandidateF2aLease(undefined, {} as StrictSdrCandidateF2aLeaseOwner, {} as never)).toBe(false);
    await withStrictSdrCandidateF2aEvaluation(PREPARATION, async () => {
      await expect(withStrictSdrCandidateF2aEvaluation(PREPARATION, async () => undefined)).rejects.toThrow(/nonnestable/i);
      expect(captureCurrentStrictSdrCandidateF2aFrame(route, frame)).toBeDefined();
    });
  });
});

function f2aRoute(): LinearSrgbSdrFinalRoute {
  const resolved = resolveLinearSrgbSdrFinalRoute({
    schema: "shellx-motion/motion@1", id: "f2a-evaluator", name: "F2a evaluator", width: 1280, height: 720, durationMs: 2000, fps: 30, background: "#101820",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "f2a-evaluator-test" },
    layers: [{ id: "gradient", type: "shape", shape: "rect", startMs: 0, durationMs: 2000, gradient: { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 0, y: 0, width: 1280, height: 720 } }],
  }, { target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function f2aFrame(route: LinearSrgbSdrFinalRoute): LinearSrgbSdrFinalWebGpuFrame {
  const rgba8Srgb = Buffer.alloc(route.canvas.width * route.canvas.height * 4, 128);
  for (let offset = 3; offset < rgba8Srgb.byteLength; offset += 4) rgba8Srgb[offset] = 255;
  return Object.freeze({ schema: "shellx-motion/linear-srgb-sdr-final-webgpu-frame@1", routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, width: route.canvas.width, height: route.canvas.height, bytesPerRow: route.canvas.width * 4, rgba8SrgbSha256: sha256(rgba8Srgb), rgba8Srgb });
}

function strictReceipt(path: string, sha256: string, byteLength: number): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "strict-sdr-f2a-evaluator", operation: "render.final", status: "passed", packageId: "pkg_strict_sdr_f2a",
    inputHashes: {
      motion: "b".repeat(64), "linear-srgb-sdr-route": "c".repeat(64), "linear-srgb-sdr-preparation": PREPARATION,
      "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64), "linear-srgb-sdr-webgpu-producer": "e".repeat(64),
      "linear-srgb-sdr-producer-frame": "f".repeat(64), "linear-srgb-sdr-comparison-policy": "0".repeat(64), "linear-srgb-sdr-execution": "1".repeat(64),
    },
    createdAt: "2026-09-08T00:00:00.000Z", lane: "ffmpeg",
    output: {
      path, sha256, byteLength,
      frameTransport: {
        schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
        privateOutputAdoption: {
          schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
          verifiedOutput: { sha256, byteLength }, privatePublicationStage: { sha256, byteLength },
        },
      },
    },
    warnings: [],
  };
}

function owner(
  frame: LinearSrgbSdrFinalWebGpuFrame,
  close: () => void,
  observed: (fd: number) => void,
  expectedFreshSignal: AbortSignal,
): StrictSdrCandidateF2aLeaseOwner {
  return Object.freeze({
    async runF2aInverse(input) {
      observed(input.sourceFd);
      expect(input.job.signal).toBe(expectedFreshSignal);
      input.job.reportProcessContainment(portableFfmpegContainmentEvidence("unix-process-group"));
      const comparison = input.compareDecoded(Buffer.from(frame.rgba8Srgb));
      return Object.freeze({ decoded: Object.freeze({ sha256: frame.rgba8SrgbSha256, byteLength: frame.rgba8Srgb.byteLength }), comparison, inverseCommandSha256: "d".repeat(64) });
    },
    async close() { close(); },
  });
}

function freshGovernor(
  signal: AbortSignal,
  observed: (request: Record<string, unknown>) => void,
  report: (evidence: unknown) => void,
): LocalMotionJobGovernor {
  const evidence: LocalMotionJobEvidence = { schema: "shellx-motion/local-job-resources@1", jobId: "fresh-f2a-job", lane: "ffmpeg", operation: "ffmpeg.strict-sdr-candidate-f2a-inverse", state: "passed", queueWaitMs: 0, durationMs: 1, policy: { maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 1_000, maxWallClockMs: 1_000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 256 * 1024 * 1024, rssPollIntervalMs: 1_000 }, scratch: { pathSafety: "canonical-no-symlink", freeBytesAtStart: 1_000_000_000, reservedBytes: 0, minFreeBytes: 0 }, peakProcessTreeRssBytes: 0, watchedProcessCount: 0, rssScope: "unavailable" };
  return {
    policy: evidence.policy,
    async run<T>(value: Record<string, unknown>, operation: (context: LocalMotionJobContext) => Promise<T>) {
      observed(value);
      return { value: await operation({ jobId: evidence.jobId, signal, scratchRoot: value.scratchRoot as string, watchProcess() {}, reportProcessContainment: report, reportSandbox() {} }), evidence };
    },
  } as unknown as LocalMotionJobGovernor;
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
