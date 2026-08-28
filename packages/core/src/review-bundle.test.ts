import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeReviewBundle } from "./review-bundle";
import { OutputDirectoryReservation } from "./output-path-topology";

const fixtureRoot = resolve("../../fixtures/packages/lower-third");

describe("review bundle", () => {
  it("refuses a configured artifact root replaced after its authority was retained", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-root-authority-"));
    const mediaRoot = join(tempRoot, "media");
    const replacedRoot = join(tempRoot, "media-original");
    const receiptsRoot = join(tempRoot, "receipts");
    const outDir = join(tempRoot, "bundle");
    const mediaPath = join(mediaRoot, "final.mp4");
    try {
      await mkdir(mediaRoot, { mode: 0o700 });
      await mkdir(receiptsRoot, { mode: 0o700 });
      await writeFile(mediaPath, "trusted media", "utf8");
      await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify({
        schema: "shellx-motion/receipt@1",
        id: "render-final-retained-root",
        operation: "render.final",
        status: "passed",
        packageId: "pkg_lower_third",
        inputHashes: { "motion.json": "abc123" },
        createdAt: "2026-08-12T00:00:00.000Z",
        lane: "ffmpeg",
        output: { path: mediaPath },
        artifacts: [{ role: "rendered_media", path: mediaPath, status: "available", primary: true }],
        warnings: []
      })}\n`, "utf8");
      const authority = await OutputDirectoryReservation.acquire(mediaRoot, {
        allowExistingContents: true,
        requireExisting: true,
        requireExclusiveChildAuthority: true
      });

      await rename(mediaRoot, replacedRoot);
      await mkdir(mediaRoot, { mode: 0o700 });
      await writeFile(mediaPath, "replacement media", "utf8");

      await expect(writeReviewBundle({
        packageRoot: fixtureRoot,
        receiptsRoot,
        outDir,
        artifactRootAuthorities: [authority]
      })).rejects.toThrow(/changed after Motion captured its identity|topology changed after admission/i);
      await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes a portable HTML review bundle with copied receipt artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const mediaRoot = join(tempRoot, "media");
    const outDir = join(tempRoot, "bundle");
    const mediaPath = join(mediaRoot, "final.mp4");
    const qualityManifestPath = join(tempRoot, "quality", "final.quality-manifest.json");
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
      await writeFile(mediaPath, "fake mp4 bytes", "utf8");
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify({
          schema: "shellx-motion/receipt@1",
          id: "render-final-review",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_lower_third",
          inputHashes: { "motion.json": "abc123" },
          createdAt: "2026-07-01T12:00:00.000Z",
          lane: "ffmpeg",
          output: {
            path: mediaPath,
            width: 1920,
            height: 1080,
            durationMs: 2500,
            codec: "h264",
            container: "mp4",
            qualityManifestPath,
            qualityCheck: { status: "passed", receiptId: "quality-check-final" }
          },
          artifacts: [
            { role: "rendered_media", path: mediaPath, status: "available", mediaType: "video/mp4", primary: true }
          ],
          warnings: []
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await writeReviewBundle({
        packageRoot: fixtureRoot,
        receiptsRoot,
        outDir,
        title: "Client Review",
        createdAt: "2026-07-01T12:30:00.000Z",
        // The media directory sits beside receiptsRoot, so it must be approved explicitly:
        // receipt-referenced paths only enter the bundle from roots the caller vouched for.
        artifactRoots: [mediaRoot]
      });

      const html = await readFile(result.htmlPath, "utf8");
      const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
      const copied = result.copiedArtifacts[0];

      expect(result).toMatchObject({
        ok: true,
        packageId: "pkg_lower_third",
        htmlPath: join(outDir, "review-html-bundle.html"),
        receiptPath: join(outDir, "review-html-bundle.receipt.json"),
        receiptCount: 1,
        copiedArtifactCount: 1,
        omittedArtifactCount: 0,
        qualityGateCount: 1,
        failedQualityGateCount: 0
      });
      expect(copied).toMatchObject({
        role: "rendered_media",
        mediaType: "video/mp4",
        path: join(outDir, copied.relativePath),
        relativePath: expect.stringMatching(/^artifacts\/rendered_media-[a-f0-9]{12}-final\.mp4$/)
      });
      expect(await readFile(join(outDir, copied.relativePath), "utf8")).toBe("fake mp4 bytes");
      expect(html).toContain("Client Review");
      expect(html).toContain("Lower Third Fixture");
      expect(html).toContain("render.final");
      expect(html).toContain("Quality Gate");
      expect(html).toContain("final.quality-manifest.json");
      expect(html).toContain("quality-check-final");
      expect(html).toContain(copied.relativePath);
      expect(html).toContain(basename(mediaPath));
      expect(html).not.toContain(mediaRoot);
      expect(html).not.toContain(join(tempRoot, "quality"));
      expect(receipt).toMatchObject({
        operation: "review.html.bundle",
        status: "passed",
        packageId: "pkg_lower_third",
        output: {
          htmlPath: "review-html-bundle.html",
          receiptPath: "review-html-bundle.receipt.json",
          receiptCount: 1,
          copiedArtifactCount: 1,
          qualityGateCount: 1,
          failedQualityGateCount: 0
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "review_html_bundle", path: "review-html-bundle.html", status: "available", mediaType: "text/html", primary: true }),
          expect.objectContaining({ role: "review_html_bundle_receipt", path: "review-html-bundle.receipt.json", status: "available", mediaType: "application/json" }),
          expect.objectContaining({ role: "review_artifact", path: copied.relativePath, status: "available", mediaType: "video/mp4" })
        ])
      });
      expect(JSON.stringify(receipt)).not.toContain(outDir);
      expect(result.receipt.output).toMatchObject({
        htmlPath: "review-html-bundle.html",
        receiptPath: "review-html-bundle.receipt.json"
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  // Regression for receipt-controlled paths disclosing local files through review bundles:
  // receipts are data read from an operator-selected directory, so
  // a crafted receipt pointing artifacts[].path or output.path at an arbitrary readable file must
  // not get that file copied into a bundle built to be shared. Out-of-root references have to
  // surface as explicit omissions — visible to the reviewer, absent from the bundle bytes.
  it("omits receipt-referenced files outside the approved roots instead of copying them", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-escape-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const secretsRoot = join(tempRoot, "secrets");
    const outDir = join(tempRoot, "bundle");
    const insideMediaPath = join(receiptsRoot, "final.mp4");
    const credentialsPath = join(secretsRoot, "credentials.txt");
    const notesPath = join(secretsRoot, "render-notes.txt");
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await mkdir(secretsRoot, { recursive: true, mode: 0o700 });
      await writeFile(insideMediaPath, "fake mp4 bytes", "utf8");
      await writeFile(credentialsPath, "s3cret-credential-bytes", "utf8");
      await writeFile(notesPath, "s3cret-notes-bytes", "utf8");
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify({
          schema: "shellx-motion/receipt@1",
          id: "render-final-escape",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_lower_third",
          inputHashes: { "motion.json": "abc123" },
          createdAt: "2026-07-01T12:00:00.000Z",
          lane: "ffmpeg",
          // output.path exercises the artifactCandidates() fallback source, artifacts[] the
          // declared-artifact source — both must be bound to the approved roots.
          output: { path: notesPath },
          artifacts: [
            { role: "rendered_media", path: insideMediaPath, status: "available", mediaType: "video/mp4", primary: true },
            { role: "evidence", path: credentialsPath, status: "available" }
          ],
          warnings: []
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await writeReviewBundle({
        receiptsRoot,
        outDir,
        createdAt: "2026-07-01T12:30:00.000Z"
      });

      expect(result).toMatchObject({
        copiedArtifactCount: 1,
        omittedArtifactCount: 2
      });
      expect(result.copiedArtifacts.map((artifact) => artifact.role)).toEqual(["rendered_media"]);
      expect(result.omittedArtifacts).toEqual([
        { role: "evidence", sourceName: "credentials.txt", reason: "outside_approved_roots", receiptId: "render-final-escape", operation: "render.final" },
        { role: "receipt_output", sourceName: "render-notes.txt", reason: "outside_approved_roots", receiptId: "render-final-escape", operation: "render.final" }
      ]);

      // The bundle directory must hold only the approved in-root copy — no secret bytes at all.
      const bundledArtifacts = await readdir(join(outDir, "artifacts"));
      expect(bundledArtifacts).toHaveLength(1);
      expect(bundledArtifacts[0]).toMatch(/^rendered_media-/);
      expect(await readFile(join(outDir, "artifacts", bundledArtifacts[0]), "utf8")).toBe("fake mp4 bytes");

      // Omissions are explicit in the HTML but never leak the withheld host location.
      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain("credentials.txt");
      expect(html).toContain("render-notes.txt");
      expect(html).toContain("outside the approved artifact roots");
      expect(html).not.toContain(secretsRoot);
      expect(html).not.toContain("s3cret");

      // Same for the portable receipt: counts and reasons yes, host paths no.
      const rawReceipt = await readFile(result.receiptPath, "utf8");
      expect(rawReceipt).not.toContain(secretsRoot);
      const receipt = JSON.parse(rawReceipt) as Record<string, any>;
      expect(receipt.output).toMatchObject({
        copiedArtifactCount: 1,
        omittedArtifactCount: 2,
        omittedArtifacts: [
          expect.objectContaining({ role: "evidence", reason: "outside_approved_roots" }),
          expect.objectContaining({ role: "receipt_output", reason: "outside_approved_roots" })
        ]
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records an unapproved outputPath fallback without reading or exposing its bytes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-output-path-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const privateRoot = join(tempRoot, "private");
    const outDir = join(tempRoot, "bundle");
    const privatePath = join(privateRoot, "operator-notes.txt");
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      await writeFile(privatePath, "do-not-package-this", "utf8");
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify({
          schema: "shellx-motion/receipt@1",
          id: "render-final-output-path-escape",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_lower_third",
          inputHashes: { "motion.json": "abc123" },
          createdAt: "2026-07-01T12:00:00.000Z",
          lane: "ffmpeg",
          // Some operations use outputPath rather than path. It is receipt-controlled too, so it
          // must travel through the exact same canonical-root and omission-ledger boundary.
          output: { outputPath: privatePath },
          warnings: []
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await writeReviewBundle({
        receiptsRoot,
        outDir,
        createdAt: "2026-07-01T12:30:00.000Z"
      });

      expect(result).toMatchObject({ copiedArtifactCount: 0, omittedArtifactCount: 1 });
      expect(result.omittedArtifacts).toEqual([
        { role: "receipt_output", sourceName: "operator-notes.txt", reason: "outside_approved_roots", receiptId: "render-final-output-path-escape", operation: "render.final" }
      ]);
      expect(await readdir(outDir)).not.toContain("artifacts");
      const html = await readFile(result.htmlPath, "utf8");
      const rawReceipt = await readFile(result.receiptPath, "utf8");
      expect(html).toContain("operator-notes.txt");
      expect(html).not.toContain(privateRoot);
      expect(html).not.toContain("do-not-package-this");
      expect(rawReceipt).not.toContain(privateRoot);
      expect(rawReceipt).not.toContain("do-not-package-this");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  /**
   * Regression for the receipt-controlled silent-skip holes fixed before 0.1.0.
   *
   * `copyReviewArtifacts` opened with a bare `continue` for artifacts whose `status` was not
   * `available`, whose `path` was empty, or whose `path` carried a URL scheme. All three are
   * receipt-declared values, and receipts are review INPUT DATA read from an operator-selected
   * directory — so a crafted receipt could withhold a real artifact by declaring it `failed` (or
   * pointing it at `file:///...`) and the bundle still reported `omittedArtifactCount: 0`,
   * presenting itself as complete. That is precisely the class the ledger was written to prevent,
   * left open by a `continue` that predated it.
   *
   * Every skip now travels through the ledger with its own reason, so the count and the HTML tell
   * the reviewer that evidence was declared and withheld.
   */
  it("records receipt-declared skips in the omission ledger instead of dropping them silently", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-ledger-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const outDir = join(tempRoot, "bundle");
    const hiddenPath = join(receiptsRoot, "hidden-evidence.mp4");
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await writeFile(hiddenPath, "evidence bytes", "utf8");
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify({
          schema: "shellx-motion/receipt@1",
          id: "render-final-hidden",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_lower_third",
          inputHashes: { "motion.json": "abc123" },
          createdAt: "2026-07-01T12:00:00.000Z",
          lane: "ffmpeg",
          output: {},
          artifacts: [
            // In-root and readable, but declared "failed" so the pre-fix loop skipped it silently.
            { role: "hidden_by_status", path: hiddenPath, status: "failed", mediaType: "video/mp4" },
            // Legal statuses that are genuinely not shippable — disclosed, not hidden.
            { role: "hidden_by_planned", path: join(receiptsRoot, "planned.mp4"), status: "planned" },
            { role: "hidden_by_not_required", path: join(receiptsRoot, "skipped.mp4"), status: "not_required" },
            // A URL scheme dodged the loop entirely and was never dereferenced OR reported.
            { role: "hidden_by_scheme", path: "file:///etc/hostname", status: "available" }
          ],
          warnings: []
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await writeReviewBundle({
        receiptsRoot,
        outDir,
        createdAt: "2026-07-01T12:30:00.000Z"
      });

      expect(result).toMatchObject({ copiedArtifactCount: 0, omittedArtifactCount: 4 });
      expect(result.omittedArtifacts).toEqual([
        { role: "hidden_by_status", sourceName: "hidden-evidence.mp4", reason: "declared_unavailable", receiptId: "render-final-hidden", operation: "render.final" },
        { role: "hidden_by_planned", sourceName: "planned.mp4", reason: "declared_unavailable", receiptId: "render-final-hidden", operation: "render.final" },
        { role: "hidden_by_not_required", sourceName: "skipped.mp4", reason: "declared_unavailable", receiptId: "render-final-hidden", operation: "render.final" },
        { role: "hidden_by_scheme", sourceName: "hostname", reason: "non_local_path", receiptId: "render-final-hidden", operation: "render.final" }
      ]);

      // The withheld artifact's bytes stay out of the bundle, and the withholding is visible.
      const html = await readFile(result.htmlPath, "utf8");
      expect(html).not.toContain("evidence bytes");
      expect(html).toContain("the receipt declared this artifact as not available");
      expect(html).toContain("the receipt named a URL rather than a local file");
      const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
      expect(receipt.output.omittedArtifactCount).toBe(4);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("omits artifacts whose canonical path escapes an approved root through a symlink", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-symlink-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const privateRoot = join(tempRoot, "private");
    const outDir = join(tempRoot, "bundle");
    try {
      await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
      await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(privateRoot, "target.mp4"), "private bytes", "utf8");
      // A directory symlink inside receiptsRoot: the declared path looks in-root lexically, but
      // its canonical location is outside — exactly what realpath-based binding must reject.
      await symlink(privateRoot, join(receiptsRoot, "media-link"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(
        join(receiptsRoot, "render.receipt.json"),
        `${JSON.stringify({
          schema: "shellx-motion/receipt@1",
          id: "render-final-symlink",
          operation: "render.final",
          status: "passed",
          packageId: "pkg_lower_third",
          inputHashes: { "motion.json": "abc123" },
          createdAt: "2026-07-01T12:00:00.000Z",
          lane: "ffmpeg",
          output: {},
          artifacts: [
            { role: "rendered_media", path: join(receiptsRoot, "media-link", "target.mp4"), status: "available", mediaType: "video/mp4", primary: true }
          ],
          warnings: []
        }, null, 2)}\n`,
        "utf8"
      );

      const result = await writeReviewBundle({
        receiptsRoot,
        outDir,
        createdAt: "2026-07-01T12:30:00.000Z"
      });

      expect(result).toMatchObject({ copiedArtifactCount: 0, omittedArtifactCount: 1 });
      expect(result.omittedArtifacts).toEqual([
        { role: "rendered_media", sourceName: "target.mp4", reason: "outside_approved_roots", receiptId: "render-final-symlink", operation: "render.final" }
      ]);
      const html = await readFile(result.htmlPath, "utf8");
      expect(html).not.toContain("private bytes");
      expect(html).toContain("outside the approved artifact roots");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes batch quality gate rows in the portable HTML bundle", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-quality-"));
    const outDir = join(tempRoot, "bundle");
    const qualityManifestPath = join(tempRoot, "quality", "batch.quality-manifest.json");
    try {
      const result = await writeReviewBundle({
        packageRoot: fixtureRoot,
        outDir,
        copyArtifacts: false,
        receipts: [{
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "batch-render-quality",
            operation: "render.batch",
            status: "failed",
            packageId: "pkg_lower_third",
            inputHashes: { "motion.json": "abc123" },
            createdAt: "2026-07-01T12:00:00.000Z",
            lane: "batch",
            output: {
              qualityManifestPath,
              jobs: [
                {
                  rowId: "ada",
                  packageId: "pkg_lower_third_ada",
                  qualityManifestAppliedPath: join(tempRoot, "quality", "ada.quality-manifest.json"),
                  qualityCheck: { status: "passed" }
                },
                {
                  rowId: "grace",
                  packageId: "pkg_lower_third_grace",
                  qualityManifestAppliedPath: join(tempRoot, "quality", "grace.quality-manifest.json"),
                  qualityCheck: { status: "failed", error: { code: "blank_frame", message: "Blank frame detected" } }
                }
              ]
            },
            warnings: ["Batch row grace failed quality checks."]
          }
        }],
        createdAt: "2026-07-01T12:30:00.000Z"
      });

      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain("batch.quality-manifest.json");
      expect(html).toContain("2 rows");
      expect(html).toContain("1 passed");
      expect(html).toContain("1 failed");
      expect(html).toContain("blank_frame");
      expect(html).toContain("Blank frame detected");
      expect(html).not.toContain(join(tempRoot, "quality"));
      expect(result).toMatchObject({
        qualityGateCount: 1,
        failedQualityGateCount: 1,
        receipt: {
          output: {
            qualityGateCount: 1,
            failedQualityGateCount: 1
          }
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps nested receipt input hashes distinct when filenames repeat", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-review-bundle-nested-receipts-"));
    const receiptsRoot = join(tempRoot, "receipts");
    const outDir = join(tempRoot, "bundle");
    try {
      await mkdir(join(receiptsRoot, "batch-a"), { recursive: true, mode: 0o700 });
      await mkdir(join(receiptsRoot, "batch-b"), { recursive: true, mode: 0o700 });
      for (const batch of ["batch-a", "batch-b"]) {
        await writeFile(
          join(receiptsRoot, batch, "render.receipt.json"),
          `${JSON.stringify({
            schema: "shellx-motion/receipt@1",
            id: `render-final-${batch}`,
            operation: "render.final",
            status: "passed",
            packageId: "pkg_lower_third",
            inputHashes: { "motion.json": batch },
            createdAt: "2026-07-01T12:00:00.000Z",
            lane: "ffmpeg",
            output: { path: join(tempRoot, `${batch}.mp4`) },
            warnings: []
          }, null, 2)}\n`,
          "utf8"
        );
      }

      const result = await writeReviewBundle({
        packageRoot: fixtureRoot,
        receiptsRoot,
        outDir,
        createdAt: "2026-07-01T12:30:00.000Z",
        copyArtifacts: false
      });

      const inputHashes = result.receipt.inputHashes;
      expect(Object.keys(inputHashes)).toEqual(expect.arrayContaining([
        "receipt:batch-a/render.receipt.json",
        "receipt:batch-b/render.receipt.json"
      ]));
      expect(inputHashes["receipt:render.receipt.json"]).toBeUndefined();
      expect(inputHashes["receipt:batch-a/render.receipt.json"]).not.toBe(inputHashes["receipt:batch-b/render.receipt.json"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
