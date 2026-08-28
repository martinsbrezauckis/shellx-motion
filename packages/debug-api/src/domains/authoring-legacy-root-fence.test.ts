import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand } from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("legacy authoring adapter root fence", () => {
  it("fails closed for every legacy adapter when the host did not configure both root services", async () => {
    const commands = [
      ["motion.script.compile", { script: scriptedVideo(), packageDir: "/untrusted/package" }],
      ["motion.html.snippet.export", { packageRoot: "/untrusted/package", outDir: "/untrusted/output" }],
      ["motion.html.snippet.import", { htmlPath: "/untrusted/input.html", packageDir: "/untrusted/package" }],
      ["motion.otio.export", { packageRoot: "/untrusted/package", outPath: "/untrusted/timeline.otio" }],
      ["motion.otio.import", { otioPath: "/untrusted/timeline.otio", packageDir: "/untrusted/package" }],
    ] as const;

    for (const [command, args] of commands) {
      await expect(dispatchDebugCommand(command, args, { tier: "write_local" })).resolves.toMatchObject({
        ok: false,
        error: { code: "capability_unavailable", message: expect.stringMatching(/host-approved input and output roots/) },
      });
    }
  });

  it.runIf(process.platform === "linux")("allows a regular source and package output only inside the roots the host configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-legacy-authoring-roots-"));
    tempDirs.push(root);
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const scriptPath = join(inputRoot, "storyboard.json");
    const packageDir = join(outputRoot, "package");
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 })]);
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8");

    const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await dispatchDebugCommand(
      "motion.script.compile",
      { scriptPath, packageDir, createdAt: "2026-08-11T00:00:00.000Z" },
      { tier: "write_local", authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] },
    ));
    expect(result).toMatchObject({ ok: true, visibleState: { operation: "script.compile", packageDir } });
    await expect(readFile(join(packageDir, "manifest.json"), "utf8")).resolves.toContain('"id": "pkg_script_roots_demo"');
  });

  it("refuses outside outputs for every legacy adapter before its filesystem writer runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-legacy-authoring-outside-"));
    tempDirs.push(root);
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const outsideRoot = join(root, "outside");
    const scriptPath = join(inputRoot, "storyboard.json");
    const htmlPath = join(inputRoot, "snippet.html");
    const otioPath = join(inputRoot, "timeline.otio");
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 }), mkdir(outsideRoot, { mode: 0o700 })]);
    await Promise.all([
      writeFile(scriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8"),
      writeFile(htmlPath, "<!doctype html><html><body></body></html>\n", "utf8"),
      writeFile(otioPath, "{}\n", "utf8"),
    ]);
    const services = { tier: "write_local" as const, authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] };
    const commands = [
      ["motion.script.compile", { scriptPath, packageDir: join(outsideRoot, "script-package") }],
      ["motion.html.snippet.export", { packageRoot: inputRoot, outDir: join(outsideRoot, "html") }],
      ["motion.html.snippet.import", { htmlPath, packageDir: join(outsideRoot, "html-package") }],
      ["motion.otio.export", { packageRoot: inputRoot, outPath: join(outsideRoot, "timeline.otio") }],
      ["motion.otio.import", { otioPath, packageDir: join(outsideRoot, "otio-package") }],
    ] as const;

    const anchor = await createTrustedWorkspaceAnchor(root);
    for (const [command, args] of commands) {
      await expect(withTrustedWorkspaceAnchor(anchor, async () => await dispatchDebugCommand(command, args, services))).resolves.toMatchObject({
        ok: false,
        error: { code: expect.stringMatching(/_failed$/), message: expect.stringMatching(/approved authoring .* root/) },
      });
    }
    expect(await Promise.all([
      readFile(join(outsideRoot, "script-package", "manifest.json"), "utf8").catch(() => null),
      readFile(join(outsideRoot, "html", "index.html"), "utf8").catch(() => null),
      readFile(join(outsideRoot, "timeline.otio"), "utf8").catch(() => null),
    ])).toEqual([null, null, null]);
  });

  it("refuses a symlinked source path even when its lexical spelling is below an input root", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-legacy-authoring-symlink-"));
    tempDirs.push(root);
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const outsideScript = join(root, "outside-script.json");
    const linkedScript = join(inputRoot, "linked-script.json");
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 })]);
    await writeFile(outsideScript, `${JSON.stringify(scriptedVideo())}\n`, "utf8");
    await symlink(outsideScript, linkedScript, "file");

    const result = await dispatchDebugCommand(
      "motion.script.compile",
      { scriptPath: linkedScript, packageDir: join(outputRoot, "package") },
      { tier: "write_local", authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "script_compile_failed", message: expect.stringMatching(/symbolic links/) } });
    await expect(readFile(join(outputRoot, "package", "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "roots-demo",
    name: "Roots Demo",
    sourceApp: "shellx-motion",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [{ id: "intro", title: "Root fence", durationMs: 1000 }],
  };
}
