import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SETUP_FILE = "../../scripts/vitest-setup-job-stores.ts";

describe("workspace Vitest fixture setup", () => {
  it("wires every test-bearing package to the canonical private fixture setup", async () => {
    const packagesRoot = new URL("../packages/", import.meta.url);
    const entries = await readdir(packagesRoot, { withFileTypes: true });
    const missing: string[] = [];

    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const packageRoot = new URL(`${entry.name}/`, packagesRoot);
      const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8")) as {
        scripts?: { test?: unknown };
      };
      if (typeof manifest.scripts?.test !== "string") continue;
      const config = await readFile(new URL("vitest.config.ts", packageRoot), "utf8").catch(() => "");
      if (!config.includes(SETUP_FILE)) missing.push(entry.name);
    }

    expect(missing).toEqual([]);
  });
});
