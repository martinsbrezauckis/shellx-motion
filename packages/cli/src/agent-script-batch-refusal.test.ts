import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./main";

const roots: string[] = [];

describe("CLI active-content batch refusal", () => {
  afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("refuses before copying the package because provenance cannot transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-active-batch-")); roots.push(root);
    const packageRoot = join(root, "package"); const outDir = join(root, "out");
    await cp(resolve("../../fixtures/packages/batch-card"), packageRoot, { recursive: true });
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
    const motion = JSON.parse(await readFile(join(packageRoot, "motion.json"), "utf8"));
    manifest.assets = ["entry.html"]; motion.assets = ["entry.html"];
    motion.layers[1] = { id: "entry", type: "html", source: "entry.html", startMs: 0, durationMs: 2_000 };
    await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify(motion)}\n`);
    await writeFile(join(packageRoot, "entry.html"), "<main>active</main>");

    const result = await runCli(["render-batch", packageRoot, "--out", outDir, "--dry-run"]);

    expect(result).toMatchObject({ ok: false, error: { code: "script_provenance_unresolved" } });
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses browser capture before an injected renderer or output write", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-active-capture-")); roots.push(root);
    const outDir = join(root, "out"); let rendererCalls = 0;

    const result = await runCli([
      "capture-browser", resolve("../../fixtures/packages/web-card"), "--out", outDir
    ], { browserFrameRenderer: async () => { rendererCalls += 1; throw new Error("must not run"); } });

    expect(result).toMatchObject({ ok: false, command: "capture-browser", error: { code: "script_provenance_unresolved" } });
    expect(rendererCalls).toBe(0);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses browser-frame final render before creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-active-final-")); roots.push(root);
    const outputPath = join(root, "out", "final.mp4");

    const result = await runCli([
      "render", resolve("../../fixtures/packages/web-card"), "--out", outputPath, "--dry-run"
    ]);

    expect(result).toMatchObject({ ok: false, command: "render", error: { code: "script_provenance_unresolved" } });
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});
