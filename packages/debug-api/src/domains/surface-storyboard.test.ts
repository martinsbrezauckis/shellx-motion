import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { readDebugJson } from "../debug-json-read.js";
import { dispatchSurfaceStoryboardCommand } from "./surface-storyboard.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("storyboard surface input boundary", () => {
  it("uses the selected host input root for every path alias and never leaks a rejected path", async () => {
    const root = await privateRoot("shellx-motion-storyboard-input-");
    const inputRoot = join(root, "input");
    const outsideRoot = join(root, "outside");
    const scriptPath = join(inputRoot, "storyboard.json");
    const outsidePath = join(outsideRoot, "outside-storyboard.json");
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outsideRoot, { mode: 0o700 })]);
    await Promise.all([
      writeFile(scriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8"),
      writeFile(outsidePath, `${JSON.stringify(scriptedVideo())}\n`, "utf8")
    ]);

    const authority = await createTrustedWorkspaceAnchor(root);
    await withTrustedWorkspaceAnchor(authority, async () => {
      for (const command of ["motion.storyboard.panel", "motion.storyboard.graph"] as const) {
        for (const alias of ["scriptPath", "storyboardPath", "path"] as const) {
          const refused = await dispatchSurfaceStoryboardCommand(command, { [alias]: outsidePath }, storyboardServices([inputRoot]));
          expect(refused).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
          expect(JSON.stringify(refused)).not.toContain(outsidePath);

          const accepted = await dispatchSurfaceStoryboardCommand(command, { [alias]: scriptPath }, storyboardServices([inputRoot]));
          expect(accepted).toMatchObject({ ok: true, result: { scriptPath } });
        }
      }
    });
  });

  it("fails closed without host roots while preserving both inline storyboard aliases", async () => {
    const readJson = vi.fn(async () => scriptedVideo());
    for (const command of ["motion.storyboard.panel", "motion.storyboard.graph"] as const) {
      const noRoots = await dispatchSurfaceStoryboardCommand(command, { scriptPath: "/caller/storyboard.json" }, {
        ...storyboardServices(), readJson
      });
      expect(noRoots).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: /host-approved authoring input roots/ } });

      for (const inlineKey of ["script", "storyboard"] as const) {
        const inline = await dispatchSurfaceStoryboardCommand(command, { [inlineKey]: scriptedVideo() }, storyboardServices());
        expect(inline).toMatchObject({ ok: true, result: { scriptId: "storyboard-boundary" } });
      }
    }
    expect(readJson).not.toHaveBeenCalled();
  });

  it("returns a bounded path-free read error for malformed JSON inside an approved root", async () => {
    const root = await privateRoot("shellx-motion-storyboard-invalid-");
    const inputRoot = join(root, "input");
    const scriptPath = join(inputRoot, "invalid-storyboard.json");
    await mkdir(inputRoot, { mode: 0o700 });
    await writeFile(scriptPath, "{ not JSON", "utf8");

    const authority = await createTrustedWorkspaceAnchor(root);
    await withTrustedWorkspaceAnchor(authority, async () => {
      const result = await dispatchSurfaceStoryboardCommand("motion.storyboard.panel", { scriptPath }, storyboardServices([inputRoot]));
      expect(result).toMatchObject({ ok: false, error: { code: "storyboard_panel_failed", message: "Storyboard JSON could not be read from the approved authoring input root." } });
      expect(JSON.stringify(result)).not.toContain(scriptPath);
    });
  });
});

function storyboardServices(authoringInputRoots?: string[]) {
  return {
    ...(authoringInputRoots ? { authoringInputRoots } : {}),
    readJson: readDebugJson,
    buildStoryboardPanel: (script: Record<string, unknown>, scriptPath?: string) => ({
      ...(scriptPath ? { scriptPath } : {}),
      scriptId: String(script.id ?? "storyboard-boundary"),
      name: "Storyboard Boundary",
      workflow: "generate",
      counts: { frames: 1, sourceRefs: 0, assetRefs: 0 },
      totalDurationMs: 1000,
      readiness: { status: "ready", diagnostics: [] },
      warnings: []
    }),
    buildStoryboardGraph: (script: Record<string, unknown>, scriptPath?: string) => ({
      ...(scriptPath ? { scriptPath } : {}),
      scriptId: String(script.id ?? "storyboard-boundary"),
      name: "Storyboard Boundary",
      workflow: "generate",
      counts: { nodes: 2, edges: 1, frames: 1, sourceRefs: 0 },
      readiness: { status: "ready", diagnostics: [] },
      warnings: []
    })
  };
}

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "storyboard-boundary",
    name: "Storyboard Boundary",
    sourceApp: "shellx-motion",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [{ id: "one", title: "One", durationMs: 1000 }]
  };
}

async function privateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
