import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_TEST_CHILDREN } from "./run-public-test-children";

describe("root test resource contract", () => {
  it("keeps the root test route serial and the advertised scripts self-contained", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const rootTest = manifest.scripts?.test ?? "";
    const publicTests = manifest.scripts?.["test:public"] ?? "";
    const scriptTests = manifest.scripts?.["test:scripts"] ?? "";
    const publicHygiene = manifest.scripts?.["source-hygiene:public"] ?? "";

    expect(rootTest).toBe("pnpm run test:public");
    expect(publicTests).toBe("tsx scripts/public/run-public-test-children.ts");
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
    const workspaceArgs = [
      "-r", "--no-bail", "--workspace-concurrency=1", "--if-present", "run", "test", "--pool=forks", "--maxWorkers=1", "--no-file-parallelism",
    ];
    expect(PUBLIC_TEST_CHILDREN.at(-1)?.executable).toBe(process.platform === "win32" ? "cmd.exe" : "pnpm");
    expect(PUBLIC_TEST_CHILDREN.at(-1)?.args).toEqual(process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd", ...workspaceArgs]
      : workspaceArgs);
    expect(manifest.scripts?.["source-hygiene:check"]).toBe("pnpm run source-hygiene:public && node scripts/public/tracked-import-gate.mjs");
    expect(publicHygiene).toContain("shipping-imports-gate.mjs");
    expect(scriptTests).toContain("--pool=forks --maxWorkers=1 --no-file-parallelism");
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      for (const match of command.matchAll(/(?:scripts|templates)\/[A-Za-z0-9./_-]+\.(?:mjs|ts|py)/g)) {
        expect(existsSync(new URL(`../../${match[0]}`, import.meta.url)), `${name} references missing ${match[0]}`).toBe(true);
      }
      for (const match of command.matchAll(/\bpnpm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)/g)) {
        expect(manifest.scripts?.[match[1]], `${name} references missing alias ${match[1]}`).toBeDefined();
      }
      for (const match of command.matchAll(/\bpnpm(?:\.cmd)?\s+([A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9:_-]+)/g)) {
        expect(manifest.scripts?.[match[1]], `${name} references missing alias ${match[1]}`).toBeDefined();
      }
    }
    for (const child of PUBLIC_TEST_CHILDREN) {
      for (const match of child.command.matchAll(/\bpnpm(?:\.cmd)?\s+([A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9:_-]+)/g)) {
        expect(manifest.scripts?.[match[1]], `root test references missing alias ${match[1]}`).toBeDefined();
      }
    }
  });
});
