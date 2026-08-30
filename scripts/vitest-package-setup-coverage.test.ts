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

  it("keeps POSIX fixtures under project-owned scratch rather than trusting the ambient temp root", async () => {
    const setup = await readFile(new URL("./vitest-setup-job-stores.ts", import.meta.url), "utf8");

    expect(setup).toContain("hasAtomicCowAuthority(canonicalTempRoot)");
    expect(setup).toContain('join(projectRoot, ".scratch", "tests")');
    expect(setup).toContain("mkdtempSync(join(fixtureParent, \"vitest-\"))");
    expect(setup).toContain("SHELLX_MOTION_TEST_IPC_TMPDIR");
    expect(setup).not.toContain('from "@shellx-motion/core"');
  });
});
