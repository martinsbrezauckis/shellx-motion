import { mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reserveStableReceiptRoot } from "./stable-receipt-root-reservation.js";

describe.skipIf(process.platform !== "linux")("stable receipt root reservation", () => {
  it("removes descriptor-written receipts when the configured root is retargeted", async () => {
    const parent = await mkdtemp(join(tmpdir(), "shellx-motion-stable-receipt-reservation-"));
    const receiptsRoot = join(parent, "receipts");
    const heldRoot = join(parent, "receipts-held");
    const outsideRoot = join(parent, "outside");
    let reservation: Awaited<ReturnType<typeof reserveStableReceiptRoot>> = null;
    try {
      await mkdir(receiptsRoot);
      await mkdir(outsideRoot);
      reservation = await reserveStableReceiptRoot(receiptsRoot);
      expect(reservation).not.toBeNull();
      await reservation!.writeJson("agent.receipt.json", { receipt: "bounded" });

      await rename(receiptsRoot, heldRoot);
      await symlink(outsideRoot, receiptsRoot, "dir");
      await reservation!.close();

      await expect(readdir(heldRoot)).resolves.toEqual([]);
    } finally {
      await reservation?.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
