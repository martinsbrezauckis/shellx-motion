import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { resolveGpuPreviewOutputPath } from "./gpu-preview-output";

const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("GPU preview output admission", () => {
  it("admits an ordinary nested output under a private root", async () => {
    const root = await testRoot();
    const outDir = join(root, "out");
    const outputPath = join(outDir, "nested", "frame.png");

    await expect(withTestWorkspace(root, async () =>
      await resolveGpuPreviewOutputPath("pkg", { outDir, outputPath })
    )).resolves.toBe(outputPath);
    await expect(lstat(join(outDir, "nested"))).resolves.toMatchObject({});
  });

  it("refuses a nested symlink before creating directories outside outDir", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("The standard Windows test account cannot create directory symbolic links.");
      return;
    }
    const root = await testRoot();
    const outDir = join(root, "out");
    const outside = join(root, "outside");
    await Promise.all([mkdir(outDir, { mode: 0o700 }), mkdir(outside, { mode: 0o700 })]);
    await symlink(outside, join(outDir, "linked"), "dir");

    await expect(withTestWorkspace(root, async () =>
      await resolveGpuPreviewOutputPath("pkg", {
        outDir,
        outputPath: join(outDir, "linked", "created", "frame.png"),
      })
    )).rejects.toThrow();
    await expect(lstat(join(outside, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked outDir before creating an outside output leaf", async ({ skip }) => {
    if (process.platform === "win32") {
      skip("The standard Windows test account cannot create directory symbolic links.");
      return;
    }
    const root = await testRoot();
    const outside = join(root, "outside");
    const outDir = join(root, "linked-output");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, outDir, "dir");

    await expect(withTestWorkspace(root, async () =>
      await resolveGpuPreviewOutputPath("pkg", { outDir, outputPath: join(outDir, "created", "frame.png") })
    )).rejects.toThrow();
    await expect(lstat(join(outside, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-output-"));
  roots.push(root);
  return root;
}

async function withTestWorkspace<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), operation);
}
