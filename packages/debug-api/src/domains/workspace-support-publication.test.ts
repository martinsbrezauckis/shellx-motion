import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";

const faults = vi.hoisted(() => ({
  failStageWrite: undefined as undefined | ((path: string) => boolean),
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  beforeStagedPublicationCommit: undefined as undefined | ((path: string, expectedInventory: unknown) => Promise<void>),
  failPosixAnchor: false,
  failTransactionCreate: false,
  transactionCreateCalls: 0,
  stagedPublicationCommitCalls: 0
}));

vi.mock("@shellx-motion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/core")>();
  return {
    ...actual,
    OutputDirectoryTransaction: {
      create: async (...args: Parameters<typeof actual.OutputDirectoryTransaction.create>) => {
        faults.transactionCreateCalls += 1;
        if (faults.failTransactionCreate) throw new Error("injected Windows output transaction reached");
        const transaction = await actual.OutputDirectoryTransaction.create(...args);
        return new Proxy(transaction, {
          get(target, property) {
            if (property === "commit") {
              return async (...commitArgs: Parameters<typeof target.commit>) => {
                faults.stagedPublicationCommitCalls += 1;
                await faults.beforeStagedPublicationCommit?.(target.stagingPath, commitArgs[0]);
                return await target.commit(...commitArgs);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    }
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags: string | number, mode?: number) => {
      if (faults.failStageWrite?.(path) && flags !== "r") throw new Error("injected support bundle staged-write failure");
      return await actual.open(path, flags, mode);
    },
    writeFile: async (path: string, data: string | Uint8Array, options?: unknown) => {
      if (faults.failStageWrite?.(path)) throw new Error("injected support bundle staged-write failure");
      await actual.writeFile(path, data, options as never);
    },
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      await faults.afterRename?.(from, to);
    }
  };
});

vi.mock("@shellx-motion/core/internal/trusted-host-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/core/internal/trusted-host-workspace")>();
  return {
    ...actual,
    createTrustedWorkspaceAnchor: async (path: string) => {
      if (faults.failPosixAnchor) throw new Error("POSIX workspace anchor must not run for injected Windows publication");
      return await actual.createTrustedWorkspaceAnchor(path);
    }
  };
});

import { dispatchDomainCommand } from "./router.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;

describe("motion.support.bundle governed directory publication", () => {
  itLinux("publishes exactly the bundle and required receipt from one private directory stage", async () => {
    const fixture = await createFixture();
    const result = await dispatchSupportBundle(fixture.root, fixture.outDir);

    expect(result).toMatchObject({
      ok: true,
      visibleState: { operation: "support.bundle", bundlePath: join(fixture.outDir, "support-bundle.json"), receiptPath: join(fixture.outDir, "support-bundle.receipt.json") }
    });
    expect((await readdir(fixture.outDir)).sort()).toEqual(["support-bundle.json", "support-bundle.receipt.json"]);
    const bundleBytes = await readFile(join(fixture.outDir, "support-bundle.json"));
    const receipt = JSON.parse(await readFile(join(fixture.outDir, "support-bundle.receipt.json"), "utf8")) as Record<string, any>;
    expect(receipt).toMatchObject({
      operation: "support.bundle",
      status: "passed",
      output: {
        bundle: { file: "support-bundle.json" },
        receipt: { file: "support-bundle.receipt.json" },
        bundleSha256: hashBuffer(bundleBytes),
        bundleByteLength: bundleBytes.byteLength
      },
      artifacts: [
        { role: "support_bundle", path: "support-bundle.json", primary: true },
        { role: "support_receipt", path: "support-bundle.receipt.json" }
      ]
    });
    expect(JSON.stringify(receipt)).not.toContain(fixture.outDir);
  });

  itLinux("omits absolute paths and path-bearing diagnostics from shareable support artifacts", async () => {
    const fixture = await createFixture();
    const receiptsRoot = join(fixture.root, "receipts");
    const result = await dispatchDomainCommand(
      "workspace",
      "motion.support.bundle",
      { outDir: fixture.outDir, receiptsRoot },
      {
        scratchRoot: fixture.root,
        receiptsRoot,
        isPathInsideTrustedRoot: async (trustedRoot, candidate) => isInside(trustedRoot, candidate),
        listReceiptEntries: async () => [{ path: "/host-private/receipts/render.receipt.json", receipt: {} as OperationReceipt }],
        summarizeReceipt: () => ({
          id: "render-final",
          operation: "render.final",
          status: "warning",
          packageId: "pkg_fixture",
          lane: "ffmpeg",
          createdAt: "2026-08-27T00:00:00.000Z",
          path: "/host-private/receipts/render.receipt.json",
          outputPath: "C:\\host-private\\render\\final.mp4",
          diagnostics: { "/host-private/diagnostics/raw.log": "raw host output" },
          warnings: [
            "diagnostic=/host-private/diagnostics with spaces/ffmpeg private.log",
            "output=C:\\host-private\\render with spaces\\final private.mp4",
            "home=~/Library/Application Support/Motion/private.log",
            "named-home=~martin/.config/motion/private.log",
            "rooted-drive=\\Users\\martin\\AppData\\Local\\Motion\\private.log"
          ]
        }),
        listPlatformReceiptEntries: async () => [{
          path: "/host-private/receipts/linux.platform.json",
          receipt: { schema: "shellx-motion/platform-verification@1" }
        }],
        summarizePlatformReceipt: () => ({
          schema: "shellx-motion/platform-verification@1",
          status: "passed",
          dryRun: false,
          commandCount: 38,
          path: "/host-private/receipts/linux.platform.json",
          diagnosticPath: "C:\\host-private\\platform.log"
        })
      }
    );

    expect(result).toMatchObject({ ok: true });
    if (!result?.ok) return;
    const bundle = await readFile(join(fixture.outDir, "support-bundle.json"), "utf8");
    const receipt = await readFile(join(fixture.outDir, "support-bundle.receipt.json"), "utf8");
    for (const forbidden of [fixture.root, "/host-private", "C:\\host-private", "diagnostics with spaces", "render with spaces", "ffmpeg private.log", "~/Library", "~martin", "\\Users\\martin", "platform.log"]) {
      expect(bundle).not.toContain(forbidden);
      expect(receipt).not.toContain(forbidden);
    }
    expect(JSON.parse(bundle)).toMatchObject({
      receipts: { receipts: [expect.objectContaining({ warnings: [
        "diagnostic=<redacted-host-path>",
        "output=<redacted-host-path>",
        "home=<redacted-host-path>",
        "named-home=<redacted-host-path>",
        "rooted-drive=<redacted-host-path>"
      ] })] },
      platformVerification: { receipts: [expect.objectContaining({ status: "passed", commandCount: 38 })] }
    });
  });

  it("uses the Windows transaction route without calling the POSIX workspace anchor", async () => {
    const fixture = await createFixture();
    faults.failPosixAnchor = true;
    faults.failTransactionCreate = true;

    const result = await dispatchSupportBundle(fixture.root, fixture.outDir, "win32");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "support_bundle_failed", message: "injected Windows output transaction reached" }
    });
    expect(faults.transactionCreateCalls).toBe(1);
  });

  it("refuses a prepopulated destination without overwriting its sentinel", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.outDir, { recursive: true, mode: 0o700 });
    const sentinel = join(fixture.outDir, "keep.txt");
    await writeFile(sentinel, "do not replace", "utf8");

    await expect(dispatchSupportBundle(fixture.root, fixture.outDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.support.bundle outDir must be absent before bundle collection." }
    });
    expect(await readFile(sentinel, "utf8")).toBe("do not replace");
    expect(await readdir(fixture.outDir)).toEqual(["keep.txt"]);
  });

  itLinux("refuses a second write and preserves the first complete bundle byte-for-byte", async () => {
    const fixture = await createFixture();
    await expect(dispatchSupportBundle(fixture.root, fixture.outDir)).resolves.toMatchObject({ ok: true });
    const firstBundle = await readFile(join(fixture.outDir, "support-bundle.json"));
    const firstReceipt = await readFile(join(fixture.outDir, "support-bundle.receipt.json"));

    await expect(dispatchSupportBundle(fixture.root, fixture.outDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.support.bundle outDir must be absent before bundle collection." }
    });
    expect(await readFile(join(fixture.outDir, "support-bundle.json"))).toEqual(firstBundle);
    expect(await readFile(join(fixture.outDir, "support-bundle.receipt.json"))).toEqual(firstReceipt);
  });

  itLinux("leaves no public bundle when staging fails before the final rename", async () => {
    const fixture = await createFixture();
    faults.failStageWrite = (path) => path.endsWith("support-bundle.receipt.json");

    await expect(dispatchSupportBundle(fixture.root, fixture.outDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "support_bundle_failed", message: "injected support bundle staged-write failure" }
    });
    await expect(stat(fixture.outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(fixture.outDir))).some((name) => name.startsWith(".bundle.shellx-motion-stage-"))).toBe(false);
  });

  itLinux("rejects a leaf added after preliminary stage verification before the final rename", async () => {
    const fixture = await createFixture();
    let hookFired = false;
    faults.beforeStagedPublicationCommit = async (path, expectedInventory) => {
      expect(path).toContain(".bundle.shellx-motion-stage-");
      expect(expectedInventory).toEqual([
        expect.objectContaining({ path: "support-bundle.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) }),
        expect.objectContaining({ path: "support-bundle.receipt.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) })
      ]);
      hookFired = true;
      await writeFile(join(path, "late-evidence.json"), "{}\n", "utf8");
    };

    await expect(dispatchSupportBundle(fixture.root, fixture.outDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "support_bundle_failed" }
    });
    expect(hookFired).toBe(true);
    expect(faults.stagedPublicationCommitCalls).toBe(1);
    await expect(stat(fixture.outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(fixture.outDir))).some((name) => name.startsWith(".bundle.shellx-motion-stage-"))).toBe(false);
  });

  itLinux("rejects a staged leaf replacement after preliminary verification before the final rename", async () => {
    const fixture = await createFixture();
    let hookFired = false;
    faults.beforeStagedPublicationCommit = async (path, expectedInventory) => {
      expect(path).toContain(".bundle.shellx-motion-stage-");
      expect(expectedInventory).toEqual([
        expect.objectContaining({ path: "support-bundle.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) }),
        expect.objectContaining({ path: "support-bundle.receipt.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) })
      ]);
      hookFired = true;
      await rm(join(path, "support-bundle.json"));
      await writeFile(join(path, "support-bundle.json"), "{\"replaced\":true}\n", "utf8");
    };

    await expect(dispatchSupportBundle(fixture.root, fixture.outDir)).resolves.toMatchObject({
      ok: false,
      error: { code: "support_bundle_failed" }
    });
    expect(hookFired).toBe(true);
    expect(faults.stagedPublicationCommitCalls).toBe(1);
    await expect(stat(fixture.outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(fixture.outDir))).some((name) => name.startsWith(".bundle.shellx-motion-stage-"))).toBe(false);
  });

  itLinux("reports authenticated post-rename uncertainty with the complete public bundle evidence", async () => {
    const fixture = await createFixture();
    faults.afterRename = async (from, to) => {
      if (to === fixture.outDir && from.includes(".bundle.shellx-motion-stage-")) {
        throw new Error("injected support bundle post-rename observation failure");
      }
    };

    const result = await dispatchSupportBundle(fixture.root, fixture.outDir) as Record<string, any>;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "publication_commit_uncertain",
        detail: {
          possiblyCommitted: true,
          publicPaths: [fixture.outDir],
          expectedPublications: [
            { publicPath: fixture.outDir, kind: "directory", expected: { entries: ["support-bundle.json", "support-bundle.receipt.json"] } }
          ]
        }
      },
      result: { possiblyCommitted: true, publicPaths: [fixture.outDir] }
    });
    expect((await readdir(fixture.outDir)).sort()).toEqual(["support-bundle.json", "support-bundle.receipt.json"]);
  });

  itLinux("reports uncertainty when a public leaf changes immediately after the final rename", async () => {
    const fixture = await createFixture();
    faults.afterRename = async (from, to) => {
      if (to === fixture.outDir && from.includes(".bundle.shellx-motion-stage-")) {
        await writeFile(join(to, "late-evidence.json"), "{}\n", "utf8");
      }
    };

    const result = await dispatchSupportBundle(fixture.root, fixture.outDir) as Record<string, any>;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "publication_commit_uncertain",
        detail: {
          possiblyCommitted: true,
          publicPaths: [fixture.outDir],
          expectedPublications: [
            { publicPath: fixture.outDir, kind: "directory", expected: { entries: ["support-bundle.json", "support-bundle.receipt.json"] } }
          ]
        }
      }
    });
    expect((await readdir(fixture.outDir)).sort()).toEqual(["late-evidence.json", "support-bundle.json", "support-bundle.receipt.json"]);
  });

  it.runIf(process.platform === "darwin")("macOS refuses closed-tree publication before creating an output or stage", async () => {
    await expectClosedTreeRefusal();
  });

  it.runIf(process.platform === "win32")("Windows refuses closed-tree publication before creating an output or stage", async () => {
    await expectClosedTreeRefusal();
  });
});

async function expectClosedTreeRefusal(): Promise<void> {
  const fixture = await createFixture();
  const result = await dispatchSupportBundle(fixture.root, fixture.outDir);

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "support_bundle_failed",
      message: /closed-tree publication requires a Linux descriptor-relative primitive/i
    }
  });
  await expect(stat(fixture.outDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(dirname(fixture.outDir))).rejects.toMatchObject({ code: "ENOENT" });
}

async function createFixture(): Promise<{ root: string; outDir: string }> {
  const root = resolve(await mkdtemp(join(tmpdir(), "shellx-motion-support-bundle-")));
  roots.push(root);
  return { root, outDir: join(root, "published", "bundle") };
}

async function dispatchSupportBundle(root: string, outDir: string, runtimePlatform?: NodeJS.Platform) {
  return await dispatchDomainCommand(
    "workspace",
    "motion.support.bundle",
    { outDir },
    {
      scratchRoot: root,
      ...(runtimePlatform ? { runtimePlatform } : {}),
      isPathInsideTrustedRoot: async (trustedRoot, candidate) => isInside(trustedRoot, candidate)
    }
  );
}

function isInside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

afterEach(async () => {
  faults.failStageWrite = undefined;
  faults.afterRename = undefined;
  faults.beforeStagedPublicationCommit = undefined;
  faults.failPosixAnchor = false;
  faults.failTransactionCreate = false;
  faults.transactionCreateCalls = 0;
  faults.stagedPublicationCommitCalls = 0;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});
