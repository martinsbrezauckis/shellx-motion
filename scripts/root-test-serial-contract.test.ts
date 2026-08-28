import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("root test resource contract", () => {
  it("keeps public tests self-contained and layers implementation checks explicitly", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const rootTest = manifest.scripts?.test ?? "";
    const publicTests = manifest.scripts?.["test:public"] ?? "";
    const scriptTests = manifest.scripts?.["test:scripts"] ?? "";
    const publicHygiene = manifest.scripts?.["source-hygiene:public"] ?? "";

    expect(rootTest).toBe("pnpm run test:public");
    expect(publicTests).toContain("--workspace-concurrency=1");
    expect(publicTests).toContain("--pool=forks --maxWorkers=1 --no-file-parallelism");
    expect(publicTests).not.toContain("templates/generators");
    expect(publicTests).not.toContain("source-hygiene:check");
    expect(publicHygiene).not.toContain("tracked-import-gate");
    expect(scriptTests).toContain("--pool=forks --maxWorkers=1 --no-file-parallelism");
  });
});
