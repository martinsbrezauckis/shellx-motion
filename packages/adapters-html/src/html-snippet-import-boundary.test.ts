import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importHtmlSnippetToMotionPackage } from "./index";
import { parseHtmlSnippet } from "./html-snippet-import-parse";

const tempDirs: string[] = [];

describe("HTML snippet import boundary", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps public import artifacts and hostile lossiness in parser parity", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-html-import-boundary-"));
    tempDirs.push(root);
    const htmlPath = join(root, "incoming.html");
    const html = `<!doctype html>
<html data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_boundary">
<head><title>Boundary</title><script>never()</script><link rel="stylesheet" href="https://example.invalid/style.css"></head>
<body><main data-composition-id="motion_boundary" data-duration="1000" style="width:320px;height:180px">
  <img data-layer-id="remote" data-layer-type="image" src="https://example.invalid/pixel.svg" data-start="0" data-duration="1000">
  <script data-layer-id="discarded" data-layer-type="text" data-start="0" data-duration="1000">never()</script>
  <div data-layer-id="safe" data-layer-type="shape" data-start="0" data-duration="1000" style="left:0;top:0;width:320px;height:180px;background:#112233"></div>
</main></body></html>`;
    await writeFile(htmlPath, html, "utf8");
    const parsed = parseHtmlSnippet(html, { createdBy: "boundary-test" });

    const result = await importHtmlSnippetToMotionPackage({
      htmlPath,
      packageDir: join(root, "package"),
      createdBy: "boundary-test",
      createdAt: "2026-08-09T00:00:00.000Z"
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const motion = JSON.parse(await readFile(result.motionPath, "utf8"));
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));

    expect(manifest).toEqual(parsed.manifest);
    expect(motion).toEqual(parsed.motion);
    expect(receipt.output.lossiness.unsupported).toEqual(parsed.lossiness);
    expect(motion.layers.map((layer: { id: string }) => layer.id)).toEqual(["safe"]);
    expect(parsed.lossiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "html.script.discarded" }),
      expect.objectContaining({ feature: "html.externalStylesheet.discarded" }),
      expect.objectContaining({ layerId: "remote", feature: "media.source.local-package" }),
      expect.objectContaining({ layerId: "discarded", feature: "html.tag.script.discarded" })
    ]));
  });

  it.skipIf(process.platform === "win32")("imports through a stable operating-system directory alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-html-import-alias-"));
    tempDirs.push(root);
    const canonicalRoot = join(root, "canonical");
    const aliasRoot = join(root, "alias");
    await mkdir(canonicalRoot, { mode: 0o700 });
    await symlink(canonicalRoot, aliasRoot, "dir");
    const htmlPath = join(aliasRoot, "incoming.html");
    await writeFile(htmlPath, `<!doctype html><html><body>
<main data-composition-id="motion_alias" data-duration="1000" style="width:320px;height:180px">
  <div data-layer-id="safe" data-layer-type="shape" data-start="0" data-duration="1000"></div>
</main></body></html>`, "utf8");

    const result = await importHtmlSnippetToMotionPackage({
      htmlPath,
      packageDir: join(root, "package"),
      createdAt: "2026-08-26T00:00:00.000Z"
    });

    expect(result.layerCount).toBe(1);
  });
});
