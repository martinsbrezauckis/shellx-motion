import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./main.js";

const repository = resolve(import.meta.dirname, "../../..");

describe("HTML snippet source-checkout CLI", () => {
  it("admits a checked source and fresh output below the module-derived workspace", async () => {
    const root = await mkdtemp(join(repository, ".scratch", "html-snippet-workspace-test-"));
    const packageRoot = join(root, "package");
    try {
      const result = await runCli([
        "html-snippet-import",
        join(repository, "fixtures/imports/html-snippet/input.html"),
        "--out",
        packageRoot,
        "--created-at",
        "2026-08-27T00:00:00.000Z",
      ]);

      expect(result).toMatchObject({ ok: true, command: "html-snippet-import", packageRoot });
      expect(JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"))).toMatchObject({
        schema: "shellx-motion/package-manifest@1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
