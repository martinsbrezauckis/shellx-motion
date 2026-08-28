import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStreamingFinal } from "./streaming-final-adapter.js";

describe("private HDR10 direct-final marker precedence", () => {
  it("refuses generic final before output publication or a renderer route", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-hdr10-marker-")), outputPath = join(root, "out.mp4");
    try {
      const result = await renderStreamingFinal({ pkg: { root, manifest: { id: "pkg_hdr10", data: { adapter: { scene3dGltfPbrHdr10Final: { schema: "shellx-motion/scene3d-gltf-pbr-hdr10-final-locator@1", sceneLayerId: "scene" } } } }, motion: { fps: 30, width: 1280, height: 720, durationMs: 3_000 } } as never, frameLane: "native", outputPath });
      expect(result).toMatchObject({ ok: false, error: { code: "gltf_pbr_hdr10_private_direct_final_only" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
