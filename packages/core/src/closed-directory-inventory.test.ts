import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt,
  assertExactDirectoryInventorySnapshotAt,
  captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt,
  captureCompleteExactDirectoryInventorySnapshotAt,
  type CompleteDirectoryInventoryEntry,
  captureExactDirectoryInventorySnapshotAt,
  type ExactDirectoryInventoryEntry
} from "./derived-output-publication-private";
import { OutputDirectoryTransaction } from "./output-directory-transaction";
import { captureOutputDirectoryIdentity } from "./output-path-topology";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

function inventory(...files: readonly [string, string][]): ExactDirectoryInventoryEntry[] {
  return files.map(([path, contents]) => ({ path, byteLength: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") }));
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-closed-tree-"));
  roots.push(root);
  return root;
}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Error>((resolve) => { timeout = setTimeout(() => resolve(new Error("closed-tree verification timed out")), milliseconds); })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe.skipIf(process.platform !== "linux")("closed directory inventory", () => {
  it("derives a complete sorted private-stage inventory without accepting caller leaf data", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const stage = join(root, "stage");
      await mkdir(join(stage, "assets"), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, "motion.json"), "motion\n", "utf8");
      await writeFile(join(stage, "assets", "pixel.bin"), "pixel\n", "utf8");
      await chmod(stage, 0o700);
      const identity = await captureOutputDirectoryIdentity(stage, "closed-tree stage", { private: true });

      const snapshot = await captureCompleteExactDirectoryInventorySnapshotAt(stage, identity, "closed-tree stage");
      expect(snapshot.evidence.entries).toEqual(["assets/pixel.bin", "motion.json"]);
      expect(snapshot.evidence.inventory).toEqual(inventory(["assets/pixel.bin", "pixel\n"], ["motion.json", "motion\n"]));
      const optIn = await captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, identity, "closed-tree stage");
      expect(optIn.evidence).toMatchObject({ sha256: snapshot.evidence.sha256, entryCount: snapshot.evidence.entryCount, leafCount: snapshot.evidence.entryCount });
      expect(optIn.evidence.inventory).toEqual(snapshot.evidence.inventory);

      await writeFile(join(stage, "late.txt"), "late\n", "utf8");
      await expect(assertExactDirectoryInventorySnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed-tree stage"))
        .rejects.toThrow(/unknown or missing/i);
    });
  });

  it("refuses an empty nested directory rather than silently omitting it from a leaf inventory", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const stage = join(root, "stage");
      await mkdir(join(stage, "assets", "empty"), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, "motion.json"), "motion\n", "utf8");
      await chmod(stage, 0o700);
      const identity = await captureOutputDirectoryIdentity(stage, "closed-tree stage", { private: true });
      await expect(captureCompleteExactDirectoryInventorySnapshotAt(stage, identity, "closed-tree stage"))
        .rejects.toThrow(/empty directory/i);
    });
  });

  it("pins explicit empty-directory rows, then refuses content or identity tampering", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const stage = join(root, "stage");
      const retained = join(root, "retained-empty");
      await mkdir(join(stage, "assets", "empty"), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, "motion.json"), "motion\n", "utf8");
      await chmod(stage, 0o700);
      const identity = await captureOutputDirectoryIdentity(stage, "closed complete-tree stage", { private: true });
      const snapshot = await captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, identity, "closed complete-tree stage");

      expect(snapshot.evidence.inventory).toEqual([
        { path: "assets/empty", kind: "empty-directory" },
        ...inventory(["motion.json", "motion\n"])
      ]);
      expect(snapshot.evidence).toMatchObject({ entryCount: 2, leafCount: 1 });
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed complete-tree stage"))
        .resolves.toMatchObject({ entryCount: 2, leafCount: 1 });

      await writeFile(join(stage, "assets", "empty", "late.txt"), "late\n", "utf8");
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed complete-tree stage"))
        .rejects.toThrow(/unknown or missing/i);
      await rm(join(stage, "assets", "empty", "late.txt"));
      await rename(join(stage, "assets", "empty"), retained);
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed complete-tree stage"))
        .rejects.toThrow(/unknown or missing/i);
      await rename(retained, join(stage, "assets", "empty"));
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed complete-tree stage"))
        .resolves.toMatchObject({ entryCount: 2, leafCount: 1 });
      await rename(join(stage, "assets", "empty"), retained);
      await symlink(retained, join(stage, "assets", "empty"), "dir");
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed complete-tree stage"))
        .rejects.toThrow(/symbolic link|topology|non-symlink/i);
      await rm(join(stage, "assets", "empty"));
      await mkdir(join(stage, "assets", "empty"), { mode: 0o700 });
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, snapshot.evidence.inventory, identity, snapshot, "closed complete-tree stage"))
        .rejects.toThrow(/changed after Motion captured|identity was pinned/i);
    });
  });

  it("rejects a complete-tree empty-directory marker with descendants", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const stage = join(root, "stage");
      await mkdir(join(stage, "assets", "empty"), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, "motion.json"), "motion\n", "utf8");
      await chmod(stage, 0o700);
      const identity = await captureOutputDirectoryIdentity(stage, "closed complete-tree stage", { private: true });
      const snapshot = await captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, identity, "closed complete-tree stage");
      const forged: CompleteDirectoryInventoryEntry[] = [
        ...snapshot.evidence.inventory,
        { path: "assets/empty/forged.txt", byteLength: 0, sha256: createHash("sha256").update("").digest("hex") }
      ];
      await expect(assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(stage, forged, identity, snapshot, "closed complete-tree stage"))
        .rejects.toThrow(/empty-directory marker with descendants/i);
    });
  });

  it("publishes nested manifest, Motion, receipt, and asset leaves as one pinned closed tree", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const outDir = join(root, "package");
      const transaction = await OutputDirectoryTransaction.create(outDir, { requireAbsent: true });
      const entries = inventory(
        ["manifest.json", "{\"id\":\"demo\"}\n"],
        ["motion.json", "{\"version\":1}\n"],
        ["receipts/export.final.json", "{\"ok\":true}\n"],
        ["assets/images/logo.txt", "pixel bytes\n"]
      );
      await mkdir(join(transaction.stagingPath, "receipts"), { recursive: true });
      await mkdir(join(transaction.stagingPath, "assets", "images"), { recursive: true });
      for (const entry of entries) await writeFile(join(transaction.stagingPath, entry.path), entry.path === "manifest.json" ? "{\"id\":\"demo\"}\n" : entry.path === "motion.json" ? "{\"version\":1}\n" : entry.path === "receipts/export.final.json" ? "{\"ok\":true}\n" : "pixel bytes\n");

      await transaction.commit(entries);
      await transaction.assertPublishedCurrent();
      await expect(readFile(join(outDir, "assets", "images", "logo.txt"), "utf8")).resolves.toBe("pixel bytes\n");
      await expect(stat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each([
    ["extra leaf", inventory(["manifest.json", "manifest\n"]), [["manifest.json", "manifest\n"], ["notes.txt", "extra\n"]]],
    ["missing leaf", inventory(["manifest.json", "manifest\n"], ["motion.json", "motion\n"]), [["manifest.json", "manifest\n"]]],
    ["byte mismatch", [{ ...inventory(["manifest.json", "manifest\n"])[0]!, byteLength: 1 }], [["manifest.json", "manifest\n"]]],
    ["hash mismatch", [{ ...inventory(["manifest.json", "manifest\n"])[0]!, sha256: "0".repeat(64) }], [["manifest.json", "manifest\n"]]]
  ] as const)("refuses %s before rename and leaves the public path absent", async (_case, expected, files) => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const outDir = join(root, "package");
      const transaction = await OutputDirectoryTransaction.create(outDir, { requireAbsent: true });
      for (const [path, contents] of files) await writeFile(join(transaction.stagingPath, path), contents);
      const refusal = await transaction.commit(expected).catch((error) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).not.toMatchObject({ code: "publication_commit_uncertain" });
      expect(refusal).toMatchObject({ message: expect.stringMatching(/unknown|missing|expected|inventory|regular file|bytes/i) });
      await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      await transaction.abort();
      await expect(lstat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["leaf", "directory"] as const)("refuses a symlink %s without following it", async (kind) => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const outDir = join(root, "package");
      const outside = join(root, "outside");
      const transaction = await OutputDirectoryTransaction.create(outDir, { requireAbsent: true });
      await mkdir(outside);
      await writeFile(join(outside, "asset.txt"), "outside\n");
      const expected = inventory(["assets/asset.txt", "outside\n"]);
      if (kind === "leaf") {
        await mkdir(join(transaction.stagingPath, "assets"));
        await symlink(join(outside, "asset.txt"), join(transaction.stagingPath, "assets", "asset.txt"));
      } else {
        await symlink(outside, join(transaction.stagingPath, "assets"), "dir");
      }
      await expect(transaction.commit(expected)).rejects.toThrow(/symbolic link|non-symlink directory|topology|unknown/i);
      await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["leaf", "parent"] as const)("pins same-user nested %s identity after the initial closed-tree read", async (kind) => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const stage = join(root, "stage");
      const retained = join(root, "retained");
      const expected = inventory(["assets/asset.txt", "same bytes\n"]);
      await mkdir(join(stage, "assets"), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, "assets", "asset.txt"), "same bytes\n");
      const identity = await captureOutputDirectoryIdentity(stage, "closed-tree stage", { private: true });
      const snapshot = await captureExactDirectoryInventorySnapshotAt(stage, expected, identity, "closed-tree stage");
      if (kind === "leaf") {
        await rename(join(stage, "assets", "asset.txt"), retained);
        await writeFile(join(stage, "assets", "asset.txt"), "same bytes\n");
      } else {
        await rename(join(stage, "assets"), retained);
        await mkdir(join(stage, "assets"));
        await writeFile(join(stage, "assets", "asset.txt"), "same bytes\n");
      }
      await expect(assertExactDirectoryInventorySnapshotAt(stage, expected, identity, snapshot, "closed-tree stage")).rejects.toThrow(/changed after Motion captured|identity was pinned/i);
    });
  });

  it("preserves a rejected closed stage instead of recursively rolling back a symlinked replacement", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const outDir = join(root, "package");
      const outside = join(root, "outside");
      const transaction = await OutputDirectoryTransaction.create(outDir, { requireAbsent: true });
      await mkdir(outside);
      await writeFile(join(outside, "asset.txt"), "outside\n");
      await symlink(outside, join(transaction.stagingPath, "assets"), "dir");
      await expect(transaction.commit(inventory(["assets/asset.txt", "outside\n"]))).rejects.toThrow(/symbolic link|non-symlink directory|topology|unknown/i);
      await transaction.abort();
      expect((await lstat(join(transaction.stagingPath, "assets"))).isSymbolicLink()).toBe(true);
      await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses the 2,049th actual entry before retaining or sorting beyond the closed-tree cap", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const transaction = await OutputDirectoryTransaction.create(join(root, "package"), { requireAbsent: true });
      for (let index = 0; index < 2_049; index += 1) {
        await writeFile(join(transaction.stagingPath, `entry-${String(index).padStart(4, "0")}.txt`), "x\n");
      }
      await expect(transaction.commit(inventory(["entry-0000.txt", "x\n"]))).rejects.toThrow(/entry limit/i);
      await transaction.abort();
      await expect(lstat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects an oversized proxy inventory before any element getter can execute", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const transaction = await OutputDirectoryTransaction.create(join(root, "package"), { requireAbsent: true });
      const oversized = new Array<ExactDirectoryInventoryEntry>(1_025);
      let getterCalls = 0;
      Object.defineProperty(oversized, "0", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error("inventory element getter ran");
        }
      });
      const hostile = new Proxy(oversized, {
        get(target, property, receiver) {
          if (property !== "length") getterCalls += 1;
          return Reflect.get(target, property, receiver);
        }
      });
      await expect(transaction.commit(hostile)).rejects.toThrow(/file limit/i);
      expect(getterCalls).toBe(0);
      await transaction.abort();
      await expect(lstat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects accessor or toJSON inventory entries without executing either", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const transaction = await OutputDirectoryTransaction.create(join(root, "package"), { requireAbsent: true });
      let accessorCalls = 0;
      const hostile = {} as Record<string, unknown>;
      Object.defineProperties(hostile, {
        path: { enumerable: true, get: () => { accessorCalls += 1; return "manifest.json"; } },
        sha256: { enumerable: true, value: "0".repeat(64) },
        byteLength: { enumerable: true, value: 0 },
        toJSON: { enumerable: false, value: () => { accessorCalls += 1; return {}; } }
      });
      await expect(transaction.commit([hostile] as unknown as ExactDirectoryInventoryEntry[])).rejects.toThrow(/exactly path|data descriptors/i);
      expect(accessorCalls).toBe(0);
      await transaction.abort();
      await expect(lstat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a FIFO promptly without a writer and safely cleans the ordinary pre-rename stage", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const transaction = await OutputDirectoryTransaction.create(join(root, "package"), { requireAbsent: true });
      const fifo = join(transaction.stagingPath, "asset.fifo");
      await execFileAsync("mkfifo", [fifo]);
      const outcome = await settleWithin(transaction.commit(inventory(["asset.fifo", ""])).then(() => "committed", (error: unknown) => error), 1_000);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).not.toMatch(/timed out/i);
      expect(outcome).not.toMatchObject({ code: "publication_commit_uncertain" });
      await transaction.abort();
      await expect(lstat(transaction.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves a root pathname retargeted to a symlink rather than recursively deleting it", async () => {
    const root = await scratch();
    await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => {
      const transaction = await OutputDirectoryTransaction.create(join(root, "package"), { requireAbsent: true });
      const retained = join(root, "retained-stage");
      const outside = join(root, "outside");
      await mkdir(outside);
      await rename(transaction.stagingPath, retained);
      await symlink(outside, transaction.stagingPath, "dir");
      await expect(transaction.commit(inventory(["manifest.json", "{}\n"]))).rejects.toThrow(/topology is unsafe|private non-symlink|symbolic link/i);
      await transaction.abort();
      expect((await lstat(transaction.stagingPath)).isSymbolicLink()).toBe(true);
      expect((await lstat(retained)).isDirectory()).toBe(true);
    });
  });
});
