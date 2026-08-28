import { mkdtemp, mkdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { releasePrivateCaptureDirectory } from "./gpu-restricted-shader-hybrid";

describe("GPU restricted shader hybrid capture cleanup", () => {
  it("revalidates and removes only its exact empty child, leaving caller scratch intact", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "motion-gpu-restricted-cleanup-"));
    const child = join(scratch, "owned-capture");
    await mkdir(child);
    let assertions = 0;
    try {
      await releasePrivateCaptureDirectory({ path: child, async assertCurrent() { assertions += 1; } });
      expect(assertions).toBe(1);
      await expect(stat(child)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(scratch)).isDirectory()).toBe(true);
    } finally {
      await rmdir(scratch).catch(() => undefined);
    }
  });

  it("fails closed for unexpected child contents and leaves both the child and caller scratch", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "motion-gpu-restricted-cleanup-"));
    const child = join(scratch, "owned-capture");
    const unexpected = join(child, "unexpected-receipt");
    await mkdir(child);
    await writeFile(unexpected, "unexpected");
    try {
      await expect(releasePrivateCaptureDirectory({ path: child, async assertCurrent() {} })).rejects.toMatchObject({ code: expect.stringMatching(/^ENOTEMPTY|EEXIST$/) });
      expect((await stat(child)).isDirectory()).toBe(true);
      expect((await stat(scratch)).isDirectory()).toBe(true);
    } finally {
      await unlink(unexpected).catch(() => undefined);
      await rmdir(child).catch(() => undefined);
      await rmdir(scratch).catch(() => undefined);
    }
  });
});
