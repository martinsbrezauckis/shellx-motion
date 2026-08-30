import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashBuffer } from "@shellx-motion/core";
import { legacyCutGenerateMotionHash, writeCutGenerateJson } from "./cut-generate-to-cut-legacy-support";

it("retains Cut Generate's historical insertion-order motion hash", () => {
  const motion = { z: 1, a: { second: true, first: false } };
  expect(legacyCutGenerateMotionHash(motion)).toBe(hashBuffer(Buffer.from(JSON.stringify(motion), "utf8")));
});

it.skipIf(process.platform === "win32")("does not follow a late receipt symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cut-receipt-race-"));
  try {
    const receipts = join(root, "receipts");
    const target = join(root, "sentinel.json");
    const receipt = join(receipts, "render.receipt.json");
    await mkdir(receipts, { mode: 0o700 });
    await writeFile(target, "preserve sentinel", "utf8");
    await symlink(target, receipt);

    await expect(writeCutGenerateJson(receipt, { status: "passed" }, true)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(target, "utf8")).resolves.toBe("preserve sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
