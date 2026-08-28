/** Contract coverage for retained-frame request/response parity in the public SDK client. */
import { describe, expect, it } from "vitest";
import { createMotionSdk } from "./client";
import type { MotionSdkOperation, MotionSdkTransport, MotionSdkTransportRequest } from "./types";

const renderInput = { packageRoot: "/pkg", outputPath: "/out/final.webm", preset: "webm-vp9" as const };
const retainedFrames = { dir: "/motion/scratch/render-1/pkg_sdk", count: 3 };

describe("SDK render keepFrames", () => {
  it("accepts retained frame locations only for explicit keepFrames requests", async () => {
    const retained = await createMotionSdk(renderTransport({ frames: retainedFrames })).render({ ...renderInput, keepFrames: true });
    expect(retained).toMatchObject({ ok: true, output: { frames: retainedFrames } });

    const leaked = await createMotionSdk(renderTransport({ frames: retainedFrames })).render(renderInput);
    expect(leaked).toMatchObject({
      ok: false,
      error: { code: "invalid_transport_response", message: "SDK render retained frames must be present only for keepFrames requests and have a valid directory/count." }
    });
  });

  it("rejects non-boolean keepFrames before transport", async () => {
    let calls = 0;
    const sdk = createMotionSdk({
      async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
        calls += 1;
        return renderEnvelope(request, {}) as never;
      }
    });
    const result = await sdk.render({ ...renderInput, keepFrames: "always" } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK render keepFrames must be boolean." } });
    const pngFrame = await sdk.render({ ...renderInput, preset: "png-frame", keepFrames: true });
    expect(pngFrame).toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK render keepFrames: true requires a final-video FFmpeg preset." } });
    expect(calls).toBe(0);
  });

  it("keeps opt-in attested reuse separate from legacy cache selectors before transport", async () => {
    let calls = 0;
    const sdk = createMotionSdk({
      async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
        calls += 1;
        return renderEnvelope(request, {}) as never;
      }
    });
    const withLegacyKey = await sdk.render({ ...renderInput, reuseAttested: true, idempotencyKey: "legacy-key" });
    const withLegacyRoot = await sdk.render({ ...renderInput, reuseAttested: true, artifactRoot: "/out" });

    expect(withLegacyKey).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("omit legacy idempotencyKey") } });
    expect(withLegacyRoot).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("omit legacy artifactRoot") } });
    expect(calls).toBe(0);
  });

  it("forwards direct and durable-segmented GPU final selection but rejects materialization and cache reuse controls", async () => {
    let request: MotionSdkTransportRequest | undefined;
    const sdk = createMotionSdk({
      async execute<K extends MotionSdkOperation>(input: MotionSdkTransportRequest<K>) {
        request = input;
        return renderEnvelope(input, {}) as never;
      }
    });

    await expect(sdk.render({ ...renderInput, frameLane: "gpu" })).resolves.toMatchObject({ ok: true });
    expect(request?.input).toMatchObject({ frameLane: "gpu" });
    await expect(sdk.render({ ...renderInput, frameLane: "gpu", segmented: { segmentFrames: 120, resume: true } })).resolves.toMatchObject({ ok: true });
    expect(request?.input).toMatchObject({ frameLane: "gpu", segmented: { segmentFrames: 120, resume: true } });
    await expect(sdk.render({ ...renderInput, frameLane: "gpu", keepFrames: true })).resolves.toMatchObject({
      ok: false, error: { code: "invalid_request", message: expect.stringContaining("strict streamed FFmpeg path") }
    });
    await expect(sdk.render({ ...renderInput, frameLane: "gpu", reuseAttested: true })).resolves.toMatchObject({
      ok: false, error: { code: "invalid_request", message: expect.stringContaining("post-render identity is evidence only") }
    });
    await expect(sdk.render({ ...renderInput, frameLane: "gpu", idempotencyKey: "a".repeat(64) })).resolves.toMatchObject({
      ok: false, error: { code: "invalid_request", message: expect.stringContaining("post-render identity is evidence only") }
    });
    await expect(sdk.render({ ...renderInput, frameLane: "gpu", segmented: { segmentFrames: 120 }, workflowPath: "/workflow.json" })).resolves.toMatchObject({
      ok: false, error: { code: "invalid_request", message: expect.stringContaining("does not support browser workflows") }
    });
    await expect(sdk.render({ ...renderInput, frameLane: "gpu", segmented: { segmentFrames: 120 }, qualityManifestPath: "/quality.json" })).resolves.toMatchObject({
      ok: false, error: { code: "invalid_request", message: expect.stringContaining("does not support exact-source quality manifests") }
    });
  });

  it("refuses a post-render GPU identity on a non-GPU response before exposing it to the SDK caller", async () => {
    const result = await createMotionSdk(renderTransport({ gpuPostRenderReuse: { schema: "shellx-motion/gpu-post-render-reuse-identity@1" } })).render(renderInput);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_transport_response", message: expect.stringContaining("GPU post-render reuse identity") } });
  });

  it("refuses a direct GPU post-render identity on a durable segmented response", async () => {
    const result = await createMotionSdk(renderTransport({ gpuPostRenderReuse: { schema: "shellx-motion/gpu-post-render-reuse-identity@1" } }))
      .render({ ...renderInput, frameLane: "gpu", segmented: { segmentFrames: 120 } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_transport_response", message: expect.stringContaining("GPU post-render reuse identity") } });
  });

  it("forwards only the closed segmented selector and refuses incompatible render controls", async () => {
    let request: MotionSdkTransportRequest | undefined;
    const sdk = createMotionSdk({
      async execute<K extends MotionSdkOperation>(input: MotionSdkTransportRequest<K>) {
        request = input;
        return renderEnvelope(input, {}) as never;
      }
    });
    await expect(sdk.render({ ...renderInput, segmented: { segmentFrames: 120, resume: true } })).resolves.toMatchObject({ ok: true });
    expect(request?.input).toMatchObject({ segmented: { segmentFrames: 120, resume: true } });
    for (const [field, value] of [
      ["browserLocation", "/caller/browser"],
      ["browserSessionFactory", "caller-factory"],
      ["openVideoProvider", "caller-provider"],
      ["providerFactory", "caller-provider-factory"],
      ["openHybridCapture", "caller-capture"],
      ["hybridCapture", { source: "caller-controlled" }],
      ["capturePlan", { range: 0 }]
    ] as const) {
      await expect(sdk.render({
        ...renderInput,
        frameLane: "gpu",
        segmented: { segmentFrames: 120, resume: true },
        [field]: value
      } as never)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: `SDK render input contains unsupported field ${field}.` }
      });
    }
    expect(await sdk.render({ ...renderInput, segmented: { segmentFrames: 0 } })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("segmented") } });
    expect(await sdk.render({ ...renderInput, segmented: { segmentFrames: 120 }, keepFrames: true })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("does not accept keepFrames") } });
    expect(await sdk.render({ ...renderInput, segmented: { segmentFrames: 120 }, workflowPath: "/workflow.json" })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("does not support browser workflows") } });
  });
});

function renderTransport(extra: Record<string, unknown>): MotionSdkTransport {
  return {
    async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
      return renderEnvelope(request, extra) as never;
    }
  };
}

function renderEnvelope(request: MotionSdkTransportRequest, extra: Record<string, unknown>) {
  return {
    schema: request.schema,
    operation: request.operation,
    requestId: request.requestId,
    cacheKey: request.cacheKey,
    ok: true,
    output: {
      jobId: "render-1",
      state: "succeeded",
      packageId: "pkg_sdk",
      motionId: "motion_sdk",
      preset: "webm-vp9",
      outputPath: "/motion/out/final.webm",
      receiptId: "render-receipt-1",
      warnings: [],
      ...extra
    }
  };
}
