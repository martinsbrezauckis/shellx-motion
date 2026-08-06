import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { comparePngBuffers, inspectPngBuffer, loadMotionPackage } from "@shellx-motion/core";
import { createMotionBrowserRenderSession } from "./index";

const tempDirs: string[] = [];

describe("typed compositing render equivalence", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders a raw graph pixel-identically to its direct MotionIR layer stack", async () => {
    const graphPackage = await loadMotionPackage(resolve("../../fixtures/packages/compositing-graph-parity"));
    const directPackage = await loadMotionPackage(resolve("../../fixtures/packages/compositing-direct-parity"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-compositing-parity-"));
    tempDirs.push(outDir);
    const graphSession = await createMotionBrowserRenderSession(graphPackage);
    const directSession = await createMotionBrowserRenderSession(directPackage);

    try {
      for (const atMs of [0, 500, 900]) {
        const graphFrame = await graphSession.renderFrame({
          atMs,
          outDir,
          outputPath: join(outDir, `graph-${atMs}.png`),
        });
        const directFrame = await directSession.renderFrame({
          atMs,
          outDir,
          outputPath: join(outDir, `direct-${atMs}.png`),
        });
        const graphPng = await readFile(graphFrame.output.path);
        const directPng = await readFile(directFrame.output.path);
        const difference = comparePngBuffers(graphPng, directPng);
        const quality = inspectPngBuffer(graphPng);

        expect(difference).toMatchObject({ ok: true, changedPixels: 0, maxChannelDelta: 0 });
        expect(quality).toMatchObject({ ok: true, blank: false });
        expect(graphFrame.receipt.warnings).toEqual([]);
      }
    } finally {
      await Promise.all([graphSession.close(), directSession.close()]);
    }
  }, 45_000);
});
