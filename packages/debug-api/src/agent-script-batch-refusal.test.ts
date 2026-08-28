import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const roots: string[] = [];

describe("Debug active-content batch refusal", () => {
  afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("refuses before package copy even when a host authority exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-debug-active-batch-")); roots.push(root);
    const packageRoot = join(root, "package"); const outDir = join(root, "out");
    await cp(resolve("../../fixtures/packages/batch-card"), packageRoot, { recursive: true });
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
    const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
    manifest.assets = ["entry.html"]; motion.assets = ["entry.html"];
    motion.layers[1] = { id: "entry", type: "html", source: "entry.html", startMs: 0, durationMs: 2_000 };
    await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify(motion)}\n`);
    await writeFile(join(packageRoot, "entry.html"), "<main>active</main>");

    const result = await dispatchDebugCommand("motion.render.batch", { packageRoot, outDir, dryRun: true }, {
      tier: "render_motion", agentScriptAuthority: { resolverVersion: 1 } as never
    });

    expect(result).toMatchObject({ ok: false, error: { code: "script_provenance_unresolved" } });
    expect(existsSync(outDir)).toBe(false);
  });
});
