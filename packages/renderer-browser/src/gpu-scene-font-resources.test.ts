import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { prepareGpuSceneFontResources } from "./gpu-scene-font-resources";

describe("prepareGpuSceneFontResources", () => {
  it("takes one exact font snapshot and binds the requested manifest family", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-fonts-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const bytes = Buffer.from("bounded-font-fixture"); await writeFile(join(root, "assets", "brand.woff2"), bytes, { mode: 0o600 });
    const prepared = await prepareGpuSceneFontResources(pkg(root));
    expect(prepared.fonts.get("brand sans")?.[0]).toMatchObject({ family: "Brand Sans", weight: 700, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(prepared.sessionFonts[0]).toMatchObject({ family: "Brand Sans", bytes });
    expect(prepared.inputHashes["assets/brand.woff2"]).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("refuses a linked manifest font before browser registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-font-link-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const outside = join(root, "outside.woff2"); await writeFile(outside, "outside", { mode: 0o600 }); await symlink(outside, join(root, "assets", "brand.woff2"));
    await expect(prepareGpuSceneFontResources(pkg(root))).rejects.toThrow();
  });

  it("refuses host-font fallback when a visible text family is not manifest-bound", async () => {
    const packageValue = pkg("/private/not-read"); packageValue.motion.assets = []; packageValue.manifest.assets = [];
    await expect(prepareGpuSceneFontResources(packageValue)).rejects.toThrow("not backed by a manifest font asset");
  });
});

function pkg(root: string): MotionPackage {
  return {
    root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_font", name: "GPU font", motion: "motion.json", assets: ["assets/brand.woff2"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_font", name: "GPU font", durationMs: 1_000, fps: 30, width: 128, height: 64, assets: [{ id: "brand", type: "font", family: "Brand Sans", source: { path: "assets/brand.woff2", mimeType: "font/woff2" }, weight: 700 }], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "title", type: "text", text: "Brand", startMs: 0, durationMs: 1_000, transform: { width: 128, height: 64 }, style: { fontFamily: "Brand Sans", fontSize: 32, fontWeight: 700 } }] }
  };
}
