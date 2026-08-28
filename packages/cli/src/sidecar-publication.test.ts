import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishJsonSidecar } from "./sidecar-publication.js";

const roots: string[] = [];
const STICKY_TMP_ROOT = "/tmp";
const SIDECARS = [
  { name: "native preview receipt", fileName: "pkg-sidecar-native-preview.receipt.json" },
  { name: "browser preview receipt", fileName: "pkg-sidecar-browser-preview.receipt.json" },
  { name: "GPU preview receipt", fileName: "pkg-sidecar-gpu-points-preview.receipt.json" },
  { name: "browser capture receipt", fileName: "pkg-sidecar-browser-capture.receipt.json" },
  { name: "browser capture workflow trace", fileName: "pkg-sidecar-browser-workflow.trace.json" }
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-sidecar-publication-"));
  roots.push(root);
  return root;
}

async function stickyWorkspace(): Promise<string> {
  if (process.platform === "win32") return workspace();
  const parent = await lstat(STICKY_TMP_ROOT);
  expect(parent.isDirectory()).toBe(true);
  expect(parent.mode & 0o1000).toBe(0o1000);
  const root = await mkdtemp(join(STICKY_TMP_ROOT, "shellx-motion-cli-sidecar-publication-"));
  roots.push(root);
  return root;
}

describe("CLI preview and capture sidecar publication", () => {
  it.each(SIDECARS)("publishes the $name through the ordinary sticky-parent route", async ({ fileName }) => {
    const root = await stickyWorkspace();
    const outputDir = join(root, "out");
    const sidecarPath = join(outputDir, fileName);
    await mkdir(outputDir, { mode: 0o700 });

    await publishJsonSidecar(sidecarPath, { schema: "shellx-motion/receipt@1", sidecar: fileName });

    await expect(readFile(sidecarPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ schema: "shellx-motion/receipt@1", sidecar: fileName }, null, 2)}\n`
    );
  });

  it.skipIf(process.platform === "win32").each(SIDECARS)("refuses a symlinked output parent for the $name", async ({ fileName }) => {
    const root = await workspace();
    const outside = join(root, "outside");
    const linkedOutputDir = join(root, "out");
    const sidecarPath = join(linkedOutputDir, fileName);
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, linkedOutputDir, "dir");

    await expect(publishJsonSidecar(sidecarPath, { sidecar: fileName }))
      .rejects.toMatchObject({ code: "derived_output_unsafe_parent" });
    await expect(readFile(join(outside, fileName), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32").each(SIDECARS)("refuses a sticky-parent route retarget before publishing the $name", async ({ fileName }) => {
    const root = await workspace();
    const outputDir = join(root, "out");
    const movedOutputDir = join(root, "out-moved");
    const outside = join(root, "outside");
    const sidecarPath = join(outputDir, fileName);
    await mkdir(outputDir, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });

    await expect(publishJsonSidecar(sidecarPath, { sidecar: fileName }, {
      afterStageVerified: async () => {
        await rename(outputDir, movedOutputDir);
        await symlink(outside, outputDir, "dir");
      }
    })).rejects.toMatchObject({ code: "derived_output_unsafe_parent" });

    await expect(readFile(join(outside, fileName), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
