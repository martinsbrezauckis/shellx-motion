import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCutGenerateToCutConnector } from "./cut-generate-to-cut";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform !== "linux")("Cut Generate-to-Cut platform refusal", () => {
  it("refuses closed-tree package publication before creating connector output state", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cut-generate-platform-refusal-"));
    roots.push(root);
    const outDir = join(root, "out");

    await expect(runCutGenerateToCutConnector({
      script: {},
      outDir,
      dryRunRender: true
    })).rejects.toThrow("requires a Linux descriptor-relative primitive");
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
