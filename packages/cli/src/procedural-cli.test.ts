import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROCEDURAL_DEBUG_COMMANDS, proceduralDebugArgs } from "./procedural-cli.js";

const roots: string[] = [];

describe("procedural relationship CLI adapter", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("maps inspection, reversible mutations, and bounded bake flags", async () => {
    expect(PROCEDURAL_DEBUG_COMMANDS).toEqual({
      "procedural-inspect": "motion.procedural.inspect",
      "procedural-set": "motion.procedural.relationship.set",
      "procedural-enabled-set": "motion.procedural.relationship.enabled.set",
      "procedural-bake": "motion.procedural.relationship.bake",
      "procedural-detach": "motion.procedural.relationship.detach",
    });
    expect(await proceduralDebugArgs(
      "motion.procedural.inspect",
      ["--at-ms", "500"],
      "/motion/source",
    )).toEqual({ packageRoot: "/motion/source", atMs: 500 });
    expect(await proceduralDebugArgs(
      "motion.procedural.relationship.enabled.set",
      ["--out", "/motion/disabled", "--relationship", "drift", "--disabled"],
      "/motion/source",
    )).toMatchObject({
      packageRoot: "/motion/source",
      outDir: "/motion/disabled",
      relationshipId: "drift",
      enabled: false,
    });
    expect(await proceduralDebugArgs(
      "motion.procedural.relationship.bake",
      [
        "--out", "/motion/baked",
        "--relationships", "drift,pulse",
        "--start-ms", "100",
        "--end-ms", "900",
        "--sample-every-frames", "2",
      ],
      "/motion/source",
    )).toMatchObject({
      relationshipIds: ["drift", "pulse"],
      startMs: 100,
      endMs: 900,
      sampleEveryFrames: 2,
    });
  });

  it("reads data-only relationship JSON and rejects ambiguous flag combinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-procedural-cli-"));
    roots.push(root);
    const file = join(root, "relationship.json");
    await mkdir(root, { recursive: true });
    await writeFile(file, JSON.stringify({ id: "drift", enabled: true }), "utf8");
    expect(await proceduralDebugArgs(
      "motion.procedural.relationship.set",
      ["--out", "/motion/set", "--relationship-file", file],
      "/motion/source",
    )).toMatchObject({ relationship: { id: "drift", enabled: true } });
    await expect(proceduralDebugArgs(
      "motion.procedural.relationship.set",
      ["--relationship-json", "{}", "--relationship-file", file],
      "/motion/source",
    )).rejects.toThrow("either --relationship-json or --relationship-file");
    await expect(proceduralDebugArgs(
      "motion.procedural.relationship.enabled.set",
      ["--enabled", "--disabled"],
      "/motion/source",
    )).rejects.toThrow("either --enabled or --disabled");
  });
});
