import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { importHtmlSnippetToMotionPackage, writeHtmlSnippetExport } from "./index";
import { htmlSnippetTocTouFixture } from "./index-toc-tou-fixture.test-support";

const tempDirs: string[] = [];

describe("HTML snippet export adapter", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exports a standalone HyperFrames-style HTML composition with timing metadata and receipt evidence", async () => {
    const packageRoot = await writeHtmlExportPackage();
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-")); const outDir = join(outRoot, "export");
    tempDirs.push(packageRoot, outRoot);

    const result = await writeHtmlSnippetExport({
      packageRoot,
      outDir,
      createdAt: "2026-07-04T08:00:00.000Z"
    });

    const html = await readFile(result.htmlPath, "utf8");
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      packageId: "pkg_html_export",
      htmlPath: join(outDir, "index.html"),
      receiptPath: join(outDir, "html-snippet-export.receipt.json"),
      layerCount: 4,
      exportedLayerCount: 3,
      unsupportedFeatureCount: 1
    });
    expect(html).toContain('data-shellx-motion-schema="shellx-motion/html-snippet@1"');
    expect(html).toContain('data-shellx-motion-package-id="pkg_html_export"');
    expect(html).toContain('data-composition-id="motion_html_export"');
    expect(html).toContain('data-start="0"');
    expect(html).toContain('data-duration="2400"');
    expect(html).toContain('data-layer-id="headline"');
    expect(html).toContain('data-start="200"');
    expect(html).toContain('data-duration="1400"');
    expect(html).toContain("Deploy &lt;now&gt; &amp; verify");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain(packageRoot);
    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "html.snippet.export",
      status: "warning",
      packageId: "pkg_html_export",
      createdAt: "2026-07-04T08:00:00.000Z",
      lane: "html",
      output: {
        htmlPath: result.htmlPath,
        htmlSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        layerCount: 4,
        exportedLayerCount: 3,
        lossiness: {
          unsupported: [
            {
              path: "motion.layers.audio_bed",
              layerId: "audio_bed",
              feature: "layer.type.audio",
              reason: "HTML snippet export does not embed audio layers yet."
            }
          ]
        }
      },
      artifacts: [
        { role: "html_snippet", path: result.htmlPath, status: "available", mediaType: "text/html", primary: true },
        { role: "html_snippet_receipt", path: result.receiptPath, status: "available", mediaType: "application/json" }
      ]
    });
  });

  it("refuses to write into occupied output directories", async () => {
    const packageRoot = await writeHtmlExportPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-nonempty-"));
    tempDirs.push(packageRoot, outDir);
    await writeFile(join(outDir, "old.html"), "stale", "utf8");

    await expect(writeHtmlSnippetExport({ packageRoot, outDir })).rejects.toThrow(
      "Final output already exists"
    );
  });

  it.skipIf(process.platform === "win32")("refuses export media symlinks that escape the Motion package", async () => {
    const packageRoot = await writeHtmlExportPackage();
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-export-outside-"));
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-export-symlink-")); const outDir = join(outRoot, "export");
    tempDirs.push(packageRoot, outsideRoot, outRoot);
    await writeFile(join(outsideRoot, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");
    await rm(join(packageRoot, "assets", "logo.svg"));
    await symlink(join(outsideRoot, "logo.svg"), join(packageRoot, "assets", "logo.svg"));

    await expect(writeHtmlSnippetExport({ packageRoot, outDir })).rejects.toThrow(/escapes package root|escapes packageRoot/);
  });

  it("records Motion features that bounded HTML cannot preserve instead of silently flattening them", async () => {
    const packageRoot = await writeHtmlExportPackage();
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[1].effects = { blur: 4 };
    motion.layers[1].keyframes = { opacity: [{ atMs: 0, value: 0 }, { atMs: 400, value: 1 }] };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    await loadMotionPackage(packageRoot);
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-lossiness-")); const outDir = join(outRoot, "export");
    tempDirs.push(packageRoot, outRoot);

    const result = await writeHtmlSnippetExport({ packageRoot, outDir });

    expect(result.exportedLayerCount).toBe(3);
    expect(result.unsupportedFeatureCount).toBe(3);
    expect(result.receipt.output).toMatchObject({
      lossiness: {
        unsupported: expect.arrayContaining([
          expect.objectContaining({ layerId: "headline", feature: "layer.effects" }),
          expect.objectContaining({ layerId: "headline", feature: "layer.keyframes" }),
          expect.objectContaining({ layerId: "audio_bed", feature: "layer.type.audio" })
        ])
      }
    });
  });

  it("imports a HyperFrames-style HTML snippet into a Motion package with receipt evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-import-"));
    const htmlPath = join(tempRoot, "incoming.html");
    const packageRoot = join(tempRoot, "package");
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "assets"), { recursive: true });
    await writeFile(join(tempRoot, "assets", "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\" fill=\"#22c55e\"/></svg>", "utf8");
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    const result = await importHtmlSnippetToMotionPackage({
      htmlPath,
      packageDir: packageRoot,
      createdAt: "2026-07-04T08:30:00.000Z"
    });

    const pkg = await loadMotionPackage(packageRoot);
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      packageId: "pkg_html_import",
      packageDir: packageRoot,
      manifestPath: join(packageRoot, "manifest.json"),
      motionPath: join(packageRoot, "motion.json"),
      receiptPath: join(packageRoot, "receipts", "html-snippet-import.receipt.json"),
      layerCount: 3,
      warningCount: 1,
      stagedAssetCount: 1,
      stagedAssets: [{ path: "assets/logo.svg", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), size: expect.any(Number) }]
    });
    expect(pkg.manifest).toMatchObject({
      id: "pkg_html_import",
      name: "Launch Card",
      motion: "motion.json",
      assets: ["assets/logo.svg"],
      sourceApp: "html-snippet",
      compatibility: {
        lanes: ["html", "browser", "ffmpeg"],
        hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
      }
    });
    expect(pkg.motion).toMatchObject({
      id: "motion_html_import",
      name: "Launch Card",
      durationMs: 2400,
      fps: 24,
      width: 1280,
      height: 720,
      background: "#0f172a",
      provenance: {
        sourceApp: "html-snippet",
        createdBy: "html-adapter",
        sourceSchema: "shellx-motion/html-snippet@1"
      },
      layers: [
        {
          id: "headline",
          type: "text",
          text: "Deploy <now> & verify",
          startMs: 200,
          durationMs: 1400,
          transform: { x: 120, y: 180, width: 860, height: 100, opacity: 0.95, scale: 1.1, rotation: -5 },
          style: { color: "#ffffff", fontSize: 72, fontWeight: 800, textAlign: "center" }
        },
        {
          id: "accent",
          type: "shape",
          shape: "rounded-rect",
          startMs: 450,
          durationMs: 1600,
          transform: { x: 80, y: 500, width: 420, height: 18 },
          style: { fill: "#22c55e", radius: 12 }
        },
        {
          id: "logo",
          type: "image",
          source: "assets/logo.svg",
          startMs: 500,
          durationMs: 1200,
          transform: { x: 1030, y: 170, width: 120, height: 120 }
        }
      ]
    });
    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "html.snippet.import",
      status: "warning",
      packageId: "pkg_html_import",
      createdAt: "2026-07-04T08:30:00.000Z",
      lane: "html",
      output: {
        htmlPath,
        motionPath: join(packageRoot, "motion.json"),
        layerCount: 3,
        warningCount: 1,
        stagedAssets: [{ path: "assets/logo.svg", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), size: expect.any(Number) }],
        lossiness: {
          unsupported: [
            {
              path: "html.layers.webgl",
              layerId: "webgl",
              feature: "layer.type.webgl",
              reason: "HTML snippet import does not map webgl layers yet."
            }
          ]
        }
      },
      artifacts: [
        { role: "motion_package", path: packageRoot, status: "available", mediaType: "application/vnd.shellx.motion.package", primary: true },
        { role: "html_snippet_import_receipt", path: join(packageRoot, "receipts", "html-snippet-import.receipt.json"), status: "available", mediaType: "application/json" }
      ]
    });
    await expect(readFile(join(packageRoot, "assets", "logo.svg"), "utf8")).resolves.toContain("#22c55e");
  });

  it("discards executable HTML and unsafe media sources with receipt-visible findings", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-hostile-"));
    const htmlPath = join(tempRoot, "incoming.html");
    const packageRoot = join(tempRoot, "package");
    tempDirs.push(tempRoot);
    await writeFile(htmlPath, `<!doctype html>
<html data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_html_hostile">
<head><title>Hostile import</title><style>.remote { filter: blur(8px); }</style><script>globalThis.pwned = true</script></head>
<body><main data-composition-id="motion_html_hostile" data-duration="1000" style="width:320px;height:180px;background:#000">
  <img data-layer-id="remote" data-layer-type="image" data-start="0" data-duration="1000" src="https://example.com/tracker.svg" onerror="alert(1)" style="left:0;top:0;width:100px;height:100px;filter:blur(4px)">
  <script data-layer-id="script-layer" data-layer-type="text" data-start="0" data-duration="1000">alert(1)</script>
  <div data-layer-id="safe" data-layer-type="shape" data-start="0" data-duration="1000" style="left:0;top:0;width:320px;height:180px;background:#112233"></div>
</main></body></html>`, "utf8");

    const result = await importHtmlSnippetToMotionPackage({ htmlPath, packageDir: packageRoot });
    const pkg = await loadMotionPackage(packageRoot);
    const findings = (result.receipt.output as any).lossiness.unsupported;

    expect(pkg.motion.layers.map((layer) => layer.id)).toEqual(["safe"]);
    expect(result.warningCount).toBeGreaterThanOrEqual(6);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "html.script.discarded" }),
      expect.objectContaining({ feature: "html.stylesheet.discarded" }),
      expect.objectContaining({ feature: "html.eventHandler.discarded" }),
      expect.objectContaining({ layerId: "remote", feature: "media.source.local-package" }),
      expect.objectContaining({ layerId: "remote", feature: "css.filter.discarded" }),
      expect.objectContaining({ layerId: "script-layer", feature: "html.tag.script.discarded" })
    ]));
  });

  it.skipIf(process.platform === "win32")("rejects imported media symlinks that escape the HTML source directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-symlink-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-outside-"));
    const htmlPath = join(tempRoot, "incoming.html");
    tempDirs.push(tempRoot, outsideRoot);
    await mkdir(join(tempRoot, "assets"), { recursive: true });
    await writeFile(join(outsideRoot, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");
    await symlink(join(outsideRoot, "logo.svg"), join(tempRoot, "assets", "logo.svg"));
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") })).rejects.toThrow(
      "HTML snippet import asset escapes the source directory: assets/logo.svg."
    );
  });

  it.skipIf(process.platform === "win32")("rejects in-root symlinks that change the asset extension away from the declared name", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-ext-symlink-"));
    const htmlPath = join(tempRoot, "incoming.html");
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "assets"), { recursive: true });
    // Hostile SVG bytes hidden under a non-.svg name inside the source root: realpath containment
    // passes, and sanitizer selection keyed off the resolved target's extension would skip the SVG
    // checks while the bytes are staged (and later served) under the declared .svg name.
    await writeFile(
      join(tempRoot, "assets", "payload.bin"),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
      "utf8"
    );
    await symlink(join(tempRoot, "assets", "payload.bin"), join(tempRoot, "assets", "logo.svg"));
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") })).rejects.toThrow(
      "HTML snippet import asset extension changes through a symlink: assets/logo.svg."
    );
  });

  /**
   * Regression for the staging TOCTOU fixed before 0.1.0.
   *
   * The importer used to validate EVERY declared asset and only then copy them, path by path, with
   * `copyFile(sourcePath, destination)`. Because `copyFile` re-resolves the path and follows
   * symlinks, a snippet directory (which is attacker-controlled by definition — that is what
   * "import an untrusted snippet" means) could pass validation with a benign in-root regular file
   * and swap that path for a symlink to any host file before the copy ran, staging host bytes into
   * the package under an approved asset name. Containment, the declared-extension binding and the
   * size caps were all judged against the pre-swap file.
   *
   * The window is opened here the way a real attacker would: a large asset declared FIRST makes the
   * copy pass take long enough to swap the second asset behind it. The swap is not fired on a timer
   * — it waits until the first asset appears in the package directory, which can only happen after
   * every asset has already been validated. That makes the fail-first behaviour deterministic
   * rather than a race the test might lose.
   *
   * The invariant asserted is byte-level and holds however the import ends: no bytes from outside
   * the snippet directory may reach the package. Refusing the import is one acceptable outcome;
   * staging the originally validated bytes is the other.
   */
  it.skipIf(process.platform === "win32")("never stages bytes from a source path swapped after validation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-toctou-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-secrets-"));
    tempDirs.push(tempRoot, outsideRoot);
    const htmlPath = join(tempRoot, "incoming.html");
    const packageDir = join(tempRoot, "package");
    const secretPath = join(outsideRoot, "private-key.pem");
    const secret = "SECRET-HOST-BYTES-THAT-MUST-NEVER-ENTER-A-PACKAGE";
    await writeFile(secretPath, secret, "utf8");
    await mkdir(join(tempRoot, "assets"), { recursive: true });
    // 32 MiB declared first: with the old two-pass shape this is what phase two spends its time
    // copying, and its appearance in the package directory is the signal that phase one is over.
    await writeFile(join(tempRoot, "assets", "bulk.png"), Buffer.alloc(32 * 1024 * 1024, 0x7f));
    await writeFile(join(tempRoot, "assets", "photo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(htmlPath, htmlSnippetTocTouFixture(), "utf8");

    let swapped = false;
    const swap = (async () => {
      const bulkDestination = join(packageDir, "assets", "bulk.png");
      for (let attempt = 0; attempt < 20_000 && !swapped; attempt += 1) {
        if (await stat(bulkDestination).then(() => true).catch(() => false)) {
          await rm(join(tempRoot, "assets", "photo.png"), { force: true });
          await symlink(secretPath, join(tempRoot, "assets", "photo.png"));
          swapped = true;
          return;
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 1));
      }
    })();

    const outcome = await importHtmlSnippetToMotionPackage({ htmlPath, packageDir })
      .then(() => "imported" as const)
      .catch((error: Error) => error.message);
    swapped = true;
    await swap;

    // Whatever the outcome, no byte of the host file may have reached the package.
    const stagedPhoto = await readFile(join(packageDir, "assets", "photo.png"), "utf8").catch(() => "");
    expect(stagedPhoto, `import outcome: ${outcome}`).not.toContain("SECRET-HOST-BYTES");
    const stagedBulk = await readFile(join(packageDir, "assets", "bulk.png")).catch(() => Buffer.alloc(0));
    expect(stagedBulk.includes(secret)).toBe(false);
  }, 120_000);

  it("rejects executable or externally-referencing SVG media", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-unsafe-svg-"));
    const htmlPath = join(tempRoot, "incoming.html");
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "assets"), { recursive: true });
    await writeFile(
      join(tempRoot, "assets", "logo.svg"),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script><image href=\"https://example.com/pixel.png\"/></svg>",
      "utf8"
    );
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") })).rejects.toThrow(
      "HTML snippet import asset assets/logo.svg SVG contains executable or external-reference syntax."
    );
  });

  it("refuses an oversized SVG from descriptor metadata before it is buffered for sanitizing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-oversized-svg-"));
    const htmlPath = join(tempRoot, "incoming.html");
    tempDirs.push(tempRoot);
    await mkdir(join(tempRoot, "assets"), { recursive: true });
    await writeFile(join(tempRoot, "assets", "logo.svg"), Buffer.alloc((8 * 1024 * 1024) + 1, 0x20));
    await writeFile(htmlPath, htmlSnippetImportFixture(), "utf8");

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") })).rejects.toThrow(
      "HTML snippet import SVG asset exceeds the 8 MiB limit: assets/logo.svg."
    );
  });

  it("rejects oversized HTML before parsing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-oversized-"));
    const htmlPath = join(tempRoot, "incoming.html");
    tempDirs.push(tempRoot);
    await writeFile(htmlPath, Buffer.alloc((8 * 1024 * 1024) + 1, 0x20));

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") })).rejects.toThrow(
      "HTML snippet import source exceeds the 8 MiB limit."
    );
  });

  it("rejects HTML without a ShellX Motion composition root", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-snippet-empty-import-"));
    const htmlPath = join(tempRoot, "incoming.html");
    tempDirs.push(tempRoot);
    await writeFile(htmlPath, "<!doctype html><html><body><p>No composition</p></body></html>", "utf8");

    await expect(importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") })).rejects.toThrow(
      "HTML snippet import requires a <main> composition with data-composition-id or data-shellx-motion-schema metadata."
    );
  });

  /**
   * Equivalence guard for the layer scanner.
   *
   * `readHtmlLayerElements` used to be one two-branch regex. It is now a bounded forward scan, and
   * imported packages carry receipts built on the old behaviour, so the old regex is kept here as an
   * oracle and both are run over a deterministic corpus of well-formed and malformed snippets. The
   * corpus stays small: the oracle is the quadratic pattern being replaced.
   */
  it("extracts the same layers the previous regex scanner did across a fuzz corpus", async () => {
    for (const body of layerFuzzCorpus(120)) {
      const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-equivalence-"));
      tempDirs.push(tempRoot);
      const htmlPath = join(tempRoot, "incoming.html");
      await writeFile(htmlPath, adversarialSnippet(body), "utf8");

      const result = await importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") });
      const motion = JSON.parse(await readFile(join(tempRoot, "package", "motion.json"), "utf8")) as {
        layers: Array<{ id: string; text?: string }>;
      };

      expect(motion.layers.map((layer) => ({ id: layer.id, text: layer.text ?? "" })), body)
        .toEqual(legacyLayers(body));
      expect(result.layerCount).toBe(legacyLayers(body).length);
    }
  });

  /**
   * Adversarial performance fixtures.
   *
   * The importer accepts an 8 MiB HTML file from outside the trust boundary, and every scan it ran
   * on that file was a lazy nested regex. Each case below is well inside the accepted size and each
   * blocked the event loop for the time noted before the scans were made bounded. The budget is
   * loose — these finish in tens of milliseconds here — but every "before" time fails it by more
   * than an order of magnitude, so the test cannot pass by accident on a fast machine.
   */
  describe("adversarial HTML snippet inputs", () => {
    const BUDGET_MS = 3_000;

    async function importWithin(html: string): Promise<{ error?: string; layerCount?: number }> {
      const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-adversarial-"));
      tempDirs.push(tempRoot);
      const htmlPath = join(tempRoot, "incoming.html");
      await writeFile(htmlPath, html, "utf8");
      const started = process.hrtime.bigint();
      let outcome: { error?: string; layerCount?: number };
      try {
        const result = await importHtmlSnippetToMotionPackage({ htmlPath, packageDir: join(tempRoot, "package") });
        outcome = { layerCount: result.layerCount };
      } catch (error) {
        outcome = { error: (error as Error).message };
      }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs, `completed in ${elapsedMs.toFixed(1)} ms, budget ${BUDGET_MS} ms`).toBeLessThan(BUDGET_MS);
      return outcome;
    }

    it("refuses 819 KB of never-closed data-layer-id elements without stalling", async () => {
      // 3.07 s before the bounded rewrite: the layer regex re-scanned to end of file per element.
      const body = "<b data-layer-id=\"a\">".repeat(39_000);
      const html = adversarialSnippet(body);
      expect(html.length).toBeGreaterThan(800_000);
      expect(await importWithin(html)).toEqual({ error: "HTML snippet import exceeds the 1000-layer limit." });
    });

    it("imports 800 KB of <link openers without stalling on the stylesheet probe", async () => {
      // 32.5 s before the rewrite: `/<link\b[^>]*\brel\s*=…/i` re-walked the tag from every opener.
      const html = adversarialSnippet("<div data-layer-id=\"only\" data-layer-type=\"text\">hi</div>", "<link".repeat(160_000));
      expect(html.length).toBeGreaterThan(800_000);
      expect(await importWithin(html)).toEqual({ layerCount: 1 });
    });

    it("imports 800 KB of <html openers without stalling on the document attribute probe", async () => {
      // 28.6 s before the rewrite for `/<html\b([^>]*)>/i` on this shape.
      const html = adversarialSnippet("<div data-layer-id=\"only\" data-layer-type=\"text\">hi</div>", "<html".repeat(160_000));
      expect(html.length).toBeGreaterThan(800_000);
      expect(await importWithin(html)).toEqual({ layerCount: 1 });
    });

    it("imports a 400 KB unterminated-tag run inside layer text without stalling", async () => {
      // The `/<[^>]*>/g` tag stripper was quadratic once the document ran out of `>`.
      const noise = "<!--".repeat(100_000);
      const html = adversarialSnippet(`<div data-layer-id="only" data-layer-type="text">${noise}</div>`);
      expect(html.length).toBeGreaterThan(400_000);
      expect(await importWithin(html)).toEqual({ layerCount: 1 });
    });
  });
});

/**
 * Layer list the pre-rewrite regex scanner would have produced for a `<main>` body.
 *
 * Only the observable part is reproduced — layer id and text — which is enough to pin the element
 * span, the winning `data-layer-id`, and the inner HTML the scanner hands to the text mapper.
 */
function legacyLayers(body: string): Array<{ id: string; text: string }> {
  const matcher = /<([a-zA-Z][\w:-]*)\b([^>]*\bdata-layer-id\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z][\w:-]*)\b([^>]*\bdata-layer-id\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)\/?>/g;
  const layers: Array<{ id: string; text: string }> = [];
  let match = matcher.exec(body);
  while (match) {
    const attrText = match[2] ?? match[5] ?? "";
    const innerHtml = match[3] ?? "";
    const attrs = new Map<string, string>();
    for (const attr of attrText.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs.set((attr[1] ?? "").toLowerCase(), attr[2] ?? attr[3] ?? "");
    }
    const id = attrs.get("data-layer-id");
    if (id) {
      const text = innerHtml.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_entity, code: string) =>
        code === "amp" ? "&" : code === "lt" ? "<" : code === "gt" ? ">" : code === "quot" ? "\"" : "'");
      layers.push({ id, text: text.replace(/\s+/g, " ").trim() });
    }
    match = matcher.exec(body);
  }
  return layers;
}

/** Deterministic PRNG so a fuzz failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Fragments chosen to hit the quirks the scanner must preserve: unclosed elements, self-closing
 * forms, single quotes, uppercase tag names matched case-sensitively by the close tag, nesting where
 * the lazy inner group stops at the *first* close tag, and two `data-layer-id` attributes in one
 * tag where the last one wins. `#` is replaced by a counter so ids stay unique.
 */
const LAYER_FUZZ_FRAGMENTS = [
  "<div data-layer-id=\"L#\" data-layer-type=\"text\">alpha</div>",
  "<span data-layer-id=\"L#\" data-layer-type=\"text\">beta",
  "<b data-layer-id=\"L#\" data-layer-type=\"text\"/>",
  "<div data-layer-id='L#' data-layer-type='text'>gamma</div>",
  "<DIV data-layer-id=\"L#\" data-layer-type=\"text\">upper</DIV>",
  "<div data-layer-id=\"L#\" data-layer-type=\"text\">outer<div data-layer-id=\"L#\" data-layer-type=\"text\">inner</div></div>",
  "<div data-layer-id=\"L#\" data-layer-id=\"L#\" data-layer-type=\"text\">dup</div>",
  "<div data-layer-id = \"L#\" data-layer-type=\"text\">spaced</div>",
  "<div class=\"plain\">no layer id</div>",
  "<p>", "</div>", "loose text ", "&amp;&lt;", " ", "<", "<div", "\n"
];

/** Build a deterministic corpus of `<main>` bodies with unique layer ids. */
function layerFuzzCorpus(count: number): string[] {
  const random = makeRandom(0xb0d1e5);
  const bodies: string[] = [];
  let counter = 0;
  for (let doc = 0; doc < count; doc += 1) {
    const pieces = 1 + Math.floor(random() * 6);
    let body = "<div data-layer-id=\"base\" data-layer-type=\"text\">base</div>";
    for (let piece = 0; piece < pieces; piece += 1) {
      const fragment = LAYER_FUZZ_FRAGMENTS[Math.floor(random() * LAYER_FUZZ_FRAGMENTS.length)] ?? "";
      body += fragment.replace(/#/g, () => String((counter += 1)));
    }
    bodies.push(body);
  }
  return bodies;
}

/** Wrap a `<main>` body in the metadata the importer requires, with optional leading noise. */
function adversarialSnippet(body: string, noise = ""): string {
  return [
    "<!doctype html><html data-shellx-motion-schema=\"shellx-motion/html-snippet@1\">",
    "<head><title>Adversarial</title></head><body>",
    noise,
    "<main data-composition-id=\"motion_adversarial\" style=\"width:1920px;height:1080px\">",
    body,
    "</main></body></html>"
  ].join("");
}

async function writeHtmlExportPackage(): Promise<string> {
  const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-html-export-package-"));
  await mkdir(join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "assets", "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"80\"><rect width=\"80\" height=\"80\" fill=\"#22c55e\"/></svg>", "utf8");
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_html_export",
    name: "HTML Export",
    motion: "motion.json",
    assets: ["assets/logo.svg"],
    sourceApp: "shellx-motion",
    compatibility: {
      lanes: ["native", "browser", "ffmpeg"],
      hosts: ["shellx-motion"]
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_html_export",
    name: "HTML Export",
    durationMs: 2400,
    fps: 24,
    width: 1280,
    height: 720,
    background: "#0f172a",
    provenance: {
      sourceApp: "shellx-motion",
      createdBy: "adapter-test"
    },
    assets: [],
    layers: [
      {
        id: "background",
        type: "shape",
        shape: "rounded-rect",
        startMs: 0,
        durationMs: 2400,
        width: 1280,
        height: 720,
        transform: { x: 0, y: 0, opacity: 1 },
        style: { fill: "#0f172a", radius: 0 }
      },
      {
        id: "headline",
        type: "text",
        text: "Deploy <now> & verify",
        startMs: 200,
        durationMs: 1400,
        transform: { x: 120, y: 180, opacity: 0.95 },
        style: { color: "#ffffff", fontSize: 72, fontWeight: 800, width: 860 }
      },
      {
        id: "logo",
        type: "image",
        source: "assets/logo.svg",
        startMs: 500,
        durationMs: 1200,
        transform: { x: 1030, y: 170, width: 120, height: 120 }
      },
      {
        id: "audio_bed",
        type: "audio",
        source: "assets/music.wav",
        startMs: 0,
        durationMs: 2400
      }
    ]
  }, null, 2)}\n`, "utf8");

  await loadMotionPackage(packageRoot);
  return packageRoot;
}

function htmlSnippetImportFixture(): string {
  return `<!doctype html>
<html lang="en" data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_html_import">
<head>
  <meta charset="utf-8">
  <title>Launch Card</title>
</head>
<body>
  <main class="shellx-motion-composition"
    data-composition-id="motion_html_import"
    data-start="0"
    data-duration="2400"
    data-fps="24"
    style="width: 1280px; height: 720px; background: #0f172a;">
    <div class="shellx-motion-layer shellx-motion-text"
      data-layer-id="headline"
      data-layer-type="text"
      data-start="200"
      data-duration="1400"
      style="left: 120px; top: 180px; width: 860px; height: 100px; opacity: 0.95; transform: scale(1.1) rotate(-5deg); color: #ffffff; font-size: 72px; font-weight: 800; text-align: center;">Deploy &lt;now&gt; &amp; verify</div>
    <div class="shellx-motion-layer shellx-motion-shape"
      data-layer-id="accent"
      data-layer-type="shape"
      data-start="450"
      data-duration="1600"
      style="left: 80px; top: 500px; width: 420px; height: 18px; background: #22c55e; border-radius: 12px;"></div>
    <img class="shellx-motion-layer shellx-motion-media"
      data-layer-id="logo"
      data-layer-type="image"
      data-start="500"
      data-duration="1200"
      src="assets/logo.svg"
      style="left: 1030px; top: 170px; width: 120px; height: 120px;">
    <section class="shellx-motion-layer"
      data-layer-id="webgl"
      data-layer-type="webgl"
      data-start="600"
      data-duration="900"></section>
  </main>
</body>
</html>
`;
}
