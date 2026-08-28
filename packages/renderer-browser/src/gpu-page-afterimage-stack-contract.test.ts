import { canonicalJsonSha256, gpuEffectModuleRendererIdentityProblem, gpuEffectModuleResourceCeilingFingerprint } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import {
  GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_CATALOG,
  GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256,
  GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY,
  GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256,
  GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION,
  GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION_SHA256
} from "./gpu-page-afterimage-stack-contract";

describe("afterimage-stack current Browser implementation identity", () => {
  it("binds the fixed installer, preparation, renderer, close lifecycle, and separate reservation evidence", () => {
    expect(GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_CATALOG.entries.map((entry) => entry.id)).toEqual([
      "page.afterimage-stack.close",
      "page.afterimage-stack.frame",
      "page.afterimage-stack.install",
      "page.afterimage-stack.metrics",
      "page.afterimage-stack.prepare",
      "page.afterimage-stack.render"
    ]);
    expect(GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_CATALOG.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256).toBe(canonicalJsonSha256({
      schema: "shellx-motion/gpu-afterimage-stack-implementation@1",
      intrinsic: "motion.afterimage-stack.v1",
      rendererAbi: "shellx-motion/gpu-effect-module@1",
      parameterSchema: "motion.afterimage-stack.parameters@1",
      pageCatalogSha256: GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_CATALOG.sha256
    }));
    expect(gpuEffectModuleRendererIdentityProblem(GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY)).toBeNull();
    expect(GPU_PAGE_AFTERIMAGE_STACK_RENDERER_IDENTITY.pipelineImplementationSha256).toBe(GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256);
    expect(GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256).toBe(gpuEffectModuleResourceCeilingFingerprint());
    expect(GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION).toEqual({
      schema: "shellx-motion/gpu-afterimage-stack-session-reservation@1",
      uniformBytes: 160,
      preReservedUniformBufferCount: 1,
      preReservedBindGroupCount: 1,
      persistentTextureCount: 0,
      passCount: 1,
      maxTextureLoadsPerPixel: 5
    });
    expect(GPU_PAGE_AFTERIMAGE_STACK_SESSION_RESOURCE_RESERVATION_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });
});
