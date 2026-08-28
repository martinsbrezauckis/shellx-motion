import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCanvasMp4Export } from "./canvas-to-mp4";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform !== "linux")("Canvas-to-MP4 platform refusal", () => {
  it("refuses closed-tree package publication before creating connector output state", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-platform-refusal-"));
    roots.push(root);
    const outDir = join(root, "out");

    await expect(runCanvasMp4Export({
      canvasSelectionPath: resolve("../../fixtures/canvas/shape-text-frame-selection.json"),
      outDir,
      dryRunRender: true,
    })).rejects.toThrow("requires a Linux descriptor-relative primitive");
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
