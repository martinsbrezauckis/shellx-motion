import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST_INTERCHANGE_LIMITS } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { runCanvasMp4Export } from "./canvas-to-mp4";
import { runTemplateToCutConnector } from "./template-to-cut";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const tempDirs: string[] = [];
const canvasFixture = resolve("../../fixtures/canvas/shape-text-frame-selection.json");
const templateFixture = resolve("../../fixtures/cut-native-static-package");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("connector host-interchange admission", () => {
  it.runIf(process.platform === "linux")("refuses oversized and symlinked Canvas selections before creating output", async () => {
    const oversized = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-admission-large-"));
    const symlinked = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-admission-link-"));
    const parentLink = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-admission-parent-"));
    tempDirs.push(oversized, symlinked, parentLink);

    const oversizedPath = join(oversized, "selection.json");
    await writeFile(oversizedPath, Buffer.alloc(MAX_FILE_BYTES + 1));
    await expect(runInTrustedRoot(oversized, async () => await runCanvasMp4Export({ canvasSelectionPath: oversizedPath, outDir: join(oversized, "out") })))
      .rejects.toThrow(/bounded regular non-symlink/);

    const symlinkPath = join(symlinked, "selection.json");
    await symlink(canvasFixture, symlinkPath);
    await expect(runInTrustedRoot(symlinked, async () => await runCanvasMp4Export({ canvasSelectionPath: symlinkPath, outDir: join(symlinked, "out") })))
      .rejects.toThrow(/regular non-symlink/);

    const realInput = join(parentLink, "real-input");
    const linkedInput = join(parentLink, "linked-input");
    await mkdir(realInput, { mode: 0o700 });
    await cp(canvasFixture, join(realInput, "selection.json"));
    await symlink(realInput, linkedInput);
    await expect(runInTrustedRoot(parentLink, async () => await runCanvasMp4Export({ canvasSelectionPath: join(linkedInput, "selection.json"), outDir: join(parentLink, "out") })))
      .rejects.toThrow(/symlinked/);

    await Promise.all([oversized, symlinked, parentLink].map(async (root) => {
      await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    }));
  });

  it.runIf(process.platform === "linux")("counts a Canvas selection and all referenced assets against one aggregate budget before publication", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-admission-aggregate-"));
    tempDirs.push(root);
    const selection = JSON.parse(await readFile(canvasFixture, "utf8")) as Record<string, any>;
    const frame = selection.frames[0];
    selection.imageEditorOutputs = [];
    await mkdir(join(root, "assets"), { mode: 0o700 });
    for (let index = 0; index < 4; index += 1) {
      const assetId = `asset_${index}`;
      const path = `assets/${assetId}.png`;
      frame.layers.push({
        id: `image_${index}`,
        kind: "image",
        assetId,
        startMs: 0,
        durationMs: 1000,
        fit: "cover",
        transform: { x: index * 8, y: 0, width: 32, height: 32, opacity: 1 }
      });
      selection.imageEditorOutputs.push({ id: `output_${index}`, assetId, kind: "image", path, mimeType: "image/png", width: 1, height: 1, sha256: "sample", editStack: [] });
      await writeFile(join(root, path), Buffer.alloc(MAX_FILE_BYTES));
    }
    const selectionPath = join(root, "selection.json");
    await writeFile(selectionPath, JSON.stringify(selection));

    await expect(runInTrustedRoot(root, async () => await runCanvasMp4Export({ canvasSelectionPath: selectionPath, outDir: join(root, "out") })))
      .rejects.toThrow(/aggregate limit/);
    await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  it.runIf(process.platform === "linux")("refuses symlinked Template-to-Cut trees during source admission before delivery", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-template-admission-"));
    tempDirs.push(root);
    const source = join(root, "source");
    const outDir = join(root, "out");
    await cp(templateFixture, source, { recursive: true });
    await chmod(source, 0o700);
    await symlink(join(source, "motion.json"), join(source, "untrusted-link"));

    await expect(runInTrustedRoot(root, async () => await runTemplateToCutConnector({ packageRoot: source, values: {}, outDir })))
      .rejects.toThrow(/symlink/);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "linux")("refuses a Template-to-Cut source reached through a symlinked parent during source admission", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-template-admission-parent-"));
    tempDirs.push(root);
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    const outDir = join(root, "out");
    await mkdir(realParent, { mode: 0o700 });
    await cp(templateFixture, join(realParent, "source"), { recursive: true });
    await chmod(join(realParent, "source"), 0o700);
    await symlink(realParent, linkedParent);

    await expect(runInTrustedRoot(root, async () => await runTemplateToCutConnector({ packageRoot: join(linkedParent, "source"), values: {}, outDir })))
      .rejects.toThrow(/symlinked/);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "linux")("refuses a Template-to-Cut tree over the host aggregate limit during source admission", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-template-admission-aggregate-"));
    tempDirs.push(root);
    const source = join(root, "source");
    const outDir = join(root, "out");
    await cp(templateFixture, source, { recursive: true });
    await chmod(source, 0o700);
    await mkdir(join(source, "unrelated"), { mode: 0o700 });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(source, "unrelated", `${index}.bin`), Buffer.alloc(MAX_FILE_BYTES));
    }

    await expect(runInTrustedRoot(root, async () => await runTemplateToCutConnector({ packageRoot: source, values: {}, outDir })))
      .rejects.toThrow(/aggregate limit/);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  it.runIf(process.platform === "linux")("refuses empty-directory fanout at the package-tree entry limit before creating connector output", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-template-admission-tree-entries-"));
    tempDirs.push(root);
    const source = join(root, "source");
    const outDir = join(root, "out");
    await cp(templateFixture, source, { recursive: true });
    await chmod(source, 0o700);
    await mkdir(join(source, "empty"), { mode: 0o700 });
    for (let index = 0; index <= DEFAULT_HOST_INTERCHANGE_LIMITS.maxFiles; index += 1) {
      await mkdir(join(source, "empty", `dir-${index}`), { mode: 0o700 });
    }

    await expect(runInTrustedRoot(root, async () => await runTemplateToCutConnector({ packageRoot: source, values: {}, outDir })))
      .rejects.toThrow(/entry package-tree limit/);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function runInTrustedRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
  const anchor = await createTrustedWorkspaceAnchor(root);
  return await withTrustedWorkspaceAnchor(anchor, run);
}
