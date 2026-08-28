import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Debug OTIO output authority", () => {
  it("refuses export when its fixed receipt leaf is a symlink", async ({ skip }) => {
    const packageRoot = await writeTimelinePackage();
    const tempRoot = await scratch("output-");
    const outside = await scratch("outside-");
    const outPath = join(tempRoot, "timeline.otio");
    const receiptTarget = join(outside, "receipt.json");
    try {
      await symlink(receiptTarget, `${outPath}.receipt.json`, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links.");
        return;
      }
      throw error;
    }

    const result = await dispatchDebugCommand(
      "motion.otio.export",
      { packageRoot, outPath, createdAt: "2026-07-04T10:00:30.000Z" },
      { tier: "write_local", authoringInputRoots: [packageRoot], authoringOutputRoots: [tempRoot] }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "otio_export_failed" } });
    await expect(readFile(receiptTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-debug-otio-${prefix}`));
  roots.push(root);
  return root;
}

async function writeTimelinePackage(): Promise<string> {
  const root = await scratch("package-");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_debug_otio_authority",
    name: "Debug OTIO Authority",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_debug_otio_authority",
    name: "Debug OTIO Authority",
    durationMs: 500,
    fps: 10,
    width: 64,
    height: 36,
    tracks: [{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }],
    layers: [{ id: "title", type: "text", text: "A", trackId: "overlay", startMs: 0, durationMs: 500 }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}
