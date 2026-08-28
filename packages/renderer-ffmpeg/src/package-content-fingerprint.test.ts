import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MOTION_PACKAGE_CONTENT_FINGERPRINT_SCHEMA,
  fingerprintResolvedMotionPackageContent
} from "./segmented-final-internal/package-content-fingerprint.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose, rejectClose) => {
    if (!server.listening) return resolveClose();
    server.close((error) => error ? rejectClose(error) : resolveClose());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FFmpeg package-content fingerprint", () => {
  it("uses Core code-unit ordering without consulting locale state", async () => {
    const root = await writeProbeTree();
    const baseline = await fingerprintResolvedMotionPackageContent(root);

    expect(await withLocaleTrap(() => fingerprintResolvedMotionPackageContent(root))).toEqual(baseline);
    expect(baseline.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable for an unchanged complete package and returns only bounded facts", async () => {
    const root = await writeProbeTree();
    const first = await fingerprintResolvedMotionPackageContent(root);
    const second = await fingerprintResolvedMotionPackageContent(root);

    expect(second).toEqual(first);
    expect(first).toEqual({
      schema: MOTION_PACKAGE_CONTENT_FINGERPRINT_SCHEMA,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileCount: 8,
      byteLength: expect.any(Number)
    });
    expect(JSON.stringify(first)).not.toContain(root);
    expect(Object.keys(first).sort()).toEqual(["byteLength", "fileCount", "schema", "sha256"]);
  });

  it("changes when any package content, byte length, or relative path changes", async () => {
    const root = await writeProbeTree();
    const initial = await fingerprintResolvedMotionPackageContent(root);

    await writeFile(join(root, "a.txt"), "bravo", "utf8");
    const contentChanged = await fingerprintResolvedMotionPackageContent(root);
    expect(contentChanged.sha256).not.toBe(initial.sha256);
    expect(contentChanged.byteLength).toBe(initial.byteLength);

    await writeFile(join(root, "a.txt"), "content with a different byte length", "utf8");
    const sizeChanged = await fingerprintResolvedMotionPackageContent(root);
    expect(sizeChanged.sha256).not.toBe(contentChanged.sha256);
    expect(sizeChanged.byteLength).not.toBe(contentChanged.byteLength);

    await rename(join(root, "z.txt"), join(root, "renamed.txt"));
    const pathChanged = await fingerprintResolvedMotionPackageContent(root);
    expect(pathChanged.sha256).not.toBe(sizeChanged.sha256);
    expect(pathChanged.byteLength).toBe(sizeChanged.byteLength);
  });

  it("refuses a symlink anywhere in the package tree, including at its root", async ({ skip }) => {
    const root = await writeProbeTree();
    const rootAlias = `${root}-alias`;
    try {
      await symlink(join(root, "a.txt"), join(root, "nested", "linked.txt"));
      await symlink(root, rootAlias, "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links; covered on symlink-capable hosts.");
      }
      throw error;
    }
    roots.push(rootAlias);

    await expect(fingerprintResolvedMotionPackageContent(root)).rejects.toThrow("symbolic link");
    await expect(fingerprintResolvedMotionPackageContent(rootAlias)).rejects.toThrow("symbolic link");
  });

  it.skipIf(process.platform === "win32")("refuses special files", async () => {
    const root = await writeProbeTree();
    const socketPath = join(root, "socket-entry");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });

    await expect(fingerprintResolvedMotionPackageContent(root)).rejects.toThrow("special file");
  });

  it("refuses package roots that are missing, non-directories, or lexical aliases", async () => {
    const root = await writeProbeTree();
    const file = join(root, "a.txt");

    await expect(fingerprintResolvedMotionPackageContent(file)).rejects.toThrow("non-directory");
    await expect(fingerprintResolvedMotionPackageContent(join(root, "missing"))).rejects.toThrow("root could not be inspected");
    await expect(fingerprintResolvedMotionPackageContent(`${root}${sep}nested${sep}..`)).rejects.toThrow("already-resolved absolute");
  });

  it("refuses over-budget input without exposing the package file list", async () => {
    const root = await writeProbeTree();
    await expect(fingerprintResolvedMotionPackageContent(root, {
      testLimits: { maxFiles: 1 }
    })).rejects.toThrow("fingerprint budget");
    await expect(fingerprintResolvedMotionPackageContent(root, {
      testLimits: { maxBytes: 1 }
    })).rejects.toThrow("fingerprint budget");
  });

  it("refuses a regular file mutated after it was safely hashed", async () => {
    const root = await writeProbeTree();
    await expect(fingerprintResolvedMotionPackageContent(root, {
      testHooks: {
        async afterFileHashed(relativePath) {
          if (relativePath === "a.txt") await writeFile(join(root, "a.txt"), "changed-after-hash", "utf8");
        }
      }
    })).rejects.toThrow("changed while fingerprinting: a.txt");
  });

  it("requires the live package scan to contain the exact loader-owned input bytes", async () => {
    const root = await writeProbeTree();
    const loadedAlpha = createHash("sha256").update("alpha").digest("hex");
    await expect(fingerprintResolvedMotionPackageContent(root, {
      expectedFileHashes: { "a.txt": loadedAlpha }
    })).resolves.toMatchObject({ fileCount: 8 });

    await writeFile(join(root, "a.txt"), "bytes swapped after package load", "utf8");
    await expect(fingerprintResolvedMotionPackageContent(root, {
      expectedFileHashes: { "a.txt": loadedAlpha }
    })).rejects.toThrow("loaded input changed before fingerprinting: a.txt");
    await expect(fingerprintResolvedMotionPackageContent(root, {
      expectedFileHashes: { "missing.json": loadedAlpha }
    })).rejects.toThrow("loaded input is missing from the content fingerprint: missing.json");
  });
});

async function writeProbeTree(): Promise<string> {
  // Unix-domain socket paths are capped at roughly 104 bytes on macOS. Keep this fixture prefix
  // intentionally short so the special-file regression reaches the fingerprint boundary.
  const root = resolve(await mkdtemp(join(tmpdir(), "sxm-fp-")));
  roots.push(root);
  // These names sort differently in common user locales, but are fixed by code-unit comparison.
  await writeFile(join(root, "a.txt"), "alpha", "utf8");
  await writeFile(join(root, "ä.txt"), "a-umlaut", "utf8");
  await writeFile(join(root, "z.txt"), "zed", "utf8");
  await writeFile(join(root, "i1.txt"), "i-one", "utf8");
  await writeFile(join(root, "I2.txt"), "I-two", "utf8");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "motion.json"), "{\"durationMs\":1000}", "utf8");
  await writeFile(join(root, "nested", "style.css"), "body { color: white; }", "utf8");
  await writeFile(join(root, "nested", "font.woff2"), "font-bytes", "utf8");
  return root;
}

async function withLocaleTrap<T>(body: () => Promise<T>): Promise<T> {
  const globals = globalThis as Record<string, unknown>;
  const savedIntl = globals.Intl;
  const savedCompare = String.prototype.localeCompare;
  const boom = () => { throw new Error("locale-sensitive path reached from the package-content fingerprint"); };
  try {
    globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
    String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
    return await body();
  } finally {
    globals.Intl = savedIntl;
    String.prototype.localeCompare = savedCompare;
  }
}
