import { link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertHdr10PqExactBundleChildren, assertHdr10PqPinnedStagedFileCurrent, closeHdr10PqPinnedStagedFile, copyHdr10PqPinnedStagedFileExclusive, hashHdr10PqPinnedStagedFile, openHdr10PqPinnedStagedFile, removeHdr10PqPinnedStagedFile, writeHdr10PqExclusiveStagedReceipt } from "./hdr10-pq-staged-file.js";

describe("HDR10 staged-child no-follow authority", () => {
  it("hashes one unchanged private regular child from its held descriptor", async () => {
    await fixture(async (root) => { const output = join(root, "video.mp4"); await writeFile(output, "video"); const file = await openHdr10PqPinnedStagedFile(output, 1024); try { expect(await hashHdr10PqPinnedStagedFile(file)).toMatch(/^[a-f0-9]{64}$/); await expect(assertHdr10PqPinnedStagedFileCurrent(file)).resolves.toBeUndefined(); } finally { await closeHdr10PqPinnedStagedFile(file); } });
  });

  it.skipIf(process.platform === "win32")("refuses a staged symlink or hard-link without altering its source", async () => {
    await fixture(async (root) => { const source = join(root, "source.mp4"), symlinked = join(root, "video.mp4"), linked = join(root, "linked.mp4"); await writeFile(source, "source"); await symlink(source, symlinked); await expect(openHdr10PqPinnedStagedFile(symlinked, 1024)).rejects.toThrow(/regular|no-follow/i); await link(source, linked); await expect(openHdr10PqPinnedStagedFile(linked, 1024)).rejects.toThrow(/regular|unlinked/i); await expect(readFile(source, "utf8")).resolves.toBe("source"); });
  });

  it("rejects a post-hash pathname swap before publication", async () => {
    await fixture(async (root) => { const output = join(root, "video.mp4"), retained = join(root, "retained.mp4"); await writeFile(output, "original"); const file = await openHdr10PqPinnedStagedFile(output, 1024); try { await hashHdr10PqPinnedStagedFile(file); await rename(output, retained); await writeFile(output, "replacement"); await expect(assertHdr10PqPinnedStagedFileCurrent(file)).rejects.toThrow(/staged file/i); await expect(readFile(retained, "utf8")).resolves.toBe("original"); } finally { await closeHdr10PqPinnedStagedFile(file); } });
  });

  it("refuses an encoder-preplanted final name and accepts exactly the two host-owned final children", async () => {
    await fixture(async (root) => { const work = join(root, "work.mp4"), output = join(root, "video.mp4"), receipt = join(root, "receipt.json"); await writeFile(work, "work"); const pinned = await openHdr10PqPinnedStagedFile(work, 1024); try { await writeFile(output, "planted"); await expect(copyHdr10PqPinnedStagedFileExclusive(pinned, output, 1024)).rejects.toThrow(); await expect(readFile(output, "utf8")).resolves.toBe("planted"); await rm(output); const final = await copyHdr10PqPinnedStagedFileExclusive(pinned, output, 1024), receiptFile = await writeHdr10PqExclusiveStagedReceipt(receipt, Buffer.from("receipt")); try { await removeHdr10PqPinnedStagedFile(pinned); await writeFile(join(root, "encoder-sidecar"), "unexpected"); await expect(assertHdr10PqExactBundleChildren(root, final, receiptFile)).rejects.toThrow(/unexpected/i); await rm(join(root, "encoder-sidecar")); await expect(assertHdr10PqExactBundleChildren(root, final, receiptFile)).resolves.toBeUndefined(); } finally { await closeHdr10PqPinnedStagedFile(final); await closeHdr10PqPinnedStagedFile(receiptFile); } } finally { await closeHdr10PqPinnedStagedFile(pinned); } });
  });

  it.skipIf(process.platform === "win32")("creates a receipt exclusively and detects a replacement after readback", async () => {
    await fixture(async (root) => { const source = join(root, "source.json"), receipt = join(root, "receipt.json"); await writeFile(source, "source"); await symlink(source, receipt); await expect(writeHdr10PqExclusiveStagedReceipt(receipt, Buffer.from("receipt"))).rejects.toThrow(); await rm(receipt); const file = await writeHdr10PqExclusiveStagedReceipt(receipt, Buffer.from("receipt")); try { await rename(receipt, join(root, "retained.json")); await writeFile(receipt, "replacement"); await expect(assertHdr10PqPinnedStagedFileCurrent(file)).rejects.toThrow(/staged file/i); await expect(readFile(source, "utf8")).resolves.toBe("source"); } finally { await closeHdr10PqPinnedStagedFile(file); } });
  });
});

async function fixture(run: (root: string) => Promise<void>): Promise<void> { const root = await mkdtemp(join(tmpdir(), "shellx-motion-hdr10-staged-file-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
