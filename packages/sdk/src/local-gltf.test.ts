import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile } from "@shellx-motion/core";
import { createLocalMotionSdk } from "./local.js";

const fixturePath = resolve("../../fixtures/imports/gltf-triangle/input.gltf");
const tempDirs: string[] = [];
const SAMPLE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC", "base64");

describe("local typed glTF SDK", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("imports with configured host roots and verifies package-local receipt bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-gltf-"));
    tempDirs.push(root);
    const sourcePath = join(root, "input", "triangle.gltf");
    const outDir = join(root, "packages", "triangle");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, await readFile(fixturePath));
    const sdk = createLocalMotionSdk({
      authoringInputRoots: [root],
      authoringOutputRoots: [root],
    });

    const result = await sdk.gltfImport({
      sourcePath,
      outDir,
      createdBy: "sdk-test",
      createdAt: "2026-07-13T09:30:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        packageRoot: outDir,
        format: "gltf",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bufferSha256: [expect.stringMatching(/^[a-f0-9]{64}$/)],
        sourceByteLength: expect.any(Number),
        package: { packageId: expect.stringMatching(/^pkg_gltf_/) },
        receipt: {
          operation: "adapter.lower",
          status: "warning",
          path: join(outDir, "receipts", "adapter-lowering.receipt.json"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        warnings: [expect.stringMatching(/Generated flat vertex normals/)],
      },
    });
    if (!result.ok) throw new Error("expected glTF import");
    const initialMotionSha256 = result.output.package.motionSha256;
    const motionPath = join(outDir, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers[0].scene3d.camera.orbitDegPerSecond = 18;
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`);
    const renderSdk = createLocalMotionSdk({
      browserFrameRenderer: async (pkg, options) => {
        const path = options.outputPath ?? join(options.outDir, "frame.png");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, SAMPLE_PNG);
        const output = { path, sha256: await hashFile(path), format: "png" as const, width: pkg.motion.width, height: pkg.motion.height, atMs: options.atMs, browser: { name: "chromium", version: "test" }, viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 } };
        return { ok: true, output, receipt: { schema: "shellx-motion/receipt@1", id: `gltf-edit-${options.atMs}`, operation: "preview.frame", status: "passed", packageId: pkg.manifest.id, inputHashes: {}, createdAt: "2026-07-15T00:00:00.000Z", lane: "test", output, warnings: [] } };
      },
      ffmpegRunner: async (command) => {
        if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
        // Hardware-encode probe (default on via the debug-api render path): no compiled hardware -> software.
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
        await writeFile(command.args.at(-1) as string, Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom", "ascii")]));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const rendered = await renderSdk.render({ packageRoot: outDir, artifactRoot: join(root, "render"), outputPath: join(root, "render", "edited.mp4"), preset: "mp4-h264" });
    expect(rendered).toMatchObject({ ok: true, output: { artifact: { packageLineage: { adapterId: "adapter.gltf", sourceSha256: result.output.sourceSha256 } } } });
    if (!rendered.ok || !rendered.output.artifact?.packageLineage) throw new Error("expected lineaged glTF render");
    expect(rendered.output.artifact.packageLineage.motionSha256).not.toBe(initialMotionSha256);
    expect(rendered.output.artifact.packageLineage.loweringReceiptSha256).toBe(await hashFile(result.output.receipt.path));
  });

  it("rejects relative paths before transport and missing host roots at execution", async () => {
    const sdk = createLocalMotionSdk();
    const relative = await sdk.gltfImport({ sourcePath: "model.gltf", outDir: "package" });
    expect(relative).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringMatching(/absolute/) },
    });

    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-gltf-untrusted-"));
    tempDirs.push(root);
    const unavailable = await sdk.gltfImport({
      sourcePath: join(root, "model.gltf"),
      outDir: join(root, "package"),
    });
    expect(unavailable).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringMatching(/host-approved/) },
    });
  });
});
