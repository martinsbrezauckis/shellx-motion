import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("debug Script-to-Cut input boundary", () => {
  it("refuses ambiguous inline Script-to-Cut inputs before it writes a caller-selected script path", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-script-cut-ambiguous-"));
    const callerScriptPath = join(outDir, "caller-selected.json");
    try {
      const result = await dispatchDebugCommand(
        "motion.connector.script_to_cut",
        { scriptPath: callerScriptPath, script: scriptedVideo(), outDir },
        { tier: "write_local", authoringInputRoots: [outDir], authoringOutputRoots: [outDir] }
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("exactly one input source") } });
      await expect(readFile(callerScriptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(outDir, "package", "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "launch-demo",
    name: "Launch Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [
      { id: "hook", title: "Hook", body: "Show the new workflow", durationMs: 1000, background: "#0f172a", accent: "#38bdf8" },
      { id: "cta", title: "Cut edits it", caption: "Rendered by Motion", durationMs: 1500, background: "#111827", accent: "#22c55e" }
    ]
  };
}
