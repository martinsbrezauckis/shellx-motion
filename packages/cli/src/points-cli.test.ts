/**
 * Agent authoring proof for bounded points: the existing generic layer-create
 * command accepts data-only point clouds and core validation remains the gate.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTinyPackageWithTimeline } from "./main.fixtures-packages";
import { runCli as runCliRaw, type RunCliOptions } from "./main";

const ownedPaths: string[] = [];
const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

afterEach(async () => {
  await Promise.all(ownedPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("points CLI authoring", () => {
  it("creates a bounded points layer through generic agent-approved layer JSON", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-points-cli-"));
    ownedPaths.push(packageRoot, outDir);
    const layer = {
      id: "swarm", type: "points", trackId: "overlay", startMs: 0, durationMs: 300,
      pointCloud: {
        points: [{ x: 8, y: 12, color: "#ffffff", size: 2 }, { x: 20, y: 12, size: 1 }],
        samples: [
          { atMs: 0, positions: [{ x: 8, y: 12 }, { x: 20, y: 12 }] },
          { atMs: 300, positions: [{ x: 24, y: 18 }, { x: 44, y: 18 }] }
        ]
      }
    };

    const result = await runCli([
      "debug", "layer-create", "--tier", "edit_motion", "--package", packageRoot,
      "--out", outDir, "--layer-json", JSON.stringify(layer), "--created-by", "points-cli-test"
    ]);

    expect(result).toMatchObject({
      ok: true,
      command: "debug.layer-create",
      result: { action: "created", layerId: "swarm", validation: { ok: true } }
    });
    const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(motion.layers.find((candidate: { id?: string }) => candidate.id === "swarm")).toMatchObject(layer);
  });
});
