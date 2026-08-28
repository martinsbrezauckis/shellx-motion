import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { readDebugJson } from "./debug-json-read.js";

describe("readDebugJson", () => {
  it("reads ordinary bounded JSON but refuses oversized and symbolic-link inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-json-"));
    const valid = join(root, "valid.json");
    const oversized = join(root, "oversized.json");
    const link = join(root, "link.json");
    await writeFile(valid, '{"schema":"example@1"}\n');
    await writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));

    const anchor = await createTrustedWorkspaceAnchor(root);
    await expect(withTrustedWorkspaceAnchor(anchor, async () => await readDebugJson(valid, root))).resolves.toEqual({ schema: "example@1" });
    await expect(withTrustedWorkspaceAnchor(anchor, async () => await readDebugJson(oversized, root))).rejects.toThrow(/bounded regular non-symlink file/);
    try {
      await symlink(valid, link, "file");
    } catch {
      return;
    }
    await expect(withTrustedWorkspaceAnchor(anchor, async () => await readDebugJson(link, root))).rejects.toThrow(/bounded regular non-symlink file/);
  });
});
