import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";

const faults = vi.hoisted(() => ({
  writeLabel: undefined as string | undefined,
  symlinkLabel: undefined as string | undefined,
  symlinkTarget: undefined as string | undefined
}));

vi.mock("@shellx-motion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/core")>();
  return {
    ...actual,
    writeVerifiedBoundedFile: async (path: string, bytes: Buffer, options: { label?: string }) => {
      if (faults.symlinkLabel === options.label) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await symlink(faults.symlinkTarget!, path);
      }
      if (faults.writeLabel === options.label) throw new Error(`injected late package write failure: ${options.label}`);
      return await actual.writeVerifiedBoundedFile(path, bytes, options as never);
    }
  };
});

import { hashBuffer, loadMotionPackage } from "@shellx-motion/core";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "./index";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;

afterEach(async () => {
  faults.writeLabel = undefined;
  faults.symlinkLabel = undefined;
  faults.symlinkTarget = undefined;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

it("keeps stage mutation and test hooks out of the exported Script writer options", async () => {
  const source = await readFile(new URL("./scripted-package-publication.ts", import.meta.url), "utf8");
  const options = source.slice(source.indexOf("export interface WriteScriptedMotionPackageOptions"), source.indexOf("export interface WrittenScriptedMotionPackage"));

  expect(options).not.toMatch(/beforeCommit|finalizeReceipt|stagingPath|hook/i);
  expect(source).toContain("requireClosedTree: true");
  expect(source).toContain("await transaction.commit(expectedInventory)");
});

describe("Script complete-package publication", () => {
  itLinux("commits the exact sorted three-leaf package with a receipt that binds content without self-hashing", async () => {
    const root = await workspace();
    const packageDir = join(root, "compiled-package");
    const scripted = compiled("/host-private/input/storyboard.json");
    (scripted.receipt.output as Record<string, unknown>).upstreamArtifactPath = "/host-private/upstream.mov";
    (scripted.receipt as unknown as Record<string, unknown>).artifacts = [{ role: "upstream_artifact", path: "/host-private/upstream.mov", status: "available" }];
    (scripted.receipt as unknown as Record<string, unknown>).upstreamReceiptPath = "/host-private/upstream.receipt.json";
    scripted.receipt.warnings.push("/host-private/stage-warning");

    const written = await trusted(root, () => writeScriptedMotionPackage(scripted, { packageDir }));
    const receiptBytes = await readFile(written.receiptPath);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, any>;
    const manifest = await readFile(written.manifestPath);
    const motion = await readFile(written.motionPath);
    const leaves = await packageLeaves(packageDir);

    expect(leaves).toEqual(["manifest.json", "motion.json", "receipts/script-compile.receipt.json"]);
    expect(await trusted(root, () => loadMotionPackage(packageDir))).toMatchObject({ manifest: { id: "pkg_script_publication_demo" } });
    expect(written.receipt).toEqual(receipt);
    expect(receipt.operation).toBe("script.compile");
    expect(receipt.artifacts).toEqual([{ role: "motion_package", path: ".", status: "available", primary: true }]);
    expect(receipt.output).toMatchObject({
      packageRoot: ".",
      manifestPath: "manifest.json",
      motionPath: "motion.json",
      receiptPath: "receipts/script-compile.receipt.json",
      packageContentHashes: {
        "manifest.json": { sha256: hashBuffer(manifest), byteLength: manifest.byteLength },
        "motion.json": { sha256: hashBuffer(motion), byteLength: motion.byteLength }
      },
      packageContentInventory: {
        entryCount: 2,
        entries: [
          { path: "manifest.json", sha256: hashBuffer(manifest), byteLength: manifest.byteLength },
          { path: "motion.json", sha256: hashBuffer(motion), byteLength: motion.byteLength }
        ]
      }
    });
    const contentInventory = receipt.output.packageContentInventory.entries as Array<{ path: string; sha256: string; byteLength: number }>;
    const digestInput = contentInventory.map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
    expect(receipt.output.packageContentInventory.sha256).toBe(hashBuffer(Buffer.from(digestInput, "utf8")));
    expect(contentInventory.map((entry) => entry.path)).not.toContain("receipts/script-compile.receipt.json");
    const publicText = JSON.stringify({ receipt, leaves });
    expect(publicText).not.toContain(root);
    expect(publicText).not.toContain("/host-private");
    expect(publicText).not.toContain(".shellx-motion-stage");
    expect(publicText).not.toContain("upstream_artifact");
  });

  itLinux.each([
    ["sentinel", "sentinel.txt"],
    ["manifest collision", "manifest.json"],
    ["Motion collision", "motion.json"],
    ["receipt collision", "receipts/script-compile.receipt.json"]
  ])("refuses a pre-populated %s and preserves it", async (_label, leaf) => {
    const root = await workspace();
    const packageDir = join(root, "occupied-package");
    const collision = join(packageDir, leaf);
    await mkdir(dirname(collision), { recursive: true, mode: 0o700 });
    await writeFile(collision, "preserve\n", "utf8");

    await expect(trusted(root, () => writeScriptedMotionPackage(compiled(), { packageDir }))).rejects.toThrow(/not empty/i);
    await expect(readFile(collision, "utf8")).resolves.toBe("preserve\n");
  });

  itLinux("rejects an inserted staged leaf symlink without following it or exposing a package", async () => {
    const root = await workspace();
    const packageDir = join(root, "symlink-package");
    const outside = join(root, "outside.json");
    await writeFile(outside, "outside\n", "utf8");
    faults.symlinkLabel = "Script package receipts/script-compile.receipt.json";
    faults.symlinkTarget = outside;

    await expect(trusted(root, () => writeScriptedMotionPackage(compiled(), { packageDir }))).rejects.toThrow(/EEXIST/i);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  itLinux.each([
    "Script package manifest.json",
    "Script package motion.json",
    "Script package receipts/script-compile.receipt.json"
  ])("leaves no public package when %s fails late", async (label) => {
    const root = await workspace();
    const packageDir = join(root, "failed-package");
    faults.writeLabel = label;

    await expect(trusted(root, () => writeScriptedMotionPackage(compiled(), { packageDir })))
      .rejects.toThrow(`injected late package write failure: ${label}`);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses an oversized package value before whole-document JSON serialization", async () => {
    const root = await workspace();
    const packageDir = join(root, "oversized-package");
    const scripted = compiled();
    scripted.motion.layers[0]!.text = "x".repeat(64 * 1024 + 1);

    await expect(trusted(root, () => writeScriptedMotionPackage(scripted, { packageDir })))
      .rejects.toThrow("exceeds the 65536-byte Script package JSON string limit.");
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses accessor-backed package data without invoking it", async () => {
    const root = await workspace();
    const packageDir = join(root, "accessor-package");
    const scripted = compiled();
    let reads = 0;
    Object.defineProperty(scripted.motion, "layers", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? [] : [{ text: "x".repeat(17 * 1024 * 1024) }];
      }
    });

    await expect(trusted(root, () => writeScriptedMotionPackage(scripted, { packageDir })))
      .rejects.toThrow("accessors are not permitted");
    expect(reads).toBe(0);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "linux")("refuses the unsupported closed-tree root without a public package", async () => {
    const root = await workspace();
    const packageDir = join(root, "unsupported-root");

    await expect(writeScriptedMotionPackage(compiled(), { packageDir })).rejects.toThrow(/closed-tree publication requires a Linux descriptor-relative primitive/i);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function packageLeaves(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, String(entry));
    return (await stat(path)).isFile() ? String(entry).replaceAll("\\", "/") : undefined;
  }));
  return files.filter((entry): entry is string => entry !== undefined).sort();
}

function compiled(inputPath = "input/storyboard.json") {
  return convertScriptedFramesToMotionPackage({
    schema: "shellx-motion/scripted-video@1",
    id: "publication-demo",
    name: "Publication Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [{ id: "one", title: "One", durationMs: 1000 }]
  }, { createdAt: "2026-08-22T00:00:00.000Z", inputPath });
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-script-publication-"));
  roots.push(root);
  return root;
}

async function trusted<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
