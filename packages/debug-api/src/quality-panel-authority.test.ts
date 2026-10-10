import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("quality panel baseline authority", () => {
  it("keeps admitted relative file symlinks usable for present and missing baselines", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-quality-panel-symlink-control-"));
    try {
      const manifestPath = join(root, "manifest.json");
      await symlink("baseline.png", join(root, "linked.png"), "file");
      await writeFile(manifestPath, JSON.stringify({
        schema: "shellx-motion/quality-manifest@1", samples: [{ id: "allowed", atMs: 0, baseline: "linked.png" }],
      }));
      for (const exists of [false, true]) {
        if (exists) await writeFile(join(root, "baseline.png"), "allowed baseline");
        const result = await dispatchDebugCommand("motion.quality.panel", { qualityManifestPath: manifestPath }, {
          tier: "read_motion", scratchRoot: root,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.result).toMatchObject({ samples: [{ baselineExists: exists }] });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["absolute", "relative", "symlink", "dangling-symlink"] as const)("refuses %s quality-panel baselines outside admitted roots", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "motion-quality-panel-authority-"));
    const trustedRoot = join(root, "trusted");
    const outsideRoot = join(root, "outside");
    try {
      await mkdir(trustedRoot);
      await mkdir(outsideRoot);
      await writeFile(join(trustedRoot, "allowed.png"), "allowed baseline");
      if (kind === "symlink") await symlink(outsideRoot, join(trustedRoot, "linked"), "dir");
      if (kind === "dangling-symlink") await symlink(join(outsideRoot, "baseline.png"), join(trustedRoot, "linked.png"), "file");
      const manifestPath = join(trustedRoot, "manifest.json");
      const baseline = kind === "absolute" ? join(outsideRoot, "baseline.png")
        : kind === "relative" ? "../outside/baseline.png" : kind === "symlink" ? "linked/baseline.png" : "linked.png";
      await writeFile(manifestPath, JSON.stringify({
        schema: "shellx-motion/quality-manifest@1",
        samples: [{ id: "allowed", atMs: 0, baseline: "allowed.png" }, { id: "escaped", atMs: 100, baseline }],
      }));
      const refusals = [];
      for (const exists of [false, true]) {
        if (exists) await writeFile(join(outsideRoot, "baseline.png"), "private baseline");
        const result = await dispatchDebugCommand("motion.quality.panel", { qualityManifestPath: manifestPath }, {
          tier: "read_motion", scratchRoot: trustedRoot,
        });
        expect(result).toEqual({
          ok: false,
          error: { code: "invalid_args", message: "motion.quality.panel baseline must be inside packageRoot or a trusted debug input root." },
          warnings: [],
        });
        refusals.push(result);
      }
      expect(refusals[0]).toEqual(refusals[1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
