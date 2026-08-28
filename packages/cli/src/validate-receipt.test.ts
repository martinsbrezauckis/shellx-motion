import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./main.js";

const roots: string[] = [];
const fixture = resolve("../../fixtures/packages/environment-rain-cinematic");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function copiedPackage(): Promise<{ root: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-validate-receipt-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await cp(fixture, packageRoot, { recursive: true });
  return { root, packageRoot };
}

describe("CLI validation receipts", () => {
  it("writes an attested pass outside the inspected package only when explicitly requested", async () => {
    const { root, packageRoot } = await copiedPackage();
    const receiptsRoot = join(root, "host-receipts");

    const result = await runCli(["validate", packageRoot, "--receipts-root", receiptsRoot]);

    expect(result).toMatchObject({
      ok: true,
      command: "validate",
      receiptId: expect.stringMatching(/^package-validate-/),
      receiptPath: expect.any(String),
    });
    expect(dirname(String(result.receiptPath))).toBe(receiptsRoot);
    expect(basename(String(result.receiptPath))).toMatch(/^package-validate-.*\.receipt\.json$/);
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8"));
    expect(receipt).toMatchObject({
      operation: "package.validate",
      status: "passed",
      packageId: "pkg_environment_rain_cinematic",
      lane: "validation",
      actor: { transport: "cli", grantedTier: "read_motion" }
    });
    expect(receipt.inputHashes).toMatchObject({
      "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
      "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("retains a failed schema verdict with the same typed receipt", async () => {
    const { root, packageRoot } = await copiedPackage();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    const environment = motion.layers.find((layer: { type: string }) => layer.type === "environment");
    environment.environment.backgroundColor = "midnightblue";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    const result = await runCli(["validate", packageRoot, "--receipts-root", join(root, "host-receipts")]);

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_motion_document" }, receiptPath: expect.any(String) });
    const receipt = JSON.parse(await readFile(String(result.receiptPath), "utf8"));
    expect(receipt).toMatchObject({
      operation: "package.validate",
      status: "failed",
      output: { valid: false, error: { code: "invalid_motion_document" } }
    });
  });

  it("refuses a requested receipt path inside the source package", async () => {
    const { packageRoot } = await copiedPackage();

    const result = await runCli(["validate", packageRoot, "--receipts-root", join(packageRoot, "receipts")]);

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await readdir(packageRoot)).not.toContain("receipts");
  });

  it("records a loader failure outside the source and fences it before any package-local write", async () => {
    const { root, packageRoot } = await copiedPackage();
    await writeFile(join(packageRoot, "motion.json"), "{ invalid JSON\n", "utf8");

    const failed = await runCli(["validate", packageRoot, "--receipts-root", join(root, "host-receipts")]);

    expect(failed).toMatchObject({ ok: false, error: { code: "invalid_args" }, receiptPath: expect.any(String) });
    const receipt = JSON.parse(await readFile(String(failed.receiptPath), "utf8"));
    expect(receipt).toMatchObject({
      operation: "package.validate",
      status: "failed",
      packageId: "unknown-package",
      output: {
        inputHashScope: "resolved_package_root_identity_only",
        error: { code: "invalid_args" },
      },
    });
    expect(receipt.inputHashes.resolvedPackageRootIdentity).toMatch(/^[a-f0-9]{64}$/);

    const fenced = await runCli(["validate", packageRoot, "--receipts-root", join(packageRoot, "receipts")]);
    expect(fenced).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await readdir(packageRoot)).not.toContain("receipts");
  });
});
