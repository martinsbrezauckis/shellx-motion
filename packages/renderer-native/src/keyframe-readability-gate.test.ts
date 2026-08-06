/**
 * The render half of the silent-keyframe-drop fix.
 *
 * Refusing at `motion.package.validate` is not enough on its own: nothing on the render path calls
 * validate, which is exactly how a package carrying 309 unreadable keyframes reached a "successful"
 * 15-second render that was frozen for ~90% of its duration. So the lane refuses at session open,
 * beside its existing capability and frame-budget gates, using core's verdict.
 *
 * Both directions are pinned: the broken package is refused with the correct form named, and a
 * correctly keyframed package still opens a session and writes a frame with no new noise.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeRenderSession, renderNativePreviewFrame } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A one-shape package whose keyframe map is written verbatim, valid or not. */
async function writeKeyframedPackage(keyframes: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-native-keyframe-gate-"));
  tempDirs.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_native_keyframe_gate",
    name: "Native Keyframe Gate",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_native_keyframe_gate",
    name: "Native Keyframe Gate",
    durationMs: 400,
    fps: 10,
    width: 96,
    height: 48,
    background: "#000000",
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [{
      id: "panel",
      type: "shape",
      shape: "rectangle",
      fill: "#13d3ff",
      startMs: 0,
      durationMs: 400,
      width: 40,
      height: 20,
      transform: { x: 4, y: 4 },
      keyframes
    }]
  }, null, 2)}\n`);
  return root;
}

describe("native lane keyframe readability gate", () => {
  it("refuses to render a package whose keyframes the evaluator would silently drop", async () => {
    // The exact shape the external agent produced.
    const packageRoot = await writeKeyframedPackage({
      opacity: [{ t: 0, v: 0 }, { t: 200, v: 1 }],
      "transform.x": [{ t: 0, v: 4 }, { t: 200, v: 60 }]
    });

    await expect(createNativeRenderSession({ packageRoot })).rejects.toThrow(
      /4 of 4 keyframes cannot be read by the timeline evaluator/
    );
    // The refusal has to name the correct form, or the author cannot act on it.
    await expect(createNativeRenderSession({ packageRoot })).rejects.toThrow(/"atMs": <milliseconds>/);
  });

  it("refuses a single-frame preview for the same reason, not only a full render", async () => {
    const packageRoot = await writeKeyframedPackage({ opacity: [{ t: 0, v: 0 }, { t: 200, v: 1 }] });
    const outputPath = join(packageRoot, "frame.png");

    await expect(renderNativePreviewFrame({ packageRoot, atMs: 0, outputPath, outputRoots: [packageRoot] }))
      .rejects.toThrow(/cannot be read by the timeline evaluator/);
  });

  it("refuses when only one keyframe on one track is unreadable", async () => {
    const packageRoot = await writeKeyframedPackage({
      "transform.x": [{ atMs: 0, value: 4 }, { atMs: 200 }, { atMs: 400, value: 60 }]
    });

    await expect(createNativeRenderSession({ packageRoot }))
      .rejects.toThrow(/1 of 3 keyframes cannot be read/);
  });

  it("renders a correctly keyframed package exactly as before, with no new refusal", async () => {
    const packageRoot = await writeKeyframedPackage({
      opacity: [{ atMs: 0, value: 0 }, { atMs: 200, value: 1 }],
      "transform.x": [{ atMs: 0, value: 4 }, { atMs: 200, value: 60, easing: "ease-out" }]
    });
    const outputPath = join(packageRoot, "frame.png");

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 100, outputPath, outputRoots: [packageRoot] });

    expect(result.receipt.status).toBe("passed");
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });

  it("renders a package with no keyframes at all", async () => {
    const packageRoot = await writeKeyframedPackage({});
    const outputPath = join(packageRoot, "frame.png");

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, outputPath, outputRoots: [packageRoot] });

    expect(result.receipt.status).toBe("passed");
  });
});
