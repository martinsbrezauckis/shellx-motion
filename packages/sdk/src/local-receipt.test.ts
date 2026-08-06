import { hashBuffer } from "@shellx-motion/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPersistedReceipt } from "./local-receipt.js";

const roots: string[] = [];

describe("persisted local receipt verification", () => {
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("returns the exact disk hash for a matching package-local receipt", async () => {
    const root = await fixtureRoot();
    const expected = { id: "receipt-1", operation: "keying.apply", status: "passed" as const, packageId: "pkg-1" };
    const bytes = Buffer.from(`${JSON.stringify({ schema: "shellx-motion/receipt@1", ...expected })}\n`);
    const path = join(root, "receipts", "receipt-1.json");
    await mkdir(join(root, "receipts"));
    await writeFile(path, bytes);

    await expect(verifyPersistedReceipt(root, path, expected)).resolves.toBe(hashBuffer(bytes));
  });

  it("rejects a disk receipt whose operation identity differs from the result", async () => {
    const root = await fixtureRoot();
    const path = join(root, "receipt.json");
    await writeFile(path, JSON.stringify({
      schema: "shellx-motion/receipt@1", id: "receipt-1", operation: "roto.remove", status: "passed", packageId: "pkg-1",
    }));

    await expect(verifyPersistedReceipt(root, path, {
      id: "receipt-1", operation: "keying.apply", status: "passed", packageId: "pkg-1",
    })).rejects.toThrow("does not match the operation result");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-receipt-"));
  roots.push(root);
  return root;
}
