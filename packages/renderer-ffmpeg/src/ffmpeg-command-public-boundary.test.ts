import { chmod, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolIdentityProbeRunner, type FfmpegCommand } from "./index.js";
import { establishDescriptorBoundToolExecution, executeDescriptorBoundTool, type DescriptorBoundToolExecution } from "./unadopted/descriptor-bound-tool-execution.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("FFmpeg descriptor execution boundary", () => {
  it.skipIf(process.platform === "win32")("ignores a forged descriptor field on the root-package command", async () => {
    const root = await fixtureRoot();
    const executable = join(root, "declared-tool");
    await writeExecutable(executable, "declared-root-command");
    const decoy = await open("/bin/echo", "r");
    try {
      const result = await createToolIdentityProbeRunner("ffmpeg")({
        executable,
        args: ["-version"],
        shell: false,
        // This cast models an arbitrary JavaScript caller adding an undeclared field at runtime.
        executableFd: decoy.fd,
      } as unknown as FfmpegCommand);
      expect(result).toMatchObject({ exitCode: 0, stdout: "declared-root-command\n" });
    } finally {
      await decoy.close();
    }
  });

  it.skipIf(process.platform !== "linux")("executes the retained descriptor rather than reopening the declared pathname", async () => {
    const root = await fixtureRoot();
    const executable = join(root, "retained-tool");
    const replacement = join(root, "replacement-tool");
    await writeExecutable(executable, "retained-descriptor");
    await writeExecutable(replacement, "replacement-pathname");
    const handle = await open(executable, "r");
    try {
      const execution = establishDescriptorBoundToolExecution(handle);
      await rename(replacement, executable);
      const result = await executeDescriptorBoundTool(execution, { executable, args: ["-version"], shell: false });
      expect(result).toMatchObject({ exitCode: 0, stdout: "retained-descriptor\n" });
    } finally {
      await handle.close();
    }
  });

  it("rejects a structurally forged descriptor authority", async () => {
    await expect(executeDescriptorBoundTool(
      Object.freeze({}) as DescriptorBoundToolExecution,
      { executable: "ffmpeg", args: ["-version"], shell: false }
    )).rejects.toThrow("was not established by this process");
  });

  it("keeps the V2 descriptor helper unadopted and absent from installed exports", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> };
    };
    expect(manifest.exports["./unadopted/descriptor-bound-tool-execution"])
      .toBe("./src/unadopted/descriptor-bound-tool-execution.ts");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./unadopted/descriptor-bound-tool-execution");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/descriptor-bound-tool-execution");
  });
});

// Root-package command types intentionally carry no descriptor authority.
if (false) {
  // @ts-expect-error Descriptor selection is a non-root, opaque renderer authority.
  const rejectedByPublicType: FfmpegCommand = { executable: "ffmpeg", executableFd: 3, args: [], shell: false };
  void rejectedByPublicType;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-descriptor-"));
  roots.push(root);
  return root;
}

async function writeExecutable(path: string, marker: string): Promise<void> {
  await writeFile(path, ["#!/bin/sh", `printf '%s\\n' '${marker}'`, ""].join("\n"), { mode: 0o700 });
  await chmod(path, 0o700);
}
