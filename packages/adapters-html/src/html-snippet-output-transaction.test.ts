import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  outputPath: "",
  leafName: "",
  sentinelPath: "",
  afterPackageLoad: null as (() => Promise<void>) | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: any[]) => {
      if (race.outputPath && String(args[1]) === race.outputPath) {
        const outputPath = race.outputPath;
        const leafName = race.leafName;
        const sentinelPath = race.sentinelPath;
        race.outputPath = "";
        await actual.mkdir(outputPath, { mode: 0o700 });
        await actual.symlink(sentinelPath, join(outputPath, leafName));
      }
      return await (actual.rename as (...renameArgs: any[]) => Promise<void>)(...args);
    }
  };
});

vi.mock("@shellx-motion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/core")>();
  return {
    ...actual,
    loadMotionPackage: async (...args: any[]) => {
      const result = await (actual.loadMotionPackage as (...loadArgs: any[]) => Promise<unknown>)(...args);
      const hook = race.afterPackageLoad;
      race.afterPackageLoad = null;
      if (hook) await hook();
      return result;
    }
  };
});

import { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "./index.js";
import { HtmlSnippetOutputTransaction, readBoundedDescriptor } from "./html-snippet-output-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  race.outputPath = "";
  race.leafName = "";
  race.sentinelPath = "";
  race.afterPackageLoad = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-html-output-transaction-"));
  roots.push(root);
  return root;
}

describe("HTML snippet output transaction", () => {
  it.skipIf(process.platform === "win32")("does not follow a leaf symlink substituted at export publication and cleans only its private stage", async () => {
    const root = await scratch();
    const packageRoot = await writePackage(root, "snapshot export");
    const outDir = join(root, "export");
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "competitor bytes", "utf8");
    race.outputPath = outDir;
    race.leafName = "index.html";
    race.sentinelPath = sentinel;

    await expect(writeHtmlSnippetExport({ packageRoot, outDir })).rejects.toMatchObject({
      code: "publication_commit_uncertain",
      evidence: { publicPath: outDir, kind: "directory" }
    });

    expect(await readFile(sentinel, "utf8")).toBe("competitor bytes");
    expect(await readFile(join(outDir, "index.html"), "utf8")).toBe("competitor bytes");
    expect(await readdir(outDir)).toEqual(["index.html"]);
    expect((await readdir(root)).filter((name) => name.startsWith(".shellx-motion-final-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not follow a leaf symlink substituted at import publication and preserves the competitor package", async () => {
    const root = await scratch();
    const htmlPath = join(root, "incoming.html");
    const packageDir = join(root, "imported-package");
    const sentinel = join(root, "sentinel.txt");
    await writeFile(htmlPath, htmlSnippet(), "utf8");
    await writeFile(sentinel, "competitor manifest", "utf8");
    race.outputPath = packageDir;
    race.leafName = "manifest.json";
    race.sentinelPath = sentinel;

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir })).rejects.toMatchObject({
      code: "publication_commit_uncertain",
      evidence: { publicPath: packageDir, kind: "directory" }
    });

    expect(await readFile(sentinel, "utf8")).toBe("competitor manifest");
    expect(await readFile(join(packageDir, "manifest.json"), "utf8")).toBe("competitor manifest");
    expect(await readdir(packageDir)).toEqual(["manifest.json"]);
    expect((await readdir(root)).filter((name) => name.startsWith(".shellx-motion-final-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a retargeted output ancestor before it stages outside the admitted parent", async () => {
    const root = await scratch();
    const outside = await scratch();
    const packageRoot = await writePackage(root, "ancestor test");
    const linkedParent = join(root, "redirected-output");
    await symlink(outside, linkedParent, "dir");

    await expect(writeHtmlSnippetExport({ packageRoot, outDir: join(linkedParent, "export") })).rejects.toThrow(
      /parent must be a canonical non-symlink directory/i
    );
    await expect(readFile(join(outside, "export", "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the export receipt to the exact loader snapshot, not package pathnames rehashed after rendering", async () => {
    const root = await scratch();
    const packageRoot = await writePackage(root, "original snapshot");
    const outDir = join(root, "export");
    const manifestPath = join(packageRoot, "manifest.json");
    const motionPath = join(packageRoot, "motion.json");
    const initialManifest = await readFile(manifestPath);
    const initialMotion = await readFile(motionPath);
    const changedManifest = JSON.stringify({
      schema: "shellx-motion/package-manifest@1", id: "pkg_html_output", name: "changed after load", motion: "motion.json", assets: [],
      sourceApp: "shellx-motion", compatibility: { lanes: ["html"], hosts: ["motion"] }
    }) + "\n";
    const changedMotion = JSON.stringify({
      schema: "shellx-motion/motion@1", id: "motion_html_output", name: "changed after load", durationMs: 1000, fps: 30,
      width: 320, height: 180, background: "#000000", assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      layers: [{ id: "title", type: "text", text: "changed", startMs: 0, durationMs: 1000 }]
    }) + "\n";
    race.afterPackageLoad = async () => {
      await writeFile(manifestPath, changedManifest, "utf8");
      await writeFile(motionPath, changedMotion, "utf8");
    };

    const result = await writeHtmlSnippetExport({ packageRoot, outDir });
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as { inputHashes: Record<string, string> };

    expect(receipt.inputHashes).toMatchObject({
      "manifest.json": sha256(initialManifest),
      "motion.json": sha256(initialMotion)
    });
    expect(receipt.inputHashes["manifest.json"]).not.toBe(sha256(Buffer.from(changedManifest)));
    expect(receipt.inputHashes["motion.json"]).not.toBe(sha256(Buffer.from(changedMotion)));
  });

  it("caps an SVG descriptor at its admitted size plus one byte and rejects concurrent growth", async () => {
    const admitted = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const source = descriptor(admitted, Buffer.concat([admitted, Buffer.from("x")]));

    await expect(readBoundedDescriptor(source, admitted.byteLength, "assets/logo.svg"))
      .rejects.toThrow("HTML snippet import asset changed while it was being staged: assets/logo.svg.");

    expect(source.read).toHaveBeenCalledWith(expect.any(Buffer), 0, admitted.byteLength + 1, 0);
  });

  it("caps a non-SVG descriptor copy at its admitted size plus one byte and revalidates its identity", async () => {
    const root = await scratch();
    const admitted = Buffer.from("png");
    const source = descriptor(admitted, Buffer.concat([admitted, Buffer.from("x")]));
    const transaction = await HtmlSnippetOutputTransaction.acquire(join(root, "package"));
    try {
      await expect(transaction.copyFromDescriptor("assets/photo.png", source, admitted.byteLength, "assets/photo.png"))
        .rejects.toThrow("HTML snippet import asset changed while it was being staged: assets/photo.png.");
      expect(source.read).toHaveBeenCalledWith(expect.any(Buffer), 0, admitted.byteLength + 1, 0);

      const identityChanged = descriptor(admitted, admitted, true);
      await expect(transaction.copyFromDescriptor("assets/changed.png", identityChanged, admitted.byteLength, "assets/changed.png"))
        .rejects.toThrow("HTML snippet import asset changed while it was being staged: assets/changed.png.");
    } finally {
      await transaction.abort();
    }
  });

  it("keeps unchanged descriptor reads compatible", async () => {
    const source = descriptor(Buffer.from("static SVG"));

    await expect(readBoundedDescriptor(source, 10, "assets/logo.svg")).resolves.toEqual(Buffer.from("static SVG"));
  });
});

function descriptor(admitted: Buffer, readable = admitted, mutateAfterRead = false) {
  let statCalls = 0;
  const handle = {
    stat: vi.fn(async () => descriptorStats(admitted.byteLength, mutateAfterRead && statCalls++ > 0 ? 1 : 0)),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const available = readable.subarray(position, position + length);
      available.copy(buffer, offset);
      return { bytesRead: available.byteLength, buffer };
    })
  };
  return handle as unknown as import("node:fs/promises").FileHandle;
}

function descriptorStats(size: number, version: number) {
  return {
    isFile: () => true,
    dev: 1,
    ino: 2,
    nlink: 1,
    size,
    mtimeMs: version,
    ctimeMs: version
  };
}

async function writePackage(root: string, name: string): Promise<string> {
  const packageRoot = join(root, "package");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_html_output", name, motion: "motion.json", assets: [],
    sourceApp: "shellx-motion", compatibility: { lanes: ["html"], hosts: ["motion"] }
  }) + "\n", "utf8");
  await writeFile(join(packageRoot, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_html_output", name, durationMs: 1000, fps: 30,
    width: 320, height: 180, background: "#000000", assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [{ id: "title", type: "text", text: "safe", startMs: 0, durationMs: 1000 }]
  }) + "\n", "utf8");
  return packageRoot;
}

function htmlSnippet(): string {
  return `<!doctype html><html data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_import"><head><title>Import</title></head><body><main data-composition-id="motion_import" data-duration="1000" style="width:320px;height:180px"><div data-layer-id="title" data-layer-type="text" data-start="0" data-duration="1000">Safe</div></main></body></html>`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
