import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256, loadMotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { gpuFinalReceiptInputHashes } from "@shellx-motion/renderer-ffmpeg";
import { connectorArtifactStagingPath } from "./artifact-handle";
import { connectorGpuFinalEvidence, createStreamingDryRunRenderReceipt, renderConnectorStreamingArtifact, type ConnectorStreamingFinalRenderer } from "./streaming-final";
import { failedStreamingRenderer, gpuStreamingTestEvidence, streamingTestMediaBytes, successfulStreamingRenderer } from "./streaming-final.test-support";

const roots: string[] = [];

describe("connector streamed final adapter", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("projects complete GPU environment-arena provenance and refuses missing, forged, or contradictory values", () => {
    const receipt = gpuRendererReceipt({ environment: true });
    const inputHashes = receipt.inputHashes;
    expect(connectorGpuFinalEvidence(receipt)?.provenance).toEqual(inputHashes);

    const { ["gpu-readback-transport"]: _readbackTransport, ...missingReadbackTransport } = inputHashes;
    expect(connectorGpuFinalEvidence(gpuRendererReceipt(missingReadbackTransport))).toBeUndefined();
    expect(connectorGpuFinalEvidence(gpuRendererReceipt({ ...inputHashes, "gpu-readback-transport": "forged" }))).toBeUndefined();
    const { ["gpu-environment-arena"]: _environmentArena, ...missingEnvironmentArena } = inputHashes;
    expect(connectorGpuFinalEvidence(gpuRendererReceipt(missingEnvironmentArena, { environment: true }))).toBeUndefined();
    expect(connectorGpuFinalEvidence(gpuRendererReceipt({ ...inputHashes, "gpu-environment-arena": "forged" }, { environment: true }))).toBeUndefined();
    const contradictory = gpuRendererReceipt({ environment: true });
    const metrics = ((contradictory.output as { frameTransport: { producer: { evidence: { sessionResources: Record<string, unknown> } } } }).frameTransport.producer.evidence.sessionResources);
    Object.assign(metrics, {
      environmentUniformCapacitySlots: 0,
      environmentUniformBytes: 0,
      environmentUniformHighWaterSlots: 0,
      environmentUniformHighWaterBytes: 0,
      environmentDrawsRendered: 0
    });
    expect(connectorGpuFinalEvidence(contradictory)).toBeUndefined();
  });

  it("fails closed on partial and accessor-backed renderer receipts", () => {
    for (const receipt of [
      undefined,
      null,
      {},
      { schema: "shellx-motion/receipt@1", operation: "render.final", status: "passed", lane: "ffmpeg", id: "partial", output: {} },
      {
        schema: "shellx-motion/receipt@1", operation: "render.final", status: "passed", lane: "ffmpeg", id: "partial-producer",
        output: { frameTransport: { delivery: "streamed", frameLane: "gpu", frameCount: 1, retainedFrameCount: 0, producer: { frameLane: "gpu" } } }
      }
    ]) {
      expect(connectorGpuFinalEvidence(receipt)).toBeUndefined();
    }

    let outputReads = 0;
    const accessorBackedReceipt: Record<string, unknown> = {
      schema: "shellx-motion/receipt@1",
      operation: "render.final",
      status: "passed",
      lane: "ffmpeg",
      id: "accessor-receipt"
    };
    Object.defineProperty(accessorBackedReceipt, "output", {
      enumerable: true,
      get() {
        outputReads += 1;
        throw new Error("hostile receipt output accessor");
      }
    });
    expect(connectorGpuFinalEvidence(accessorBackedReceipt)).toBeUndefined();
    expect(outputReads).toBe(0);

    let producerEvidenceReads = 0;
    const accessorBacked = gpuRendererReceipt({ environment: true });
    const producer = ((accessorBacked.output as { frameTransport: { producer: Record<string, unknown> } }).frameTransport.producer);
    Object.defineProperty(producer, "evidence", {
      enumerable: true,
      get() {
        producerEvidenceReads += 1;
        throw new Error("hostile producer evidence accessor");
      }
    });
    expect(connectorGpuFinalEvidence(accessorBacked)).toBeUndefined();
    expect(producerEvidenceReads).toBe(0);

    let provenanceReads = 0;
    const provenanceAccessor = gpuRendererReceipt({ environment: true });
    const evidence = ((provenanceAccessor.output as { frameTransport: { producer: { evidence: Record<string, unknown> } } }).frameTransport.producer.evidence);
    Object.defineProperty(evidence, "provenance", {
      enumerable: true,
      get() {
        provenanceReads += 1;
        throw new Error("hostile evidence provenance accessor");
      }
    });
    expect(connectorGpuFinalEvidence(provenanceAccessor)).toBeUndefined();
    expect(provenanceReads).toBe(0);

    let nestedFrameCountReads = 0;
    const nestedReceiptAccessor = gpuRendererReceipt({ environment: true });
    const frameTransport = ((nestedReceiptAccessor.output as { frameTransport: Record<string, unknown> }).frameTransport);
    Object.defineProperty(frameTransport, "frameCount", {
      enumerable: true,
      get() {
        nestedFrameCountReads += 1;
        throw new Error("hostile nested frame-transport accessor");
      }
    });
    expect(connectorGpuFinalEvidence(nestedReceiptAccessor)).toBeUndefined();
    expect(nestedFrameCountReads).toBe(0);
  });

  it("publishes only a verified staged stream, rewrites public paths, and retains no source frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-streamed-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "render", "final.mp4");
    let stagedPath: string | undefined;
    let suppliedTransport: unknown;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      stagedPath = input.outputPath;
      suppliedTransport = input.transport;
      return await successfulStreamingRenderer("published stream")(input);
    };

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      streamingRenderer: renderer,
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(dirname(stagedPath as string)).toBe(join(root, "render"));
    expect(basename(stagedPath as string)).toMatch(/^\.final\.mp4\.[0-9a-f-]+\.stage\.mp4$/);
    expect(await readFile(outputPath)).toEqual(streamingTestMediaBytes("published stream", outputPath));
    await expect(stat(stagedPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toMatchObject({ frameLane: "browser" });
    expect(result.receipt).toMatchObject({
      status: "passed",
      output: {
        path: outputPath,
        frameLane: "browser",
        frameTransport: {
          delivery: "streamed",
          frameLane: "browser",
          frameCount: 120,
          retainedFrameCount: 0,
          producer: { frameLane: "browser", evidence: { schema: "shellx-motion/browser-streaming-producer@1", session: { state: "closed", cleanup: "complete" } } },
          encoderHandoff: { delivery: "streamed", encoderHandoffSourceFramesRetained: 0, attempts: [{ outcome: "succeeded" }] }
        }
      },
      artifacts: [expect.objectContaining({ role: "rendered_media", path: outputPath })]
    });
    expect(suppliedTransport).toEqual({ delivery: "streamed", reason: "stream_default" });
  });

  it("forwards strict GPU final delivery as raw RGBA and binds the renderer provenance before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-gpu-streamed-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "render", "gpu.mp4");
    let forwarded: Record<string, unknown> | undefined;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      forwarded = { ...input };
      return await successfulStreamingRenderer("gpu connector seam")(input);
    };

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "gpu",
      outputPath,
      streamingRenderer: renderer,
      now: () => "2026-08-13T10:00:00.000Z"
    });

    expect(forwarded).toMatchObject({ frameLane: "gpu", transport: { delivery: "streamed", reason: "stream_default" } });
    // Connectors still own only direct streamed delivery. They must not quietly become a second
    // durable segmented host path or forward browser/provider/capture authority to the renderer.
    for (const field of ["segmented", "scratchRoot", "callerId", "signal", "browserLocation", "browserSessionFactory", "openVideoProvider", "providerFactory", "openHybridCapture", "hybridCapture", "capturePlan"]) {
      expect(forwarded).not.toHaveProperty(field);
    }
    expect(await readFile(outputPath)).toEqual(streamingTestMediaBytes("gpu connector seam", outputPath));
    expect(result.receipt).toMatchObject({
      status: "passed",
      inputHashes: {
        "gpu-pipeline-catalog": expect.stringMatching(/^[a-f0-9]{64}$/),
        "gpu-readback-transport": expect.stringMatching(/^[a-f0-9]{64}$/),
        "gpu-containment": expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      output: {
        path: outputPath,
        frameLane: "gpu",
        frameTransport: {
          delivery: "streamed",
          frameLane: "gpu",
          producer: { frameLane: "gpu", evidence: { schema: "shellx-motion/gpu-streaming-producer@1" } },
          encoderHandoff: { maxRgbaBytesPerFrame: 16_384 }
        }
      }
    });
  });

  it("records a GPU dry run as planned without collecting or claiming hardware evidence", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const receipt = createStreamingDryRunRenderReceipt({
      pkg,
      outputPath: "/tmp/gpu-plan.mp4",
      frameLane: "gpu",
      createdAt: "2026-08-13T10:00:00.000Z"
    });

    expect(receipt).toMatchObject({
      status: "not_run",
      output: {
        dryRun: true,
        frameLane: "gpu",
        gpu: { status: "planned_not_executed", hardwareEvidence: "not_collected" }
      }
    });
  });

  it("refuses GPU publication when an injected renderer returns a non-GPU receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-gpu-mismatch-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "render", "gpu.mp4");
    const renderer: ConnectorStreamingFinalRenderer = async (input) =>
      await successfulStreamingRenderer("wrong lane")({ ...input, frameLane: "browser" });

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "gpu",
      outputPath,
      streamingRenderer: renderer,
      now: () => "2026-08-13T10:00:00.000Z"
    });

    expect(result.receipt).toMatchObject({
      status: "failed",
      output: { frameLane: "gpu", error: { code: "gpu_producer_evidence_missing", stagingOutputRemoved: true } }
    });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses GPU quality requests that require materialized frames without trying another lane", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    let rendererCalls = 0;
    const result = await renderConnectorStreamingArtifact({
      pkg, frameLane: "gpu", outputPath: "/tmp/gpu-quality.mp4", quality: { minUniqueFrameHashes: 65 },
      streamingRenderer: async () => {
        rendererCalls += 1;
        return { ok: false as const, transport: { delivery: "streamed" as const, reason: "stream_default" as const }, error: { code: "unexpected_renderer_call", message: "GPU materialization must refuse before rendering." } };
      },
      now: () => "2026-08-13T10:00:00.000Z"
    });

    expect(rendererCalls).toBe(0);
    expect(result.receipt.output).toMatchObject({
      frameLane: "gpu", frameTransportPlan: { delivery: "materialized", reason: "streaming_quality_capacity" },
      error: { code: "frame_transport_materialized_required" }
    });
  });

  it("records a typed streaming failure, preserves its partial-output evidence, and deletes the staged file", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-stream-failure-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "render", "final.mp4");
    let stagedPath: string | undefined;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      stagedPath = input.outputPath;
      await writeFile(input.outputPath, "partial stream", "utf8");
      return {
        ok: false,
        transport: { delivery: "streamed", reason: "stream_default" },
        error: {
          code: "stream_output_invalid",
          message: "The staged stream failed output verification.",
          resources: { ffmpeg: { available: true } },
          handoff: { attempted: "image2pipe" },
          producer: { emittedFrames: 2 },
          partialOutput: {
            path: input.outputPath,
            status: "nonconforming",
            validationFailure: "missing required video stream",
            tools: { ffmpeg: { name: "ffmpeg", available: true } }
          }
        }
      };
    };

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      streamingRenderer: renderer,
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(result.receipt).toMatchObject({
      status: "failed",
      output: {
        path: outputPath,
        error: {
          code: "stream_output_invalid",
          resources: { ffmpeg: { available: true } },
          handoff: { attempted: "image2pipe" },
          producer: { emittedFrames: 2 },
          partialOutput: { path: stagedPath, status: "nonconforming" },
          stagingOutputRemoved: true
        }
      }
    });
    await expect(stat(stagedPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a failed stage rather than deleting a host replacement after its parent is retargeted", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-stream-retarget-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputParent = join(root, "render");
    const displacedParent = join(root, "displaced-render");
    const outputPath = join(outputParent, "final.mp4");
    let hostStagePath: string | undefined;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      await writeFile(input.outputPath, "partial stream", "utf8");
      await rename(outputParent, displacedParent);
      await mkdir(outputParent);
      hostStagePath = join(outputParent, basename(input.outputPath));
      await writeFile(hostStagePath, "host replacement", "utf8");
      return {
        ok: false,
        transport: { delivery: "streamed", reason: "stream_default" },
        error: { code: "stream_output_invalid", message: "The staged stream failed output verification." }
      };
    };

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      streamingRenderer: renderer,
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(result.receipt.output).toMatchObject({ error: { stagingOutputRetained: true } });
    await expect(readFile(hostStagePath as string, "utf8")).resolves.toBe("host replacement");
  });

  it("reports the planner's pre-execution materialization requirement without filesystem mutation or fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-materialized-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputDir = join(root, "not-created", "render");
    const outputPath = join(outputDir, "final.mp4");

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      quality: { minUniqueFrameHashes: 65 },
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(result.receipt).toMatchObject({
      status: "failed",
      output: {
        frameTransportPlan: { delivery: "materialized", reason: "streaming_quality_capacity" },
        error: { code: "frame_transport_materialized_required" }
      }
    });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "frames"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((result.receipt.output as { error?: Record<string, unknown> }).error).not.toHaveProperty("stagingOutputRemoved");
  });

  it("does not treat a framesDir-shaped caller path as a retention request", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-no-retention-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "frames", "caller-kept", "final.mp4");
    const expectedStagingPrefix = connectorArtifactStagingPath(outputPath).replace(/\.[0-9a-f-]+\.stage\.mp4$/, "");
    let actualStagingPath: string | undefined;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      actualStagingPath = input.outputPath;
      return await successfulStreamingRenderer()(input);
    };

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      streamingRenderer: renderer,
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(actualStagingPath?.startsWith(expectedStagingPrefix)).toBe(true);
    expect(result.receipt.output).toMatchObject({ frameTransport: { retainedFrameCount: 0 } });
  });

  it("reports no residual staged file for an ordinary typed renderer failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-typed-failure-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "render", "final.mp4");

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      streamingRenderer: failedStreamingRenderer("streaming_quality_policy_unsupported", "Streaming quality capacity was exceeded."),
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(result.receipt.output).toMatchObject({
      error: {
        code: "streaming_quality_policy_unsupported",
        message: "Streaming quality capacity was exceeded.",
        stagingOutputRemoved: true
      }
    });
    expect((result.receipt.output as { error?: Record<string, unknown> }).error).not.toHaveProperty("stagingOutputRetained");
  });

  it("does not let a legacy command runner fake streamed stdin or final delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-runner-only-"));
    roots.push(root);
    const pkg = await loadMotionPackage("../../fixtures/packages/lower-third");
    const outputPath = join(root, "render", "final.mp4");
    let runnerCalls = 0;

    const result = await renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      // The default transport refusal happens before a command can be launched. A legacy runner
      // has no way to supply the image2pipe producer or claim that it delivered final media.
      quality: { minUniqueFrameHashes: 65 },
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-08-08T00:00:00.000Z"
    });

    expect(runnerCalls).toBe(0);
    expect(result.receipt.output).toMatchObject({
      error: { code: "frame_transport_materialized_required" },
      frameTransportPlan: { delivery: "materialized", reason: "streaming_quality_capacity" }
    });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function gpuRendererReceipt(
  input: Record<string, string> | { environment: boolean },
  options: { environment: boolean } = { environment: false }
): OperationReceipt {
  const environment = "environment" in input ? input.environment : options.environment;
  const evidence = gpuStreamingTestEvidence(1) as Record<string, any>;
  if (environment) {
    evidence.provenance.staticPlan.maxima.maxEnvironmentCount = 1;
    evidence.provenance.resourceBudget.maxima.environmentCount = 8;
    evidence.provenance.resourceBudget.maxima.environmentUniformBytes = 1_664;
    evidence.provenance.resourceBudget.sha256 = canonicalJsonSha256({
      schema: evidence.provenance.resourceBudget.schema,
      expectedFrames: evidence.provenance.resourceBudget.expectedFrames,
      observedFrames: evidence.provenance.resourceBudget.observedFrames,
      maxima: evidence.provenance.resourceBudget.maxima
    });
    Object.assign(evidence.sessionResources, {
      environmentUniformCapacitySlots: 36,
      environmentUniformBytes: 9_216,
      environmentUniformHighWaterSlots: 36,
      environmentUniformHighWaterBytes: 9_216,
      environmentDrawsRendered: 8,
      environmentEnvelopeReservations: 1
    });
  }
  const expected = gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: evidence as never });
  if (!expected) throw new Error("GPU test receipt must construct complete provenance.");
  const inputHashes = "environment" in input ? expected : input;
  return {
    schema: "shellx-motion/receipt@1",
    id: "gpu-renderer-receipt",
    operation: "render.final",
    status: "passed",
    packageId: "gpu-provenance-test",
    inputHashes,
    createdAt: "2026-08-15T00:00:00.000Z",
    lane: "ffmpeg",
    output: {
      frameTransport: {
        delivery: "streamed",
        frameLane: "gpu",
        frameCount: 1,
        retainedFrameCount: 0,
        producer: { frameLane: "gpu", evidence }
      }
    },
    warnings: []
  };
}
