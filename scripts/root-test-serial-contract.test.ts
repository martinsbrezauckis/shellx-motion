import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_TEST_CHILDREN } from "./run-public-test-children";

describe("root test resource contract", () => {
  it("keeps public tests self-contained and layers implementation checks explicitly", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const rootTest = manifest.scripts?.test ?? "";
    const publicTests = manifest.scripts?.["test:public"] ?? "";
    const scriptTests = manifest.scripts?.["test:scripts"] ?? "";
    const publicHygiene = manifest.scripts?.["source-hygiene:public"] ?? "";

    expect(rootTest).toBe("pnpm run test:public");
    expect(publicTests).toBe("tsx scripts/run-public-test-children.ts");
    expect(PUBLIC_TEST_CHILDREN.map((child) => child.command)).toEqual([
      "pnpm run source-hygiene:public",
      "pnpm docs:check",
      "pnpm run args:check",
      "pnpm run version:check",
      "pnpm run architecture:check",
      "pnpm run corpus:check",
      "pnpm run test:scripts",
      "pnpm -r --no-bail --workspace-concurrency=1 --if-present run test --pool=forks --maxWorkers=1 --no-file-parallelism",
    ]);
    expect(PUBLIC_TEST_CHILDREN.at(-1)?.args).toEqual([
      "-r", "--no-bail", "--workspace-concurrency=1", "--if-present", "run", "test", "--pool=forks", "--maxWorkers=1", "--no-file-parallelism",
    ]);
    expect(publicTests).not.toContain("templates/generators");
    expect(publicTests).not.toContain("source-hygiene:check");
    expect(publicHygiene).not.toContain("tracked-import-gate");
    expect(scriptTests).toContain("--pool=forks --maxWorkers=1 --no-file-parallelism");
  });
});
