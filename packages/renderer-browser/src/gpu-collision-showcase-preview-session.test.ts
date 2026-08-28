import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLISION_SHOWCASE_RECIPE_SCHEMA,
  type BingoCollisionShowcaseRecipe,
} from "@shellx-motion/core/internal/collision-showcase";
import { describe, expect, it } from "vitest";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import { createGpuCollisionShowcasePreviewSession } from "./unadopted/gpu-collision-showcase-preview-session";

const bingo = (): BingoCollisionShowcaseRecipe => ({
  schema: COLLISION_SHOWCASE_RECIPE_SCHEMA, kind: "bingo-sphere-3d@1", seed: 2_975_908_062,
  speed: 3.4, gravity: -1.1, restitution: 0.92, cageRadius: 2.2, ballRadius: 0.28,
  selectedBallId: "bingo-ball-07", mixingFrame: 6, selectedFrame: 46,
});

describe("private retained C6G GPU preview session", () => {
  it("owns all 151 exact 30 fps timestamps while retaining one Core wrapper and one runtime", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-c6g-retained-")));
    let opens = 0, renders = 0, closes = 0;
    try {
      const session = createGpuCollisionShowcasePreviewSession(bingo(), {
        packageRoot: root,
        sessionOptions: { openRuntime: async () => { opens += 1; return fakeRuntime(() => { renders += 1; }, () => { closes += 1; }); } },
      });
      expect(session.identity).toMatchObject({ kind: "bingo-sphere-3d@1", bakeFrameCount: 61, frameCount: 151, frameRate: 30, planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const staticHashes = new Set<string>(), frameHashes = new Set<string>();
      let finalCleanup: unknown;
      for (let index = 0; index < 151; index += 1) {
        const result = await session.renderNext({ outDir: root, outputPath: join(root, `frame-${String(index).padStart(3, "0")}.png`) });
        expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
        expect(result.schedule).toMatchObject({ frameIndex: index, final: index === 150 });
        if (index === 5) expect(result.schedule).toMatchObject({ atUs: 166_666, bakeFrameBeforeIndex: 2, bakeFrameAfterIndex: 2 });
        if (index === 115) expect(result.schedule).toMatchObject({ atUs: 3_833_333, phase: "selected", bakeFrameBeforeIndex: 46, bakeFrameAfterIndex: 46 });
        if (!result.ok) continue;
        staticHashes.add(result.receipt.inputHashes["gpu-scene3d-animation-static-plan"]!);
        frameHashes.add(result.receipt.inputHashes["gpu-scene3d-animation-frame-plan"]!);
        finalCleanup = result.schedule.cleanup;
      }
      expect({ opens, renders, closes, staticHashes: staticHashes.size, frameHashes: frameHashes.size }).toEqual({ opens: 1, renders: 151, closes: 1, staticHashes: 1, frameHashes: 151 });
      expect(finalCleanup).toMatchObject({ closed: true, completedFrames: 151, expectedFrames: 151, scheduleComplete: true, gpu: { closed: true, scene3dAnimation: { staticWrapperCompilations: 1, framePlanCompilations: 151 } } });
      await expect(session.renderNext({ outDir: root, outputPath: join(root, "frame-151.png") })).resolves.toMatchObject({ ok: false, error: { code: "gpu_collision_preview_closed" } });
      await expect(session.close()).resolves.toEqual(finalCleanup);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);

  it("refuses noncanonical package roots and expanded recipes before a session opens", () => {
    expect(() => createGpuCollisionShowcasePreviewSession(bingo(), { packageRoot: "relative" })).toThrow("canonical absolute package root");
    expect(() => createGpuCollisionShowcasePreviewSession({ ...bingo(), command: "run" } as never, { packageRoot: "/tmp" })).toThrow("unknown field 'command'");
  });
});

function fakeRuntime(onRender: () => void, onClose: () => void): GpuFrameRenderSessionOpenResult {
  return { ok: true, session: {
    browserProcess: { pid: 6_061, launcher: "playwright-launch-server", containment: null },
    async uploadImages(images) { return { ok: true, uploaded: images.length }; },
    async render() { onRender(); const rgba = Buffer.alloc(16, 255); return { ok: true, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: 2, height: 2, evidence: evidence() } }; },
    async close() { onClose(); },
  } };
}

function evidence(): GpuRuntimeEvidence {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "available", adapterFingerprint: "a".repeat(64),
    adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 64 * 1024 * 1024, maxStorageBufferBindingSize: 64 * 1024 * 1024 },
  };
}
