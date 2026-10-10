import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { runCanvasMp4Export } from "./canvas-to-mp4";
import { successfulStreamingRenderer } from "./streaming-final.test-support";
import { createOwnerPrivateTempRoots } from "./owner-private-temp-roots.test-support";

const roots = createOwnerPrivateTempRoots();
afterEach(async () => await roots.cleanup());

describe.runIf(process.platform === "linux")("streaming connector adoption", () => {
  it("retains Canvas MP4's independent streamed-final adoption without retaining frames", async ({ skip }) => {
    const rootFacts = await lstat("/");
    if (typeof process.getuid === "function" && rootFacts.uid !== process.getuid() && rootFacts.uid !== 0) {
      skip("Managed / is owned by UID 65534, so the artifact publisher's POSIX parent guard correctly refuses this real producer test.");
      return;
    }
    const root = await roots.create("streaming-canvas-mp4");
    const inputDir = join(root, "input"), canvasSelectionPath = join(inputDir, "shape-text-frame-selection.json");
    await mkdir(inputDir, { recursive: true, mode: 0o700 });
    await writeFile(canvasSelectionPath, await readFile(resolve("../../fixtures/canvas/shape-text-frame-selection.json")));
    const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await runCanvasMp4Export({
      canvasSelectionPath,
      outDir: join(root, "canvas-mp4"), dryRunRender: false,
      streamingRenderer: successfulStreamingRenderer("canvas mp4"), now: () => "2026-08-08T00:00:00.000Z"
    }));
    expect(result.render).toMatchObject({ ok: true, dryRun: false, lane: "ffmpeg", frameLane: "browser" });
    await expect(stat(join(result.packageDir, "..", "frames"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
