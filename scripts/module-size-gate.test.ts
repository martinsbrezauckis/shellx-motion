import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const gate = join(repositoryRoot, "scripts/module-size-gate.mjs");
const fixtureRoot = join(repositoryRoot, "scripts/fixtures/module-size-gate");
const temporaryRoots: string[] = [];

type Fixture = {
  expectedExit: number;
  expectedOutput: string;
  lines: number;
  relativePath: string;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function runFixture(name: string) {
  const fixture = JSON.parse(await readFile(join(fixtureRoot, `${name}.json`), "utf8")) as Fixture;
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-module-size-gate-"));
  temporaryRoots.push(root);
  const target = join(root, fixture.relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "// fixture line\n".repeat(fixture.lines));
  const result = spawnSync(process.execPath, [gate, "--root", root], { encoding: "utf8" });
  return { fixture, result };
}

describe("module-size-gate", () => {
  it("rejects an unknown production module above its package default", async () => {
    const { fixture, result } = await runFixture("unknown-production-module");
    expect(result.status).toBe(fixture.expectedExit);
    expect(result.stderr).toContain(fixture.expectedOutput);
  });

  it("allows a small unknown production module under its package default", async () => {
    const { fixture, result } = await runFixture("allowed-small-module");
    expect(result.status).toBe(fixture.expectedExit);
    expect(result.stdout).toContain(fixture.expectedOutput);
  });

  it("honors a reviewed legacy baseline only for its named existing path", async () => {
    const { fixture, result } = await runFixture("reviewed-legacy-exception");
    expect(result.status).toBe(fixture.expectedExit);
    expect(result.stdout).toContain(fixture.expectedOutput);
  });
});
