import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runCanvasMp4Export } from "./canvas-to-mp4";
import { shapeTextFrameSelection } from "./canvas-to-mp4.test-support";
import { successfulStreamingRenderer } from "./streaming-final.test-support";

it.runIf(process.platform === "linux")("refuses a render-receipt symlink planted after output admission", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-receipt-race-"));
  try {
    const selectionPath = join(outDir, "frame-selection.json");
    const sentinelPath = join(outDir, "sentinel.json");
    const render = successfulStreamingRenderer("late receipt symlink");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    await writeFile(sentinelPath, "preserve sentinel", "utf8");

    await expect(runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: async (input) => {
        const receiptDir = join(outDir, "receipts");
        await mkdir(receiptDir, { recursive: true, mode: 0o700 });
        await symlink(sentinelPath, join(receiptDir, "ffmpeg-render.receipt.json"));
        return await render(input);
      }
    })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("preserve sentinel");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
