import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { prepareBrowserCaptureHtml } from "./browser-composition-expansion";
import type { BrowserPackageFulfillment, BrowserPackageFulfilledFile } from "./browser-package-fulfillment";
import { injectBrowserCaptureBase, packageRootBaseHref } from "./browser-capture-html-document";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(html: string | ((root: string) => string), sibling: string | Buffer, onSiblingRead?: () => void) {
  const root = await mkdtemp(join(tmpdir(), "motion-composition-bound-"));
  roots.push(root);
  const reads: string[] = [];
  const pkg = { root, manifest: { id: "composition-fixture" } } as MotionPackage;
  const documents = new Map([[resolve(root, "shell.html"), Buffer.from(typeof html === "string" ? html : html(root))], [resolve(root, "sibling.html"), Buffer.isBuffer(sibling) ? sibling : Buffer.from(sibling)]]);
  const fulfillment: BrowserPackageFulfillment = {
    rootPath: root,
    canFulfillFileUrl: () => false,
    async readPath(path: string): Promise<BrowserPackageFulfilledFile> {
      reads.push(path);
      if (path === resolve(root, "sibling.html")) onSiblingRead?.();
      const bytes = documents.get(path);
      if (!bytes) throw new Error(`Unexpected read: ${path}`);
      return { bytes, byteLength: bytes.length, sha256: "", relativePath: path, contentType: "text/html" };
    },
    async readFileUrl() { throw new Error("Unexpected URL read"); },
    inputHashes: () => ({})
  };
  return { root, pkg, fulfillment, reads, outDir: join(root, "output") };
}

describe("browser composition expansion", () => {
  it("preserves ordinary sibling inlining, escaped reference attributes and base injection", async () => {
    const source = '<html><head></head><body>before<div data-composition-src="sibling.html" title="a &amp; b"></div>after</body></html>';
    const { pkg, fulfillment, reads, outDir } = await fixture(source, '<strong>café</strong>');
    const result = await prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment);
    const output = await readFile(result.artifactPath!, "utf8");
    expect(output).toContain('<base href="file:');
    expect(output).toContain('before<div title="a &amp; b" data-shellx-motion-inlined-composition-src="sibling.html"><strong>café</strong></div>after');
    expect(reads).toHaveLength(2);
  });

  it("refuses repeated references before expanding or publishing beyond 64 MiB", async () => {
    const refs = '<main data-composition-src="sibling.html"></main>'.repeat(65);
    const { pkg, fulfillment, reads, outDir } = await fixture(`<html><body>${refs}</body></html>`, "x".repeat(1024 * 1024));
    await expect(prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment)).rejects.toThrow(/64 MiB expanded output limit/);
    expect(reads).toHaveLength(2);
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses one oversized UTF-8 sibling before decoding it", async () => {
    const oversized = Buffer.alloc(65 * 1024 * 1024, 0x78);
    Object.defineProperty(oversized, "toString", { value: () => { throw new Error("oversized sibling was decoded"); } });
    const { pkg, fulfillment, reads, outDir } = await fixture('<main data-composition-src="sibling.html"></main>', oversized);
    await expect(prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment)).rejects.toThrow(/64 MiB expanded output limit/);
    expect(reads).toHaveLength(2);
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("charges untouched source, wrapper and base bytes against the expanded limit", async () => {
    const tag = '<i data-composition-src="sibling.html"></i>';
    const { pkg, fulfillment, reads, outDir } = await fixture((root) => {
      const baseBytes = Buffer.byteLength(injectBrowserCaptureBase("", packageRootBaseHref(root)));
      return tag + "a".repeat(64 * 1024 * 1024 - baseBytes - Buffer.byteLength(tag) - 1);
    }, "");
    await expect(prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment)).rejects.toThrow(/64 MiB expanded output limit/);
    expect(reads).toHaveLength(1);
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows a large replaced span when the actual expanded HTML fits", async () => {
    const source = `<main data-composition-src="sibling.html">${"x".repeat(65 * 1024 * 1024)}</main>`;
    const { pkg, fulfillment, outDir } = await fixture(source, "small");
    const result = await prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment);
    expect(await readFile(result.artifactPath!, "utf8")).toContain('data-shellx-motion-inlined-composition-src="sibling.html">small</main>');
  });

  it("lets a timer cancel repeated cached references before publication", async () => {
    const refs = '<main data-composition-src="sibling.html"></main>'.repeat(500);
    const controller = new AbortController();
    const reason = new Error("governor cancelled");
    const { pkg, fulfillment, reads, outDir } = await fixture(refs, "small", () => setTimeout(() => controller.abort(reason), 0));
    await expect(prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment, true, undefined, controller.signal)).rejects.toBe(reason);
    expect(reads).toHaveLength(2);
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses excessive empty sibling references even when their bytes are small", async () => {
    const refs = '<i data-composition-src="sibling.html"></i>'.repeat(4097);
    const { pkg, fulfillment, reads, outDir } = await fixture(refs, "");
    await expect(prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment)).rejects.toThrow(/4096 composition reference limit/);
    expect(reads).toHaveLength(1);
  });

  it("keeps approved-agent entry and hybrid admission closed to sibling inlining", async () => {
    const { pkg, fulfillment, reads, outDir } = await fixture('<main data-composition-src="sibling.html"></main>', "small");
    await expect(prepareBrowserCaptureHtml(pkg, "shell.html", outDir, fulfillment, false)).rejects.toThrow(/cannot inline secondary package compositions/);
    expect(reads).toHaveLength(1);
  });
});
