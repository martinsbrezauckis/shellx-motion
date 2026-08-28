/** Agent authoring proof: field data stays on generic typed layer-create, not a new command. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTinyPackageWithTimeline } from "./main.fixtures-packages";
import { runCli as runCliRaw, type RunCliOptions } from "./main";

const ownedPaths: string[] = [];
const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

afterEach(async () => { await Promise.all(ownedPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("analytic particle field CLI authoring", () => {
  it("creates bounded field-backed particles through generic layer-create", async () => {
    const packageRoot = await writeTinyPackageWithTimeline();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-particle-field-cli-"));
    ownedPaths.push(packageRoot, outDir);
    const layer = {
      id: "orbital-dust", type: "particles", trackId: "overlay", startMs: 0, durationMs: 300,
      transform: { x: 0, y: 0, width: 64, height: 36 },
      emitter: {
        seed: 7, count: 32, lifetimeMs: 300, color: "#ffffff",
        field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "vortex", centerX: 0.5, centerY: 0.5, strength: 0.4, softening: 0.2 }] }
      }
    };

    const result = await runCli([
      "debug", "layer-create", "--tier", "edit_motion", "--package", packageRoot,
      "--out", outDir, "--layer-json", JSON.stringify(layer), "--created-by", "particle-field-cli-test"
    ]);

    expect(result).toMatchObject({ ok: true, command: "debug.layer-create", result: { action: "created", layerId: "orbital-dust", validation: { ok: true } } });
    const motion = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(motion.layers.find((candidate: { id?: string }) => candidate.id === "orbital-dust")).toMatchObject(layer);
  });
});
