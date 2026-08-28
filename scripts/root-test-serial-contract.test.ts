import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("root test resource contract", () => {
  it("keeps public tests self-contained and layers implementation checks explicitly", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const rootTest = manifest.scripts?.test ?? "";
    const publicTests = manifest.scripts?.["test:public"] ?? "";
    const implementationTests = manifest.scripts?.["test:implementation"] ?? "";
    const scriptTests = manifest.scripts?.["test:scripts"] ?? "";
    const implementationScriptTests = manifest.scripts?.["test:scripts:implementation"] ?? "";
    const publicHygiene = manifest.scripts?.["source-hygiene:public"] ?? "";
    const implementationHygiene = manifest.scripts?.["source-hygiene:implementation"] ?? "";

    expect(rootTest).toBe("pnpm run test:public");
    expect(publicTests).toContain("--no-bail");
    expect(publicTests).toContain("--workspace-concurrency=1");
    expect(publicTests).toContain("--pool=forks --maxWorkers=1 --no-file-parallelism");
    expect(publicTests).not.toContain("templates/generators");
    expect(publicTests).not.toContain("source-hygiene:check");
    expect(publicHygiene).not.toContain("tracked-import-gate");
    expect(publicHygiene).not.toContain("publication-content-check");
    expect(implementationTests).toContain("source-hygiene:implementation");
    expect(implementationTests).toContain("test:generators");
    expect(implementationTests).toContain("test:public");
    expect(implementationTests).toContain("test:scripts:implementation");
    expect(implementationHygiene).toContain("tracked-import-gate");
    expect(implementationHygiene).toContain("publication-content-check");
    expect(scriptTests).toContain("--exclude scripts/qualify-v25c4-native.test.ts");
    expect(implementationScriptTests).toContain("scripts/qualify-v25c4-native.test.ts");
    expect(scriptTests).toContain("--pool=forks --maxWorkers=1 --no-file-parallelism");
  });
});
