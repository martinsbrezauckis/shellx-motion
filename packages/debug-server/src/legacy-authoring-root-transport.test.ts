import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index.js";

const TOKEN = "legacy-authoring-root-transport-token";
const HOST_UNAVAILABLE_STATUS = 503;
const PATH_REFUSAL_STATUS = 403;

describe("legacy authoring roots across debug transports", () => {
  it("fails closed without roots, writes inside roots through HTTP, and refuses an outside MCP tool output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-legacy-authoring-transport-"));
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const outsideRoot = join(root, "outside");
    const scriptPath = join(inputRoot, "storyboard.json");
    const outsideStoryboardPath = join(outsideRoot, "outside-storyboard.json");
    const packageDir = join(outputRoot, "package");
    // Only the declared authority roots are private fixtures. `outsideRoot` deliberately remains
    // an ordinary caller-named refusal input so this test continues to prove the root boundary.
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 }), mkdir(outsideRoot)]);
    await Promise.all([
      writeFile(scriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8"),
      writeFile(outsideStoryboardPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8")
    ]);
    let withoutRoots: MotionDebugServerHandle | undefined;
    let rooted: MotionDebugServerHandle | undefined;
    try {
      withoutRoots = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, grantedTier: "write_local" });
      const absent = await postJson(new URL("/debug", withoutRoots.url), {
        command: "motion.script.compile",
        requestedTier: "write_local",
        args: { scriptPath, packageDir }
      }, HOST_UNAVAILABLE_STATUS);
      expect(absent).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringMatching(/host-approved input and output roots/) } });
      await expect(readFile(join(packageDir, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const noStoryboardRoots = await postJson(new URL("/debug", withoutRoots.url), {
        command: "motion.storyboard.panel",
        requestedTier: "read_motion",
        args: { scriptPath }
      }, HOST_UNAVAILABLE_STATUS);
      expect(noStoryboardRoots).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringMatching(/host-approved authoring input roots/) } });
      await withoutRoots.close();
      withoutRoots = undefined;

      rooted = await startMotionDebugServer({
        port: 0,
        capabilityToken: TOKEN,
        grantedTier: "write_local",
        context: { authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] }
      });
      const inside = await postJson(new URL("/debug", rooted.url), {
        command: "motion.script.compile",
        requestedTier: "write_local",
        args: { scriptPath, packageDir, createdAt: "2026-08-11T00:00:00.000Z" }
      });
      expect(inside).toMatchObject({ ok: true, command: "motion.script.compile", visibleState: { packageDir } });
      await expect(readFile(join(packageDir, "manifest.json"), "utf8")).resolves.toContain('"id": "pkg_script_transport_demo"');

      const insideStoryboard = await postJson(new URL("/debug", rooted.url), {
        command: "motion.storyboard.graph",
        requestedTier: "read_motion",
        args: { path: scriptPath }
      });
      expect(insideStoryboard).toMatchObject({ ok: true, command: "motion.storyboard.graph", result: { scriptPath } });

      const outsideStoryboard = await postJson(new URL("/debug", rooted.url), {
        command: "motion.storyboard.panel",
        requestedTier: "read_motion",
        args: { storyboardPath: outsideStoryboardPath }
      }, PATH_REFUSAL_STATUS);
      expect(outsideStoryboard).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      expect(JSON.stringify(outsideStoryboard)).not.toContain(outsideStoryboardPath);

      const outside = await postJson(new URL("/rpc", rooted.url), {
        jsonrpc: "2.0",
        id: "outside-authoring",
        method: "tools/call",
        params: {
          name: "motion_script_compile",
          arguments: {
            requestedTier: "write_local",
            args: { scriptPath, packageDir: join(outsideRoot, "package") }
          }
        }
      });
      expect(outside).toMatchObject({
        jsonrpc: "2.0",
        id: "outside-authoring",
        result: {
          isError: true,
          structuredContent: { ok: false, error: { code: "script_compile_failed", message: expect.stringMatching(/approved authoring output root/) } }
        }
      });
      await expect(readFile(join(outsideRoot, "package", "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await withoutRoots?.close();
      await rooted?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("does not let raw Debug scriptPath calls use an output-only authoring grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cut-generate-root-transport-"));
    const inputRoot = join(root, "inputs");
    const outputRoot = join(root, "outputs");
    const scriptPath = join(inputRoot, "storyboard.json");
    const outDir = join(outputRoot, "connector-output");
    let server: MotionDebugServerHandle | undefined;
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 })]);
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8");
    try {
      server = await startMotionDebugServer({
        port: 0,
        capabilityToken: TOKEN,
        grantedTier: "write_local",
        context: { authoringOutputRoots: [outputRoot], scratchRoot: join(root, "scratch") },
        useDefaultTemplateRoots: false
      });
      const result = await postJson(new URL("/debug", server.url), {
        command: "motion.connector.cut_generate_to_cut",
        requestedTier: "write_local",
        args: { scriptPath, outDir, dryRunRender: true }
      }, HOST_UNAVAILABLE_STATUS);

      expect(result).toMatchObject({
        ok: false,
        command: "motion.connector.cut_generate_to_cut",
        error: { code: "capability_unavailable", message: expect.stringMatching(/scriptPath.*authoring input root/) }
      });
      await expect(readFile(join(outDir, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("marks an MCP Cut Generate-to-Cut output-root refusal as a tool error without creating its outside parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cut-generate-mcp-root-transport-"));
    const outputRoot = join(root, "outputs");
    const outsideOutDir = join(root, "outside-output", "connector-output");
    let server: MotionDebugServerHandle | undefined;
    await mkdir(outputRoot, { mode: 0o700 });
    try {
      server = await startMotionDebugServer({
        port: 0,
        capabilityToken: TOKEN,
        grantedTier: "write_local",
        context: { authoringOutputRoots: [outputRoot], scratchRoot: join(root, "scratch") },
        useDefaultTemplateRoots: false
      });
      const result = await postJson(new URL("/rpc", server.url), {
        jsonrpc: "2.0",
        id: "cut-generate-outside-output",
        method: "tools/call",
        params: {
          name: "motion_connector_cut_generate_to_cut",
          arguments: {
            requestedTier: "write_local",
            args: { script: scriptedVideo(), outDir: outsideOutDir, dryRunRender: true }
          }
        }
      });

      expect(result).toMatchObject({
        jsonrpc: "2.0",
        id: "cut-generate-outside-output",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            command: "motion.connector.cut_generate_to_cut",
            error: { code: "invalid_args", message: expect.stringMatching(/approved authoring output root/) }
          }
        }
      });
      await expect(lstat(join(root, "outside-output"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

async function postJson(url: URL, body: unknown, expectedStatus = 200): Promise<unknown> {
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(expectedStatus);
  return json;
}

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "transport-demo",
    name: "Transport Demo",
    sourceApp: "shellx-motion",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [{ id: "intro", title: "Transport roots", durationMs: 1000 }]
  };
}
