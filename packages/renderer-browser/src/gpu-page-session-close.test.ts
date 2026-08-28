import { describe, expect, it } from "vitest";
import { closeWebGpuPageSession } from "./gpu-page-session-close";

describe("GPU page-session close", () => {
  it("keeps the byte-stable closer free of module cleanup evidence", async () => {
    const saved = (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1;
    (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = {
      resources: { destroy: () => ({ afterimageStackUniformBufferDestructions: 0 as const }) },
      images: new Map(), textSurfaces: new Map(), device: { destroy() {} }
    };
    try {
      await expect(closeWebGpuPageSession()).resolves.toEqual({ dynamicImageTextureDestructions: 0 });
    } finally {
      (globalThis as { __shellxMotionGpuSessionV1?: unknown }).__shellxMotionGpuSessionV1 = saved;
    }
  });
});
