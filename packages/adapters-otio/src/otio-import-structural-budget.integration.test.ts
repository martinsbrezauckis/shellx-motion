import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importOtioTimelineToMotionPackage } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("OTIO import structural budget", () => {
  it("refuses excessive unsupported-item diagnostics before package publication", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-budget-source-"));
    const packageDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-budget-package-"));
    tempDirs.push(sourceDir, packageDir);
    const otioPath = join(sourceDir, "amplified.otio");
    await writeFile(otioPath, JSON.stringify({
      OTIO_SCHEMA: "Timeline.1",
      name: "Amplified",
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: [{ OTIO_SCHEMA: "Track.1", name: "Video", kind: "Video", children: Array.from({ length: 1_025 }, () => ({})) }]
      }
    }), "utf8");

    await expect(importOtioTimelineToMotionPackage({ otioPath, packageDir }))
      .rejects.toThrow("1024-finding lossiness limit");
    await expect(readFile(join(packageDir, "manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
