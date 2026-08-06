import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveLayerAtMs, loadMotionPackage, readMotionSpatialPath } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";

async function fixture(): Promise<{ root: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-spatial-"));
  const packageRoot = join(root, "source");
  await cp("../../fixtures/packages/editable-lower-third", packageRoot, { recursive: true });
  return { root, packageRoot };
}

describe("SDK spatial timeline edits", () => {
  it("persists paired cubic positions through one receipt per edit", async () => {
    const { root, packageRoot } = await fixture();
    try {
      const source = await loadMotionPackage(packageRoot);
      const layerId = source.motion.layers[0].id;
      const firstRoot = join(root, "first");
      const first = await createLocalMotionSdk().timelineEdit({
        packageRoot,
        outDir: firstRoot,
        edit: {
          kind: "spatial.position.upsert",
          layerId,
          atMs: 0,
          x: 0,
          y: 0,
          easing: "linear",
          spatial: { mode: "broken", in: { x: 0, y: 0 }, out: { x: 0, y: 80 } },
        },
      });
      expect(first).toMatchObject({
        ok: true,
        output: { receipt: { operation: "timeline.spatial.position.upsert", status: "passed" } },
      });
      if (!first.ok) throw new Error(first.error.message);

      const secondRoot = join(root, "second");
      const second = await createLocalMotionSdk().timelineEdit({
        packageRoot: firstRoot,
        outDir: secondRoot,
        edit: {
          kind: "spatial.position.upsert",
          layerId,
          atMs: 1_000,
          x: 120,
          y: 0,
          easing: "linear",
          spatial: { mode: "broken", in: { x: 0, y: 80 }, out: { x: 0, y: 0 } },
        },
      });
      expect(second).toMatchObject({ ok: true, output: { receipt: { operation: "timeline.spatial.position.upsert" } } });
      const edited = await loadMotionPackage(secondRoot);
      const layer = edited.motion.layers.find((candidate) => candidate.id === layerId)!;
      expect(readMotionSpatialPath(layer)).toHaveLength(2);
      expect(effectiveLayerAtMs(layer, 500).transform).toMatchObject({ x: 60, y: 60 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("moves and removes both lanes without accepting prototype or unbounded input", async () => {
    const unsafe = Object.create({ kind: "spatial.position.delete" }) as {
      kind: "spatial.position.delete"; layerId: string; atMs: number;
    };
    unsafe.layerId = "title"; unsafe.atMs = 0;
    const rejected = await createLocalMotionSdk().timelineEdit({ packageRoot: "/tmp/source", outDir: "/tmp/out", edit: unsafe });
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    const bounded = await createLocalMotionSdk().timelineEdit({
      packageRoot: "/tmp/source",
      outDir: "/tmp/out",
      edit: { kind: "spatial.position.upsert", layerId: "title", atMs: 0, x: 1_000_001, y: 0 },
    });
    expect(bounded).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("bounded finite x") } });
  });
});
