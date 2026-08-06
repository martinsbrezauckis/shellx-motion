/**
 * End-to-end local adapter tests for typed SDK keyframe edits (range transforms and distribution).
 *
 * Role: the keyframe-edit slice of the local Motion SDK suite — receipt-backed range transforms and
 * one-shot keyframe distribution through the atomic typed edit path. Split verbatim out of `local.test.ts`
 * so that file stays under the module-size gate. Each test builds its own package and drives the real
 * local SDK; this file owns its own temp-dir registry and afterEach cleanup (standard per-file setup).
 *
 * Dependencies: node fs/os/path built-ins and `createLocalMotionSdk` from `./local`.
 *
 * Primary callers: run by vitest as part of the `@shellx-motion/sdk` suite.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";

const tempDirs: string[] = [];

describe("local Motion SDK keyframe edits", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("applies receipt-backed range transforms for visible multi-keyframe editors", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-keyframe-range-"));
    tempDirs.push(root);
    const sdk = createLocalMotionSdk();
    const source = resolve("../../fixtures/packages/editable-lower-third");
    const firstDir = join(root, "first");
    const first = await sdk.timelineEdit({
      packageRoot: source,
      outDir: firstDir,
      edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 100, value: 0.2 },
    });
    expect(first.ok).toBe(true);
    const secondDir = join(root, "second");
    const second = await sdk.timelineEdit({
      packageRoot: firstDir,
      outDir: secondDir,
      edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 300, value: 0.8 },
    });
    expect(second.ok).toBe(true);

    const shiftedDir = join(root, "shifted");
    const shifted = await sdk.timelineEdit({
      packageRoot: secondDir,
      outDir: shiftedDir,
      edit: { kind: "keyframe.shift", layerId: "title", target: "opacity", deltaMs: 50, startMs: 100, endMs: 300 },
    });
    expect(shifted).toMatchObject({
      ok: true,
      output: {
        edit: { kind: "keyframe.shift", deltaMs: 50, startMs: 100, endMs: 300 },
        receipt: { operation: "timeline.keyframe.shift", status: "passed" },
      },
    });

    const reversedDir = join(root, "reversed");
    const reversed = await sdk.timelineEdit({
      packageRoot: shiftedDir,
      outDir: reversedDir,
      edit: { kind: "keyframe.reverse", layerId: "title", target: "opacity", startMs: 150, endMs: 350 },
    });
    expect(reversed).toMatchObject({
      ok: true,
      output: { receipt: { operation: "timeline.keyframe.reverse", status: "passed" } },
    });
    const duplicatedDir = join(root, "duplicated");
    const duplicated = await sdk.timelineEdit({
      packageRoot: reversedDir,
      outDir: duplicatedDir,
      edit: { kind: "keyframe.duplicate", layerId: "title", target: "opacity", deltaMs: 500, startMs: 150, endMs: 350 },
    });
    expect(duplicated).toMatchObject({ ok: true, output: { receipt: { operation: "timeline.keyframe.duplicate" } } });

    const scaledDir = join(root, "scaled");
    const scaled = await sdk.timelineEdit({
      packageRoot: duplicatedDir,
      outDir: scaledDir,
      edit: { kind: "keyframe.scale", layerId: "title", target: "opacity", scale: 0.5, originMs: 650, startMs: 650, endMs: 850 },
    });
    expect(scaled).toMatchObject({ ok: true, output: { receipt: { operation: "timeline.keyframe.scale" } } });

    const snappedDir = join(root, "snapped");
    const snapped = await sdk.timelineEdit({
      packageRoot: scaledDir,
      outDir: snappedDir,
      edit: { kind: "keyframe.snap", layerId: "title", target: "opacity", fps: 10, mode: "nearest", startMs: 150, endMs: 350 },
    });
    expect(snapped).toMatchObject({ ok: true, output: { receipt: { operation: "timeline.keyframe.snap" } } });

    const deletedDir = join(root, "range-deleted");
    const deleted = await sdk.timelineEdit({
      packageRoot: snappedDir,
      outDir: deletedDir,
      edit: { kind: "keyframe.range.delete", layerId: "title", target: "opacity", startMs: 650, endMs: 750 },
    });
    expect(deleted).toMatchObject({ ok: true, output: { receipt: { operation: "timeline.keyframe.range.delete" } } });

    const motion = JSON.parse(await readFile(join(deletedDir, "motion.json"), "utf8"));
    expect(motion.layers.find((layer: { id: string }) => layer.id === "title")?.keyframes?.opacity).toEqual([
      { atMs: 200, value: 0.8 },
      { atMs: 400, value: 0.2 },
    ]);
  });

  it("routes keyframe distribution through one typed SDK edit and receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-keyframe-distribute-"));
    tempDirs.push(root);
    const source = join(root, "source");
    await cp(resolve("../../fixtures/packages/editable-lower-third"), source, { recursive: true });
    const motionPath = join(source, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    const title = motion.layers.find((layer: { id: string }) => layer.id === "title");
    title.keyframes = {
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 120, value: 0.5, easing: "ease-out" },
        { atMs: 500, value: 1 }
      ]
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const outDir = join(root, "distributed");

    const result = await createLocalMotionSdk().timelineEdit({
      packageRoot: source,
      outDir,
      edit: { kind: "keyframe.distribute", layerId: "title", target: "opacity", startMs: 0, endMs: 500 }
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        edit: { kind: "keyframe.distribute", layerId: "title", target: "opacity", startMs: 0, endMs: 500 },
        receipt: { operation: "timeline.keyframe.distribute", status: "passed" }
      }
    });
    const reopened = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(reopened.layers.find((layer: { id: string }) => layer.id === "title")?.keyframes.opacity).toEqual([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 250, value: 0.5, easing: "ease-out" },
      { atMs: 500, value: 1 }
    ]);
  });

});
