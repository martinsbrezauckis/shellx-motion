import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { renderStreamingFinal } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streaming final admission", () => {
  it("refuses odd H.264 geometry before output publication or encoder/producer admission", async () => {
    const root = await packageRoot();
    const outputPath = join(root, "odd.mp4");
    const loaded = await loadMotionPackage(root);
    let processStarts = 0;
    const result = await renderStreamingFinal({
      pkg: { ...loaded, motion: { ...loaded.motion, width: 1_919 } }, frameLane: "native", outputPath,
      inputRoots: [root], outputRoots: [root],
      toolPolicy: { processFactory: async () => {
        processStarts += 1;
        throw new Error("odd geometry must refuse before an encoder starts");
      } }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "h264_dimensions_invalid" } });
    expect(processStarts).toBe(0);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-streaming-admission-"));
  tempDirs.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_odd_h264", name: "odd h264", motion: "motion.json", assets: [],
    sourceApp: "shellx-motion", compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
  })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_odd_h264", name: "odd h264", durationMs: 1_000, fps: 1, width: 16, height: 16,
    background: "#061a2c", layers: [{ id: "background", type: "shape", shape: "rect", fill: "#061a2c", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 } }], assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  })}\n`);
  return root;
}
