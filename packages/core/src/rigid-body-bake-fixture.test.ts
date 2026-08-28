import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY,
  NATIVE_CAPABILITY,
  loadSchema,
  matchRendererCapability,
  rendererCapabilityForLane,
  validateDocument,
  validateMotionDocumentInStages,
  type MotionDocument,
  type MotionPackage
} from "@shellx-motion/core";

const FIXTURE_PARENT = process.env.RIGID_BODY_BAKE_FIXTURE_PARENT;
const fixtureRoot = (name: string): string => FIXTURE_PARENT
  ? join(FIXTURE_PARENT, name)
  : fileURLToPath(new URL(`../../../fixtures/packages/${name}`, import.meta.url));

const FIXTURES = [
  {
    root: fixtureRoot("rigid-body-bake-bingo-2d"),
    kind: "bingo",
    keyCap: 5_120,
    layerCap: 32,
    ids: ["bingo-ball-01", "bingo-ball-02", "bingo-ball-03", "bingo-ball-04", "bingo-ball-05", "bingo-ball-06", "bingo-ball-07", "bingo-ball-08", "bingo-ball-09", "bingo-ball-10"],
    phases: ["idle", "mixing", "selected", "reveal"]
  },
  {
    root: fixtureRoot("rigid-body-bake-wrecking-wall-2d"),
    kind: "wrecking",
    keyCap: 10_240,
    layerCap: 32,
    ids: ["wrecking-ball", ...Array.from({ length: 15 }, (_, index) => `brick-r${Math.floor(index / 5) + 1}-c${(index % 5) + 1}`)],
    phases: ["intact", "swing", "contact", "impacted", "falling", "settled"]
  }
] as const;

/**
 * Source-only fixture admission. This file deliberately imports no renderer,
 * preview, browser session, or native session API: passing it proves neither
 * pixels nor a renderer launch.
 */
describe("author-time rigid-body bake fixture admission", () => {
  it.each(FIXTURES)("$kind is a normal schema-valid 2D package with matching Browser/Native capability", async (fixture) => {
    const pkg = await readPackage(fixture.root);
    expect(await validateDocument(await loadSchema("packageManifest"), pkg.manifest)).toEqual({ ok: true });
    expect(await validateMotionDocumentInStages(pkg.motion)).toMatchObject({ ok: true });
    expect(pkg.manifest).toMatchObject({
      assets: [],
      compatibility: { lanes: ["browser", "native", "ffmpeg"], hosts: ["motion"] },
      workflow: "author-time-rigid-body-bake-2d"
    });
    expect(pkg.motion).toMatchObject({ durationMs: 15_000, fps: 30, width: 1920, height: 1080, assets: [] });
    expect(pkg.motion.layers.length).toBeGreaterThan(0);
    expect(pkg.motion.layers.length).toBeLessThanOrEqual(fixture.layerCap);
    expect(pkg.motion.layers.map((layer) => layer.id)).toEqual(expect.arrayContaining([...fixture.ids]));
    expect(pkg.motion.markers?.map((marker) => marker.id)).toEqual(fixture.phases);

    // Both existing frame-lane capability matchers admit the same plain shape
    // surface. A behavior/refusal path cannot be hidden because neither the
    // document root nor any layer contains an authority field.
    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({ ok: true, lane: "browser", unsupported: [] });
    expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
    expect(matchRendererCapability(pkg.motion, rendererCapabilityForLane("ffmpeg"))).toEqual({ ok: true, lane: "ffmpeg", unsupported: [] });
    expect(pkg.motion).not.toHaveProperty("behaviors");
    expect(pkg.motion).not.toHaveProperty("relationships");
    expect(pkg.motion).not.toHaveProperty("spatial");
    expect(pkg.motion).not.toHaveProperty("rigidBody");
    expect(pkg.motion).not.toHaveProperty("scene3d");
    expect(pkg.motion).not.toHaveProperty("depth");
    expect(pkg.motion).not.toHaveProperty("particles");

    let ordinaryKeys = 0;
    for (const layer of pkg.motion.layers) {
      expect(layer.type).toBe("shape");
      expect(["rect", "rounded-rect", "ellipse"]).toContain(layer.shape);
      expect(layer).not.toHaveProperty("spatial");
      expect(layer).not.toHaveProperty("behaviors");
      expect(layer).not.toHaveProperty("relationships");
      expect(layer).not.toHaveProperty("rigidBody");
      expect(layer).not.toHaveProperty("scene3d");
      expect(layer).not.toHaveProperty("depth");
      expect(layer).not.toHaveProperty("particles");
      expect(layer).not.toHaveProperty("web");
      expect(layer).not.toHaveProperty("html");
      expect(layer).not.toHaveProperty("canvas");
      const keys = layer.keyframes ?? {};
      expect(Object.keys(keys).every((property) => ["transform.x", "transform.y", "transform.rotation"].includes(property))).toBe(true);
      for (const entries of Object.values(keys)) {
        const values = entries ?? [];
        ordinaryKeys += values.length;
        expect(values.every((entry) => typeof entry.value === "number" && Number.isFinite(entry.value) && entry.easing === "linear")).toBe(true);
      }
      const x = keys["transform.x"]?.map((entry) => entry.atMs);
      const y = keys["transform.y"]?.map((entry) => entry.atMs);
      if (x || y) expect(x).toEqual(y);
    }
    expect(ordinaryKeys).toBeLessThanOrEqual(fixture.keyCap);

    if (fixture.kind === "bingo") {
      const balls = pkg.motion.layers.filter((layer) => layer.id.startsWith("bingo-ball-"));
      expect(balls).toHaveLength(10);
      expect(new Set(balls.map((layer) => layer.fill))).toHaveLength(10);
      expect(balls.find((layer) => layer.id === "bingo-ball-07")?.keyframes?.["transform.x"]?.at(-1)).toMatchObject({ atMs: 12_000, value: 1528, easing: "linear" });
    } else {
      expect(pkg.motion.layers.filter((layer) => layer.id.startsWith("brick-r"))).toHaveLength(15);
      expect(pkg.motion.layers.find((layer) => layer.id === "wrecking-cable")?.keyframes?.["transform.rotation"]).toHaveLength(301);
    }
  });
});

async function readPackage(root: string): Promise<MotionPackage> {
  const [manifest, motion] = await Promise.all([
    readFile(join(root, "manifest.json"), "utf8"),
    readFile(join(root, "motion.json"), "utf8")
  ]);
  return { root, manifest: JSON.parse(manifest), motion: JSON.parse(motion) as MotionDocument } as MotionPackage;
}
