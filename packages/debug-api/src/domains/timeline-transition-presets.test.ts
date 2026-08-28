import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import { dispatchTimelineTransitionsCommand } from "./timeline-transitions.js";

const roots: string[] = [];
const fixture = resolve("../../fixtures/packages/lower-third");
function authoringServices(inputRoot: string, outputRoot: string) {
  return withTestAuthoringRoots({
  packageLoader: loadMotionPackage,
  isUnsafePackageOutputDirectory: async () => false,
  isEmptyOrAbsentDirectory: async (path: string) => (await stat(path).catch(() => null)) === null,
  }, { inputRoots: [inputRoot], outputRoots: [outputRoot] });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("timeline transition presets", () => {
  it("lists the bounded Core catalog without loading a package", async () => {
    const result = await dispatchTimelineTransitionsCommand("motion.timeline.transition.presets", {}, {});
    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "timeline.transition.presets", presetCount: 7 },
      result: { defaultPreset: "soft-fade", presets: expect.arrayContaining([expect.objectContaining({ id: "card-stack" }), expect.objectContaining({ id: "split-reveal" })]) },
    });
  });

  it("applies one named preset through the atomic package boundary with receipt facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-transition-preset-"));
    roots.push(root);
    const outDir = join(root, "card-stack");
    const source = await readFile(join(fixture, "motion.json"), "utf8");
    const result = await dispatchTimelineTransitionsCommand("motion.timeline.transition.preset.apply", {
      packageRoot: fixture, outDir, layerId: "title", preset: "card-stack", durationMs: 600,
      direction: "left", distance: 80, easing: "ease-out", createdBy: "transition-test",
    }, authoringServices(fixture, root));
    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "timeline.transition.preset.apply", layerId: "title", presetId: "card-stack" },
      result: {
        presetId: "card-stack",
        transitions: { in: { type: "slide", direction: "left", distance: 80, durationMs: 600 }, out: { type: "slide", direction: "down", distance: 40, durationMs: 300 } },
        changedPaths: expect.arrayContaining(["/layers/0/transitions", "/layers/0/keyframes/transform.rotation"]),
        receipt: { operation: "timeline.transition.preset.apply", status: "passed" },
      },
    });
    expect((await loadMotionPackage(outDir)).motion.layers[0]).toMatchObject({
      id: "title",
      transitions: { in: { type: "slide", direction: "left" }, out: { type: "slide", direction: "down" } },
      keyframes: { "transform.rotation": [{ atMs: 0, value: -1.5 }, { atMs: 600, value: 0 }] },
    });
    expect(await readFile(join(fixture, "motion.json"), "utf8")).toBe(source);
  });

  it("refuses unknown presets and invalid overrides before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-transition-refusal-"));
    roots.push(root);
    const unknown = await dispatchTimelineTransitionsCommand("motion.timeline.transition.preset.apply", {
      packageRoot: fixture, outDir: join(root, "unknown"), layerId: "title", preset: "teleport",
    }, authoringServices(fixture, root));
    const direction = await dispatchTimelineTransitionsCommand("motion.timeline.transition.preset.apply", {
      packageRoot: fixture, outDir: join(root, "direction"), layerId: "title", preset: "slide-cover", direction: "diagonal",
    }, authoringServices(fixture, root));
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_args", detail: { argument: "transition preset", value: "teleport" } } });
    expect(direction).toMatchObject({ ok: false, error: { code: "invalid_args", detail: { argument: "transition direction", value: "diagonal" } } });
    await expect(stat(join(root, "unknown"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "direction"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
