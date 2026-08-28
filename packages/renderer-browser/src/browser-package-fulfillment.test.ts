import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hashBuffer, loadMotionPackageFromAdmittedFiles } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createBrowserPackageFulfillment } from "./browser-package-fulfillment";
import { buildGeneratedMotionHtml } from "./index";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("browser package fulfillment", () => {
  it("retains the verified entry bytes and receipt hash after its live pathname changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-fulfillment-"));
    roots.push(root);
    const entry = join(root, "card.html");
    await writeFile(entry, "<main>verified</main>", "utf8");
    const anchor = await createTrustedWorkspaceAnchor(root);
    await withTrustedWorkspaceAnchor(anchor, async () => {
      const fulfillment = await createBrowserPackageFulfillment(root);
      const first = await fulfillment.readPath(entry, "entry");
      first.bytes.fill(0);
      await writeFile(entry, "<main>replacement</main>", "utf8");
      const repeated = await fulfillment.readFileUrl(pathToFileURL(entry).href, "entry replay");

      expect(repeated.bytes.toString("utf8")).toBe("<main>verified</main>");
      expect(repeated.sha256).toBe(first.sha256);
      expect(fulfillment.inputHashes()).toEqual({
        "browser-package/card.html": createHash("sha256").update("<main>verified</main>").digest("hex")
      });
      expect(fulfillment.canFulfillFileUrl(pathToFileURL(entry).href)).toBe(true);
      expect(fulfillment.canFulfillFileUrl(pathToFileURL(join(root, "..", "outside.html")).href)).toBe(false);
    });
  });

  it("uses Core's copied admitted bytes when the logical package path changes and is restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-admitted-restore-"));
    roots.push(root);
    const fixture = resolve("../../fixtures/packages/editable-lower-third");
    const paths = ["manifest.json", "motion.json", "template.json", "assets/fonts/LICENSE-Inter.txt", "assets/fonts/inter-latin-400-normal.woff2", "assets/fonts/inter-latin-700-normal.woff2"];
    const files = new Map<string, Readonly<{ bytes: Buffer; sha256: string }>>();
    for (const path of paths) {
      const bytes = await readFile(join(fixture, path));
      files.set(path, { bytes, sha256: hashBuffer(bytes) });
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
    }
    const pkg = loadMotionPackageFromAdmittedFiles(root, files);
    const fontPath = "assets/fonts/inter-latin-400-normal.woff2";
    const originalFont = Buffer.from(files.get(fontPath)!.bytes);
    const originalMotion = Buffer.from(files.get("motion.json")!.bytes);

    await writeFile(join(root, fontPath), Buffer.from("changed-font"));
    await writeFile(join(root, "motion.json"), Buffer.from("{\"changed\":true}"));
    try {
      const generated = await buildGeneratedMotionHtml(pkg, 0);
      expect(generated.assetHashes[fontPath]).toBe(hashBuffer(originalFont));
      expect(generated.html).toContain(originalFont.toString("base64"));
    } finally {
      await writeFile(join(root, fontPath), originalFont);
      await writeFile(join(root, "motion.json"), originalMotion);
    }
    expect(await readFile(join(root, fontPath))).toEqual(originalFont);
  });
});
