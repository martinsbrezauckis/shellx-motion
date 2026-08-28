import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION_SDK_SCHEMA, motionSdkCacheKey, type MotionSdkOperation, type MotionSdkTransport } from "@shellx-motion/sdk";
import { createOperatorReceiptGrants, createOperatorRenderGrants } from "./operator-receipt-grants.js";
import { runSdkRequest, type SdkRouteSecurity } from "./sdk-route.js";

async function request(operation: MotionSdkOperation, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cacheKey = await motionSdkCacheKey(operation, input);
  return {
    schema: MOTION_SDK_SCHEMA,
    operation,
    requestId: `sdk-${operation}-${cacheKey.slice(0, 20)}`,
    cacheKey,
    input
  };
}

describe("SDK render filesystem boundary", () => {
  it("uses host render roots for package reads, preview writes, and cache-plan paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-route-roots-"));
    const packageRoot = join(root, "packages", "approved");
    const foreignPackage = join(root, "packages", "foreign");
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const scratchRoot = join(root, "scratch");
    const outsideRoot = join(root, "outside");
    await Promise.all([
      mkdir(packageRoot, { recursive: true, mode: 0o700 }),
      mkdir(foreignPackage, { recursive: true, mode: 0o700 }),
      mkdir(inputRoot, { recursive: true, mode: 0o700 }),
      mkdir(outputRoot, { recursive: true, mode: 0o700 }),
      mkdir(scratchRoot, { recursive: true, mode: 0o700 }),
      mkdir(outsideRoot, { recursive: true, mode: 0o700 })
    ]);
    const foreignWorkflow = join(outsideRoot, "workflow.json");
    const approvedWorkflow = join(inputRoot, "workflow.json");
    const packageWorkflow = join(packageRoot, "workflow.json");
    const scratchWorkflow = join(scratchRoot, "workflow.json");
    await writeFile(foreignWorkflow, "{}", { mode: 0o600 });
    await writeFile(approvedWorkflow, "{}", { mode: 0o600 });
    await writeFile(packageWorkflow, "{}", { mode: 0o600 });
    await writeFile(scratchWorkflow, "{}", { mode: 0o600 });
    const executeCalls: MotionSdkOperation[] = [];
    const sdkTransport: MotionSdkTransport = {
      execute: async (sdkRequest) => {
        executeCalls.push(sdkRequest.operation);
        return {
          schema: MOTION_SDK_SCHEMA,
          operation: sdkRequest.operation,
          requestId: sdkRequest.requestId,
          cacheKey: sdkRequest.cacheKey,
          ok: true,
          output: { admitted: true }
        } as never;
      }
    };
    const security: SdkRouteSecurity = {
      grantedTier: "render_motion",
      sdkTransport,
      context: {
        renderPackageRoots: [packageRoot],
        renderInputRoots: [inputRoot],
        renderOutputRoots: [outputRoot],
        scratchRoot
      },
      operatorReceiptRoots: createOperatorReceiptGrants(),
      operatorRenderGrants: createOperatorRenderGrants(),
      artifactRoots: []
    };

    try {
      const admitted = await runSdkRequest(await request("validate", { packageRoot }), security);
      expect(admitted.status).toBe(200);
      expect(executeCalls).toEqual(["validate"]);

      const admittedPreview = await runSdkRequest(await request("preview", {
        packageRoot,
        outDir: join(outputRoot, "preview"),
        lane: "browser",
        workflowPath: approvedWorkflow
      }), security);
      expect(admittedPreview.status).toBe(200);

      for (const workflowPath of [packageWorkflow, scratchWorkflow]) {
        const hostOwnedPreview = await runSdkRequest(await request("preview", {
          packageRoot,
          outDir: join(outputRoot, "preview"),
          lane: "browser",
          workflowPath
        }), security);
        expect(hostOwnedPreview.status).toBe(200);
      }

      const admittedCachePlan = await runSdkRequest(await request("renderCachePlan", {
        packageRoot,
        outputPath: join(outputRoot, "result.mp4"),
        preset: "mp4-h264",
        workflowPath: approvedWorkflow
      }), security);
      expect(admittedCachePlan.status).toBe(200);

      const packageRefusal = await runSdkRequest(await request("validate", { packageRoot: foreignPackage }), security);
      expect(packageRefusal).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

      const previewRefusal = await runSdkRequest(await request("preview", {
        packageRoot,
        outDir: join(outsideRoot, "preview")
      }), security);
      expect(previewRefusal).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

      const previewInputRefusal = await runSdkRequest(await request("preview", {
        packageRoot,
        outDir: join(outputRoot, "preview"),
        lane: "browser",
        workflowPath: foreignWorkflow
      }), security);
      expect(previewInputRefusal).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

      const cacheOutputRefusal = await runSdkRequest(await request("renderCachePlan", {
        packageRoot,
        outputPath: join(outsideRoot, "result.mp4"),
        preset: "mp4-h264"
      }), security);
      expect(cacheOutputRefusal).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

      const cacheInputRefusal = await runSdkRequest(await request("renderCachePlan", {
        packageRoot,
        outputPath: join(outputRoot, "result.mp4"),
        preset: "mp4-h264",
        workflowPath: foreignWorkflow
      }), security);
      expect(cacheInputRefusal).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });
      expect(executeCalls).toEqual(["validate", "preview", "preview", "preview", "renderCachePlan"]);
      await expect(rm(join(outsideRoot, "preview"), { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });
      await expect(rm(join(outsideRoot, "result.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fences trackingRequest package input and package output before the SDK sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-route-tracking-"));
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const foreignRoot = join(root, "foreign");
    const packageRoot = join(inputRoot, "package");
    const foreignPackage = join(foreignRoot, "package");
    const executeCalls: MotionSdkOperation[] = [];
    const sdkTransport: MotionSdkTransport = {
      execute: async (sdkRequest) => {
        executeCalls.push(sdkRequest.operation);
        return {
          schema: MOTION_SDK_SCHEMA,
          operation: sdkRequest.operation,
          requestId: sdkRequest.requestId,
          cacheKey: sdkRequest.cacheKey,
          ok: true,
          output: { admitted: true }
        } as never;
      }
    };
    const security: SdkRouteSecurity = {
      grantedTier: "write_local",
      sdkTransport,
      context: { authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] },
      operatorReceiptRoots: createOperatorReceiptGrants(),
      operatorRenderGrants: createOperatorRenderGrants(),
      artifactRoots: []
    };
    const trackingInput = (inputPackageRoot: string, outDir: string) => ({
      packageRoot: inputPackageRoot,
      outDir,
      analysisId: "track-1",
      assetId: "plate",
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 10, y: 20, width: 40, height: 30 }, points: [{ x: 30, y: 35 }] },
      settings: {
        startMs: 0,
        endMs: 200,
        stepMs: 100,
        direction: "forward",
        searchRadiusPx: 8,
        pyramidLevels: 2,
        maxIterations: 20,
        confidenceFloor: 0.7,
        deterministicSeed: 7
      }
    });

    try {
      await Promise.all([
        mkdir(packageRoot, { recursive: true, mode: 0o700 }),
        mkdir(foreignPackage, { recursive: true, mode: 0o700 }),
        mkdir(outputRoot, { recursive: true, mode: 0o700 })
      ]);

      const inputRefusal = await runSdkRequest(
        await request("trackingRequest", trackingInput(foreignPackage, join(outputRoot, "result"))),
        security
      );
      expect(inputRefusal).toMatchObject({ status: 403, body: { error: { code: "authoring_path_not_approved" } } });
      expect(executeCalls).toEqual([]);

      const outputRefusal = await runSdkRequest(
        await request("trackingRequest", trackingInput(packageRoot, join(foreignRoot, "result"))),
        security
      );
      expect(outputRefusal).toMatchObject({ status: 403, body: { error: { code: "authoring_path_not_approved" } } });
      expect(executeCalls).toEqual([]);

      const admitted = await runSdkRequest(
        await request("trackingRequest", trackingInput(packageRoot, join(outputRoot, "result"))),
        security
      );
      expect(admitted.status).toBe(200);
      expect(executeCalls).toEqual(["trackingRequest"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
