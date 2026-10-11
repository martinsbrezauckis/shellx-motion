import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowFiles = ["verify.yml", "host-verify.yml", "dependency-review.yml", "codeql.yml", "sbom.yml"];
const currentPin = "37f2634a92ba38a0926ef79a0748ac8ae7d95ab2";
const oldPin = "d1ba80a13dd99fba24a470575428917156a28b43";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "motion-ci-contract-"));
  mkdirSync(join(root, "scripts/public"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  copyFileSync(join(sourceRoot, "scripts/public/ci-workflow-contract.mjs"),
    join(root, "scripts/public/ci-workflow-contract.mjs"));
  copyFileSync(join(sourceRoot, "package.json"), join(root, "package.json"));
  copyFileSync(join(sourceRoot, ".github/dependabot.yml"), join(root, ".github/dependabot.yml"));
  for (const name of workflowFiles) copyFileSync(join(sourceRoot, ".github/workflows", name),
    join(root, ".github/workflows", name));
  return { root, contract: join(root, "scripts/public/ci-workflow-contract.mjs"),
    codeql: join(root, ".github/workflows/codeql.yml") };
}

test("CI contract admits the reviewed CodeQL 4.37.8 init and analyze SHA", () => {
  const { root, contract } = fixture();
  try {
    const output = execFileSync(process.execPath, [contract], { encoding: "utf8" });
    expect(output).toMatch(/PASS CI workflow contract: 5 workflows/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI contract refuses a stale CodeQL SHA in either action", () => {
  const { root, contract, codeql } = fixture();
  try {
    const original = readFileSync(codeql, "utf8");
    for (const action of ["init", "analyze"]) {
      const changed = original.replace(`github/codeql-action/${action}@${currentPin}`,
        `github/codeql-action/${action}@${oldPin}`);
      expect(changed, `${action} fixture must change the pinned ref`).not.toBe(original);
      writeFileSync(codeql, changed);
      let failure: { status?: number; stderr?: string } | undefined;
      try {
        execFileSync(process.execPath, [contract], { encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        failure = error as { status?: number; stderr?: string };
      }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr).toContain(`CodeQL: github/codeql-action/${action} must use the reviewed SHA`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
