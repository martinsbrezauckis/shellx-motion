import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import type { BrowserFrameResult } from "@shellx-motion/renderer-browser";
import { dispatchRenderPreviewBasicCommand } from "./render-preview-basic";

const pkg = {
  root: "/trusted/package",
  manifest: {
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_preview",
    name: "Preview",
    motion: "motion.json",
    assets: [],
    sourceApp: "test",
    compatibility: { lanes: [], hosts: [] }
  },
  motion: {
    schema: "shellx-motion/motion@1",
    id: "motion_preview",
    name: "Preview",
    durationMs: 100,
    fps: 30,
    width: 32,
    height: 32,
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    layers: []
  }
} as unknown as MotionPackage;

function resultFor(path: string): BrowserFrameResult {
  return {
    ok: true,
    output: {
      path,
      sha256: "a".repeat(64),
      width: 32,
      height: 32,
      atMs: 0,
      browser: { name: "chromium", version: "test" },
      viewport: { width: 32, height: 32, deviceScaleFactor: 1 }
    },
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: `preview-${path}`,
      operation: "preview.frame",
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes: {},
      createdAt: "2026-08-11T00:00:00.000Z",
      lane: "browser",
      output: { path },
      warnings: []
    }
  };
}

describe("motion.preview.frame output ownership", () => {
  it("allocates a fresh host-owned output path for each implicit preview", async () => {
    const paths: string[] = [];
    const services = {
      scratchRoot: "/trusted/scratch",
      packageLoader: async () => pkg,
      browserFrameRenderer: async (_pkg: MotionPackage, options: { outputPath?: string }) => {
        paths.push(options.outputPath ?? "");
        return resultFor(options.outputPath ?? "");
      }
    };

    expect((await dispatchRenderPreviewBasicCommand("motion.preview.frame", { packageRoot: pkg.root, atMs: 0 }, services))?.ok).toBe(true);
    expect((await dispatchRenderPreviewBasicCommand("motion.preview.frame", { packageRoot: pkg.root, atMs: 0 }, services))?.ok).toBe(true);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^\/trusted\/scratch\/preview-[0-9a-f-]+\.png$/);
    expect(paths[1]).toMatch(/^\/trusted\/scratch\/preview-[0-9a-f-]+\.png$/);
    expect(paths[1]).not.toBe(paths[0]);
  });

  it("preserves an explicit caller-owned output path", async () => {
    let observed = "";
    const outputPath = "/trusted/scratch/explicit.png";
    const result = await dispatchRenderPreviewBasicCommand("motion.preview.frame", {
      packageRoot: pkg.root,
      outputPath
    }, {
      scratchRoot: "/trusted/scratch",
      packageLoader: async () => pkg,
      browserFrameRenderer: async (_pkg, options) => {
        observed = options.outputPath ?? "";
        return resultFor(observed);
      }
    });

    expect(result?.ok).toBe(true);
    expect(observed).toBe(outputPath);
  });
});
