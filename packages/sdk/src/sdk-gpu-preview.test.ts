import { describe, expect, it } from "vitest";
import { createMotionSdk } from "./client";
import { MOTION_SDK_SCHEMA, type MotionSdkTransport, type MotionSdkTransportRequest } from "./types";

describe("SDK GPU preview", () => {
  it("transports the explicit lane and rejects invented lanes", async () => {
    const seen: MotionSdkTransportRequest[] = [];
    const transport: MotionSdkTransport = { async execute(request) {
      seen.push(request);
      return {
        schema: MOTION_SDK_SCHEMA, operation: request.operation, requestId: request.requestId, cacheKey: request.cacheKey, ok: true,
        output: { packageId: "pkg_gpu", motionId: "motion_gpu", lane: "gpu", receiptId: "preview-gpu", warnings: [], frame: { path: "/preview.png", sha256: "a".repeat(64), width: 32, height: 32, atMs: 0, mediaType: "image/png" } }
      } as never;
    } };
    const sdk = createMotionSdk(transport);
    await expect(sdk.preview({ packageRoot: "/motion/pkg", outDir: "/motion/preview", lane: "gpu" })).resolves.toMatchObject({ ok: true, output: { lane: "gpu" } });
    expect(seen[0]).toMatchObject({ operation: "preview", input: { lane: "gpu" } });
    await expect(sdk.preview({ packageRoot: "/motion/pkg", outDir: "/motion/preview", lane: "imaginary" as never })).resolves.toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK preview lane must be browser or gpu." } });
  });
});
