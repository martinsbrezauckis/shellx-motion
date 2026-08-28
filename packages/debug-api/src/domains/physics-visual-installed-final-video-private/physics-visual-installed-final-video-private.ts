/**
 * Private C7B5 installed-output final-video proof.
 *
 * The only package read is C7B4D's output-only reopen. It recreates the process-minted C7B4C
 * authority, streams its fixed complete schedule through one retained WebGPU session, and uses
 * the established FFmpeg policy behind a Core no-clobber publication stage.
 */
import { acquireDerivedOutputPublication, canonicalJson, canonicalJsonSha256, hashBuffer, isPublicationCommitUncertain, streamingFrameTimestampMs } from "@shellx-motion/core";
import {
  createGpuGltfObjectRetainedRenderSession,
  type GpuGltfObjectRetainedRenderSession,
  type GpuGltfObjectRetainedSessionOpenResult,
  type GpuGltfObjectRetainedSessionOpenOptions,
} from "@shellx-motion/renderer-browser/internal/gltf-object-retained-render";
import {
  runStreamingFinalEncodePolicy,
  type StreamingFinalEncodePolicyInput,
  type StreamingFinalEncodePolicyResult,
} from "@shellx-motion/renderer-ffmpeg/internal/physics-visual-installed-final-video-policy";
import { resolve } from "node:path";
import {
  compilePhysicsVisualPresentationFramePlan,
  readPhysicsVisualPresentationFrameUpload,
  readPhysicsVisualPresentationStaticUpload,
} from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { requirePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-authority-private.js";
import { requirePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-authority-private.js";
import {
  reopenPhysicsVisualPackageMaterializationOutput,
  reopenPhysicsVisualPackagePreviewInput,
} from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";
import type { PhysicsVisualPackageInstalledOutput, PhysicsVisualPackagePreviewInput } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-output-private.js";
import type { PhysicsVisualPackageOutputHost } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-facts-private.js";
import { assertSeparateOutput, closeRetainedSession, freeze, installedIdentity, isContainedFinalBrowser, withFinalOutputWorkspaceAuthority } from "./physics-visual-installed-final-video-support-private.js";

const RECEIPT_SCHEMA = "shellx-motion/private-physics-visual-installed-final-video-receipt@1" as const;
const PRESET = "mp4-h264" as const;

export interface PhysicsVisualInstalledFinalVideoInput {
  readonly schema: "shellx-motion/private-physics-visual-installed-final-video-input@1";
  readonly installed: PhysicsVisualPackageInstalledOutput;
  readonly preview: PhysicsVisualPackagePreviewInput;
  readonly schedule: Readonly<{
    startUs: number;
    endUs: number;
    stepsPerSecond: number;
    stepCount: number;
    sampleEverySteps: number;
    frameRate: number;
    renderFrameCount: number;
    terminalFrameIndex: number;
    displayedFrameCount: number;
    durationMs: number;
  }>;
  readonly scheduleSha256: string;
}

export interface PhysicsVisualInstalledFinalVideoHost extends PhysicsVisualPackageOutputHost {
  /** Separate, absent final video path. C7B5 never mutates the installed package. */
  readonly finalOutputPath: string;
  /** Separate, absent receipt path published before the final video. */
  readonly finalReceiptPath: string;
  readonly scratchRoot?: string;
  readonly signal?: AbortSignal;
  readonly callerId?: string;
  readonly jobId?: string;
}

export interface PhysicsVisualInstalledFinalVideoReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly status: "passed";
  readonly publication: Readonly<{ videoPath: string; receiptPath: string; protocol: "receipt-first-media-last" }>;
  readonly installed: Pick<PhysicsVisualPackageInstalledOutput, "recipeBundleFingerprint" | "presentationStaticFingerprint" | "plans" | "package" | "artifact" | "sidecar" | "receiptFingerprint">;
  readonly schedule: PhysicsVisualInstalledFinalVideoInput["schedule"] & { readonly sha256: string; readonly terminalDisplay: "one-frame-hold" };
  readonly frames: Readonly<{
    framePlanSequenceSha256: string;
    pixelSequenceSha256: string;
    frameCount: number;
    terminalFrameIndex: number;
    terminalFramePlanFingerprint: string;
    terminalPixelSha256: string;
    timing: Readonly<{
      timelineSha256: string;
      first: Readonly<{ source: Readonly<{ startUs: number; offsetNumeratorUs: number; denominator: number }>; encoderAtMs: number }>;
      terminal: Readonly<{ source: Readonly<{ startUs: number; offsetNumeratorUs: number; denominator: number }>; encoderAtMs: number }>;
    }>;
  }>;
  readonly gpu: Readonly<{
    browserVersion: string;
    runtime: GpuGltfObjectRetainedRenderSession["runtimeEvidence"];
    adapterFingerprint: string;
    adapterFingerprintsSha256: string;
    retainedMetrics: Readonly<{
      resourceIdentitySha256: string;
      preparationOperations: 1;
      renderedFrames: number;
      perFrameGpuAllocations: 0;
    }>;
    containment: NonNullable<GpuGltfObjectRetainedRenderSession["browserProcess"]["containment"]>;
    watchedRoot: Readonly<{ pid: number; registered: true }>;
    cleanup: Awaited<ReturnType<GpuGltfObjectRetainedRenderSession["close"]>>;
  }>;
  readonly encoder: Readonly<{
    preset: typeof PRESET;
    command: { readonly executable: string; readonly args: readonly string[]; readonly shell: false };
    plannedAttempts: readonly unknown[];
    handoff: unknown;
    output: Readonly<{ path: string; sha256: string; byteLength: number; durationMs: number; frameCount: number; observedMedia: unknown }>;
  }>;
  readonly terminal: Readonly<{
    retainedSessionClosed: true;
    browserProcess: Readonly<{ pid: number; launcher: string; closeCompleted: true }>;
    encoderJob: Readonly<{ state: string; watchedProcessCount: number }>;
    outputPublication: "verified-stage-then-no-clobber-link";
  }>;
  readonly fingerprint: string;
}

export interface PhysicsVisualInstalledFinalVideoResult {
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly receipt: PhysicsVisualInstalledFinalVideoReceipt;
}

export interface PhysicsVisualInstalledFinalVideoDependencies {
  readonly openSession?: (staticUpload: ReturnType<typeof readPhysicsVisualPresentationStaticUpload>, options: GpuGltfObjectRetainedSessionOpenOptions) => Promise<GpuGltfObjectRetainedSessionOpenResult>;
  readonly encode?: (input: StreamingFinalEncodePolicyInput) => Promise<StreamingFinalEncodePolicyResult>;
  /** Test-only private seam for Core's paired-output commit uncertainty contract. */
  readonly acquirePublication?: typeof acquireDerivedOutputPublication;
}

/**
 * Reopens only C7B4D output and exposes its compiler-minted full-frame schedule for C7B5.
 * C7B4D's existing preview value stays unchanged; this is a separate private C7B5 projection.
 */
export async function reopenPhysicsVisualPackageFinalVideoInput(host: PhysicsVisualPackageOutputHost): Promise<PhysicsVisualInstalledFinalVideoInput> {
  const installed = await reopenPhysicsVisualPackageMaterializationOutput(host);
  const preview = await reopenPhysicsVisualPackagePreviewInput(host);
  if (preview.installed.receiptFingerprint !== installed.receiptFingerprint || preview.installed.presentationStaticFingerprint !== installed.presentationStaticFingerprint || preview.installed.recipeBundleFingerprint !== installed.recipeBundleFingerprint || canonicalJsonSha256(preview.installed.plans) !== canonicalJsonSha256(installed.plans)) {
    throw new Error("C7B5 output-only reopen did not return the exact C7B4D installed identity.");
  }
  const { retained, physics } = requirePhysicsVisualPresentationStaticPlan(preview.presentationStaticPlan);
  const { visual } = requirePhysicsVisualRetainedStaticPlan(retained);
  const visualSchedule = visual.schedule;
  const displayedFrameCount = visualSchedule.terminalFrameIndex + 1;
  if (visualSchedule.terminalFrameIndex !== visualSchedule.renderFrameCount || displayedFrameCount < 2 || visualSchedule.frameRate < 1) {
    throw new Error("C7B5 requires the C7B4A terminal frame immediately after its complete render-frame range.");
  }
  const scheduleSha256 = canonicalJsonSha256({ physics: physics.schedule, visual: visualSchedule });
  if (scheduleSha256 !== installed.plans.scheduleSha256) {
    throw new Error("C7B5 output-only schedule no longer matches the installed C7B4D plan identity.");
  }
  const durationMs = (displayedFrameCount * 1_000) / visualSchedule.frameRate;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("C7B5 output-only frame schedule has no finite video duration.");
  return freeze({
    schema: "shellx-motion/private-physics-visual-installed-final-video-input@1" as const,
    installed,
    preview,
    schedule: freeze({
      startUs: visualSchedule.startUs,
      endUs: visualSchedule.endUs,
      stepsPerSecond: visualSchedule.stepsPerSecond,
      stepCount: visualSchedule.stepCount,
      sampleEverySteps: visualSchedule.sampleEverySteps,
      frameRate: visualSchedule.frameRate,
      renderFrameCount: visualSchedule.renderFrameCount,
      terminalFrameIndex: visualSchedule.terminalFrameIndex,
      displayedFrameCount,
      durationMs,
    }),
    scheduleSha256,
  });
}

/** Runs one retained WebGPU session and one governed raw-RGBA-to-H.264 final encode. */
export async function renderPhysicsVisualInstalledFinalVideo(host: PhysicsVisualInstalledFinalVideoHost, dependencies: PhysicsVisualInstalledFinalVideoDependencies = {}): Promise<PhysicsVisualInstalledFinalVideoResult> {
  return await withFinalOutputWorkspaceAuthority(host, async () => await renderPhysicsVisualInstalledFinalVideoWithinWorkspace(host, dependencies));
}

async function renderPhysicsVisualInstalledFinalVideoWithinWorkspace(host: PhysicsVisualInstalledFinalVideoHost, dependencies: PhysicsVisualInstalledFinalVideoDependencies): Promise<PhysicsVisualInstalledFinalVideoResult> {
  assertSeparateOutput(host.outputPackageRoot, host.finalOutputPath);
  assertSeparateOutput(host.outputPackageRoot, host.finalReceiptPath);
  if (resolve(host.finalOutputPath) === resolve(host.finalReceiptPath)) throw new Error("C7B5 final video and its receipt require distinct absent output paths.");
  const acquirePublication = dependencies.acquirePublication ?? acquireDerivedOutputPublication;
  const receiptPublication = await acquirePublication({ outputPath: host.finalReceiptPath, kind: "file" });
  let publication: Awaited<ReturnType<typeof acquireDerivedOutputPublication>> | undefined;
  let receiptPublished = false, published = false, commitUncertain = false;
  let receiptEvidence: Awaited<ReturnType<typeof receiptPublication.writePrivateFile>> | undefined;
  let session: GpuGltfObjectRetainedRenderSession | undefined;
  let primaryError: unknown;
  try {
    publication = await acquirePublication({ outputPath: host.finalOutputPath, kind: "file" });
    const input = await reopenPhysicsVisualPackageFinalVideoInput(host);
    const staticUpload = readPhysicsVisualPresentationStaticUpload(input.preview.presentationStaticPlan);
    const framePlanHashes: string[] = [], pixelHashes: string[] = [], adapterFingerprints: string[] = [];
    const frameTiming: Array<{ index: number; source: { startUs: number; offsetNumeratorUs: number; denominator: number }; encoderAtMs: number }> = [];
    let terminalFramePlanFingerprint = "", terminalPixelSha256 = "";
    let terminalTiming: PhysicsVisualInstalledFinalVideoReceipt["frames"]["timing"]["terminal"] | undefined;
    let firstTiming: PhysicsVisualInstalledFinalVideoReceipt["frames"]["timing"]["first"] | undefined;
    let retainedMetrics: PhysicsVisualInstalledFinalVideoReceipt["gpu"]["retainedMetrics"] | undefined;
    let retainedResourceIdentity: string | undefined;
    let browserProcess: GpuGltfObjectRetainedRenderSession["browserProcess"] | undefined;
    let containment: NonNullable<GpuGltfObjectRetainedRenderSession["browserProcess"]["containment"]> | undefined;
    let browserVersion: string | undefined;
    let runtime: GpuGltfObjectRetainedRenderSession["runtimeEvidence"] | undefined;
    let cleanup: Awaited<ReturnType<GpuGltfObjectRetainedRenderSession["close"]>> | undefined;
    const policyInput = {
      fps: input.schedule.frameRate,
      width: staticUpload.width,
      height: staticUpload.height,
      durationMs: input.schedule.durationMs,
      frameFormat: "rgba" as const,
      outputPath: publication.stagingPath,
      outputRoots: [publication.rootPath],
      preset: PRESET,
      // C7B5 deliberately uses one software attempt: retained frame identities cannot be reused
      // across a hardware fallback, and a retry would need a separately sealed second sequence.
      forceSoftwareEncode: true,
      quality: { minDurationMs: input.schedule.durationMs, minUniqueFrameHashes: 2 },
      ...(host.scratchRoot ? { scratchRoot: host.scratchRoot } : {}),
      operation: "physics-visual.installed-final-video",
      ...(host.callerId ? { callerId: host.callerId } : {}),
      ...(host.jobId ? { jobId: host.jobId } : {}),
      ...(host.signal ? { signal: host.signal } : {}),
    } satisfies Omit<StreamingFinalEncodePolicyInput, "produce" | "admittedPreflight">;
    const encoded = await (dependencies.encode ?? runStreamingFinalEncodePolicy)({
      ...policyInput,
      // The ordinary input stays structurally complete, but this producer can never run: C7B5
      // replaces it only after the policy has acquired its sole FFmpeg governor lease.
      produce: async () => { throw new Error("C7B5 installed final producer was invoked before governor admission."); },
      admittedPreflight: async ({ job }) => {
        const maxProcessTreeRssBytes = job.maxProcessTreeRssBytes ?? 0;
        if (typeof job.scratchRoot !== "string" || !job.scratchRoot || !Number.isSafeInteger(maxProcessTreeRssBytes) || maxProcessTreeRssBytes < 64 * 1024 * 1024) {
          throw new Error("C7B5 final retained WebGPU requires an admitted scratch root and process-tree RSS limit before Chromium launch.");
        }
        const opened = await (dependencies.openSession ?? createGpuGltfObjectRetainedRenderSession)(staticUpload, {
          finalBrowser: { scratchRoot: job.scratchRoot, maxProcessTreeRssBytes, signal: job.signal },
        });
        if (!opened.ok) throw new Error(`C7B5 retained WebGPU session refused: ${opened.failure.code}: ${opened.failure.message}`);
        session = opened.session;
        browserProcess = session.browserProcess;
        if (!isContainedFinalBrowser(browserProcess, maxProcessTreeRssBytes)) {
          throw new Error("C7B5 final retained WebGPU refused a browser without exact pre-contained process evidence.");
        }
        containment = browserProcess.containment;
        browserVersion = session.browserVersion;
        runtime = session.runtimeEvidence;
        job.watchProcess(browserProcess.pid);
        return {
          input: policyInput,
          produce: async (sink, context) => await context.runAdmitted(async (admittedJob) => {
            if (admittedJob.jobId !== job.jobId || session !== opened.session) throw new Error("C7B5 final renderer lost its admitted governor job.");
            try {
              for (let frameIndex = 0; frameIndex < input.schedule.displayedFrameCount; frameIndex += 1) {
                if (context.signal.aborted) throw context.signal.reason;
                const framePlan = compilePhysicsVisualPresentationFramePlan(input.preview.presentationStaticPlan, frameIndex);
                const rendered = await session.render(readPhysicsVisualPresentationFrameUpload(input.preview.presentationStaticPlan, framePlan), { signal: context.signal });
                if (!rendered.ok) throw new Error(`C7B5 retained frame ${frameIndex} failed: ${rendered.failure.code}: ${rendered.failure.message}`);
                const metrics = rendered.metrics;
                const resourceIdentity = canonicalJsonSha256({ schema: metrics.schema, staticFingerprint: metrics.staticFingerprint, geometryResourceCount: metrics.geometryResourceCount, instanceSlotCount: metrics.instanceSlotCount, sharedGeometryReuseCount: metrics.sharedGeometryReuseCount, vertexBufferBytes: metrics.vertexBufferBytes, indexBufferBytes: metrics.indexBufferBytes, uniformBufferBytes: metrics.uniformBufferBytes, retainedGpuBytes: metrics.retainedGpuBytes, preparationOperations: metrics.preparationOperations, perFrameGpuAllocations: metrics.perFrameGpuAllocations });
                if (metrics.preparationOperations !== 1 || metrics.renderedFrames !== frameIndex + 1 || metrics.perFrameGpuAllocations !== 0 || (retainedResourceIdentity && retainedResourceIdentity !== resourceIdentity)) {
                  throw new Error("C7B5 retained WebGPU metrics prove a per-frame allocation or unstable static resource set.");
                }
                retainedResourceIdentity = resourceIdentity;
                retainedMetrics = freeze({ resourceIdentitySha256: resourceIdentity, preparationOperations: 1 as const, renderedFrames: metrics.renderedFrames, perFrameGpuAllocations: 0 as const });
                const rgba = Buffer.from(rendered.frame.rgba), pixelSha256 = hashBuffer(rgba), atMs = streamingFrameTimestampMs(frameIndex, input.schedule.frameRate, input.schedule.durationMs);
                const source = freeze({ startUs: framePlan.time.startUs, offsetNumeratorUs: framePlan.time.offsetNumeratorUs, denominator: framePlan.time.denominator });
                framePlanHashes.push(framePlan.fingerprint); pixelHashes.push(pixelSha256); adapterFingerprints.push(rendered.frame.evidence.adapterFingerprint);
                frameTiming.push({ index: frameIndex, source, encoderAtMs: atMs });
                if (!firstTiming) firstTiming = freeze({ source, encoderAtMs: atMs });
                if (framePlan.terminal) { terminalFramePlanFingerprint = framePlan.fingerprint; terminalPixelSha256 = pixelSha256; terminalTiming = freeze({ source, encoderAtMs: atMs }); }
                await sink.write({ index: frameIndex, atMs, format: "rgba", rgba, width: staticUpload.width, height: staticUpload.height, strideBytes: staticUpload.width * 4, colorSpace: "srgb", alphaMode: "straight" });
              }
            } finally {
              cleanup = await closeRetainedSession(session);
              session = undefined;
            }
          }),
          release: async () => {
            if (session) { cleanup = await closeRetainedSession(session); session = undefined; }
          },
        };
      },
    });
    if (!encoded.ok) throw new Error(`C7B5 governed final encode failed: ${encoded.error.code}: ${encoded.error.message}`);
    if (encoded.plannedAttempts.length !== 1 || encoded.plannedAttempts[0]?.source !== "software" || encoded.handoff.attempts.length !== 1 || encoded.handoff.attempts[0]?.source !== "software" || encoded.handoff.quality.frameCount !== input.schedule.displayedFrameCount || encoded.handoff.backpressure.writes !== input.schedule.displayedFrameCount || !terminalFramePlanFingerprint || !terminalPixelSha256 || !firstTiming || !terminalTiming || !retainedMetrics || !cleanup || !browserProcess || !containment || !browserVersion || !runtime || adapterFingerprints.length !== input.schedule.displayedFrameCount || new Set(adapterFingerprints).size !== 1) {
      throw new Error("C7B5 final encoder did not consume every C7B4A frame including the terminal hold.");
    }
    if (retainedMetrics.renderedFrames !== input.schedule.displayedFrameCount) throw new Error("C7B5 retained WebGPU metrics did not finish its complete fixed schedule.");
    const reopenedAfterEncode = await reopenPhysicsVisualPackageFinalVideoInput(host);
    if (installedIdentity(reopenedAfterEncode.installed) !== installedIdentity(input.installed) || reopenedAfterEncode.scheduleSha256 !== input.scheduleSha256) {
      throw new Error("C7B5 installed output changed while final media was being rendered.");
    }
    const staged = await publication.verifyFile();
    if (staged.sha256 !== encoded.receiptEvidence.output.sha256) throw new Error("C7B5 FFmpeg readback hash does not match its private publication stage.");
    const command = freeze({ executable: encoded.command.executable, args: freeze(encoded.command.args.map((value) => value === publication!.stagingPath ? host.finalOutputPath : value)), shell: false as const });
    const receiptWithoutFingerprint = {
      schema: RECEIPT_SCHEMA,
      status: "passed" as const,
      publication: freeze({ videoPath: host.finalOutputPath, receiptPath: host.finalReceiptPath, protocol: "receipt-first-media-last" as const }),
      installed: freeze({ recipeBundleFingerprint: input.installed.recipeBundleFingerprint, presentationStaticFingerprint: input.installed.presentationStaticFingerprint, plans: input.installed.plans, package: input.installed.package, artifact: input.installed.artifact, sidecar: input.installed.sidecar, receiptFingerprint: input.installed.receiptFingerprint }),
      schedule: freeze({ ...input.schedule, sha256: input.scheduleSha256, terminalDisplay: "one-frame-hold" as const }),
      frames: freeze({ framePlanSequenceSha256: canonicalJsonSha256(framePlanHashes), pixelSequenceSha256: canonicalJsonSha256(pixelHashes), frameCount: input.schedule.displayedFrameCount, terminalFrameIndex: input.schedule.terminalFrameIndex, terminalFramePlanFingerprint, terminalPixelSha256, timing: freeze({ timelineSha256: canonicalJsonSha256(frameTiming), first: firstTiming, terminal: terminalTiming }) }),
      gpu: freeze({ browserVersion, runtime, adapterFingerprint: adapterFingerprints[0]!, adapterFingerprintsSha256: canonicalJsonSha256(adapterFingerprints), retainedMetrics, containment, watchedRoot: freeze({ pid: browserProcess.pid, registered: true as const }), cleanup }),
      encoder: freeze({ preset: PRESET, command, plannedAttempts: freeze(encoded.plannedAttempts.map((attempt) => ({ source: attempt.source, ...(attempt.encoder ? { encoder: attempt.encoder } : {}) }))), handoff: encoded.handoff, output: freeze({ path: host.finalOutputPath, sha256: staged.sha256, byteLength: staged.byteLength, durationMs: encoded.receiptEvidence.output.durationMs, frameCount: input.schedule.displayedFrameCount, observedMedia: encoded.receiptEvidence.output.observedMedia }) }),
      terminal: freeze({ retainedSessionClosed: true as const, browserProcess: freeze({ pid: browserProcess.pid, launcher: browserProcess.launcher, closeCompleted: true as const }), encoderJob: freeze({ state: encoded.handoff.resources.state, watchedProcessCount: encoded.handoff.resources.watchedProcessCount }), outputPublication: "verified-stage-then-no-clobber-link" as const }),
    };
    const receipt = freeze({ ...receiptWithoutFingerprint, fingerprint: canonicalJsonSha256(receiptWithoutFingerprint) });
    receiptEvidence = await receiptPublication.writePrivateFile(Buffer.from(`${canonicalJson(receipt)}\n`, "utf8"), { label: "C7B5 installed physics final-video receipt", maxBytes: 1024 * 1024 });
    await receiptPublication.publishFile(receiptEvidence, { retainReservation: true });
    receiptPublished = true;
    await receiptPublication.verifyPublishedFile(receiptEvidence);
    if (host.signal?.aborted) throw host.signal.reason ?? new Error("C7B5 cancelled after receipt-first publication.");
    try {
      await publication.publishFile(staged);
      published = true;
    } catch (error) {
      if (isPublicationCommitUncertain(error)) { commitUncertain = true; throw error; }
      await receiptPublication.revokePublishedFile(receiptEvidence);
      receiptPublished = false;
      throw error;
    }
    await receiptPublication.abort();
    return freeze({ outputPath: host.finalOutputPath, receiptPath: host.finalReceiptPath, receipt });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (session) { await closeRetainedSession(session); session = undefined; }
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        if (!published && receiptPublished && receiptEvidence && !commitUncertain) {
          await receiptPublication.revokePublishedFile(receiptEvidence);
          receiptPublished = false;
        }
      } finally {
        if (!published) await publication?.abort();
        await receiptPublication.abort();
      }
    }
    if (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], "C7B5 final-video operation and retained-session cleanup both failed.");
      throw cleanupError;
    }
  }
}
