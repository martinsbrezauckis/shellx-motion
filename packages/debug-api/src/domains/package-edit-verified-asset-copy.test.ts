import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedStableFile } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { afterEach, describe, expect, it } from "vitest";
import { copyVerifiedAsset } from "./package-edit-verified-asset-copy.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("admitted package asset COW copy", () => {
  it("refuses a source replacement after bounded admission and before staged copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admitted-asset-"));
    tempDirs.push(root);
    const sourcePath = join(root, "incoming.bin");
    const stagedRoot = join(root, "staged");
    await mkdir(stagedRoot);
    await writeFile(sourcePath, "original", "utf8");
    const anchor = await createTrustedWorkspaceAnchor(root);
    const admitted = await withTrustedWorkspaceAnchor(anchor, async () => await readBoundedStableFile(sourcePath, {
      label: "test admitted source", maxBytes: 1024, withinRoot: root, requireSingleLink: true, captureIdentity: true,
    }));
    if (!admitted.identity) throw new Error("test fixture did not retain an identity");
    await writeFile(sourcePath, "replacement", "utf8");

    await expect(withTrustedWorkspaceAnchor(anchor, async () => await copyVerifiedAsset(stagedRoot, {
      sourcePath, sourceRoot: root, targetAssetRef: "assets/imported.bin", expectedSha256: admitted.sha256,
      expectedByteLength: admitted.byteLength, expectedIdentity: admitted.identity,
    }))).rejects.toMatchObject({ code: "source_changed" });
    await expect(readdir(stagedRoot)).resolves.toEqual([]);
  });
});
