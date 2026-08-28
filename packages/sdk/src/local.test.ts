/** End-to-end local adapter tests against real Core, Debug API, receipts, and artifact attestation. */
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compositingGraphFingerprint,
  hashFile,
  readAttestedArtifactHandle,
  verifyAttestedArtifactHandle,
  type MotionCompositingGraph,
  type OperationReceipt,
} from "@shellx-motion/core";
import { createLocalMotionSdk } from "./local";
import { withTestAuthoringRoots } from "./local-test-authoring-context.test-support";

const tempDirs: string[] = [];
const SAMPLE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC", "base64");

describe("local Motion SDK", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses forged compositing metadata during ordinary package validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-forged-compositing-"));
    tempDirs.push(root);
    const packageRoot = join(root, "package");
    const receiptsRoot = join(root, "host-receipts");
    await cp(resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    const graph: MotionCompositingGraph = {
      schema: "shellx-motion/compositing-graph@1",
      id: "graph",
      nodes: [{ id: "source", type: "source", layerId: "title" }, { id: "output", type: "output" }],
      edges: [{ id: "edge", from: { nodeId: "source", port: "output" }, to: { nodeId: "output", port: "input" } }],
    };
    const fingerprint = compositingGraphFingerprint(graph);
    motion.compositing = graph;
    motion.layers = motion.layers.map((layer: Record<string, unknown>) => layer.id === "title"
      ? { ...layer, visible: false, "x-compositing-source-visible": "unset" }
      : layer.id === "subtitle"
        ? { ...layer, "x-compositing-generated": { schema: "shellx-motion/compositing-compile@1", graphId: graph.id, fingerprint } }
        : layer);
    motion["x-compositing-compile"] = {
      schema: "shellx-motion/compositing-compile@1",
      graphId: graph.id,
      fingerprint,
      nodeOrder: ["source", "output"],
      sourceLayerIds: ["title"],
      outputLayerIds: ["subtitle"],
      estimate: { nodeCount: 2, edgeCount: 1, sourceCount: 1, maxDepth: 2, maxFanOut: 1, pixelOperations: 1, workingBytes: 1 },
    };
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`);

    const validated = await createLocalMotionSdk().validate({ packageRoot, receiptsRoot });
    expect(validated).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: expect.stringContaining("deterministic graph compilation") } });
    if (validated.ok) throw new Error("unreachable");
    const detail = validated.error.detail as {
      validation?: unknown;
      validationReport?: unknown;
      receiptId?: unknown;
      receiptPath?: unknown;
    } | undefined;
    expect(detail).toMatchObject({
      validation: "compositing_compile_integrity",
      // The compatibility marker retains its long-standing location. The new report cannot use
      // that same key, so this narrow compatibility case carries it separately.
      validationReport: {
        contract: "shellx-motion/motion-validation@1",
        structural: "passed",
        semantic: "failed",
        renderability: "not_proven",
      },
      receiptId: expect.stringMatching(/^package-validate-/),
      receiptPath: expect.any(String),
    });
    expect(JSON.parse(await readFile(String(detail?.receiptPath), "utf8"))).toMatchObject({
      operation: "package.validate",
      status: "failed",
      output: {
        validation: { valid: false, compositingIntegrity: "invalid" },
        error: {
          code: "invalid_motion_document",
          detail: { validation: "compositing_compile_integrity" },
        },
      },
    });
  });

  it("previews, renders, attests, reuses, lists, and cancels real local jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-render-"));
    tempDirs.push(root);
    const packageRoot = resolve(import.meta.dirname, "../../../fixtures/packages/lower-third");
    const artifactRoot = join(root, "run");
    const previewRoot = join(root, "preview");
    const outputPath = join(artifactRoot, "final.mp4");
    const receiptsRoot = join(artifactRoot, ".shellx-motion", "receipts");
    await mkdir(join(artifactRoot, ".shellx-motion", "receipts"), { recursive: true, mode: 0o700 });
    await mkdir(join(artifactRoot, ".shellx-motion", "scratch"), { recursive: true, mode: 0o700 });
    let encodeCount = 0;
    const sdk = createLocalMotionSdk({
      callerId: "cut:workspace-7",
      browserFrameRenderer: async (pkg, options) => {
        const path = options.outputPath ?? join(options.outDir, "frame.png");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, SAMPLE_PNG);
        const output = {
          path,
          sha256: await hashFile(path),
          format: "png" as const,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "sdk-test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        };
        return {
          ok: true,
          output,
          receipt: receipt({ id: `preview-${options.atMs}`, operation: "preview.frame", packageId: pkg.manifest.id, output })
        };
      },
      ffmpegRunner: async (command) => {
        if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version sdk-test", stderr: "" };
        // Hardware-encode probe (default on for the debug-api render path the SDK uses) reports no
        // compiled hardware encoders -> software encode; it is not an encode command.
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
        // Delivered-colour readback (`verifyDeliveredColor`, default-on under the current contract): an
        // ffprobe READ of the file the encode just wrote, so it is not an encode either — and
        // answering it as one would rewrite the artifact whose sha256 this test pins.
        if (command.args.includes("-show_streams")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              streams: [{
                codec_type: "video", codec_name: "h264", width: 1280, height: 720, pix_fmt: "yuv420p",
                avg_frame_rate: "30/1", duration: "3.0",
                color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv"
              }],
              format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3.0" }
            }),
            stderr: ""
          };
        }
        encodeCount += 1;
        await mkdir(dirname(command.args.at(-1) as string), { recursive: true, mode: 0o700 });
        await writeFile(command.args.at(-1) as string, Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom sdk local", "ascii")]));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    const preview = await sdk.preview({ packageRoot, outDir: previewRoot, atMs: 250 });
    expect(preview).toMatchObject({
      ok: true,
      output: {
        packageId: "pkg_lower_third",
        motionId: "motion_lower_third",
        frame: { path: expect.stringMatching(/\.png$/), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), atMs: 250 },
        receiptPath: join(previewRoot, "receipts", "preview-250.receipt.json")
      }
    });
    if (!preview.ok) throw new Error("expected local SDK preview");
    const previewRelativePath = relative(previewRoot, preview.output.frame.path);
    expect(previewRelativePath).not.toBe("");
    expect(previewRelativePath).not.toBe("..");
    expect(previewRelativePath.startsWith(`..${sep}`)).toBe(false);
    expect(isAbsolute(previewRelativePath)).toBe(false);
    expect(await hashFile(preview.output.frame.path)).toBe(preview.output.frame.sha256);

    const request = {
      packageRoot,
      outputPath,
      artifactRoot,
      receiptsRoot,
      preset: "mp4-h264",
      cutHandoff: { target: "shellx-cut" as const, mode: "rendered_media" as const }
    };
    const rendered = await sdk.render(request);
    if (!rendered.ok) throw new Error(`local SDK render failed: ${JSON.stringify(rendered.error)}`);
    expect(rendered).toMatchObject({
      ok: true,
      output: {
        state: "succeeded",
        packageId: "pkg_lower_third",
        motionId: "motion_lower_third",
        preset: "mp4-h264",
        outputPath,
        receiptId: expect.stringMatching(/^ffmpeg-render-/),
        artifact: {
          schema: "shellx-motion/artifact-handle@1",
          operationHash: rendered.cacheKey,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          mediaType: "video/mp4",
          packageLineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
        },
        artifactReference: {
          schema: "shellx-motion/artifact-handle-ref@1",
          id: expect.any(String),
          operationHash: rendered.cacheKey,
          rootRelativePath: expect.stringContaining(".artifact.json"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        cutHandoff: {
          schema: "shellx-motion/cut-handoff@1",
          target: "shellx-cut",
          mode: "rendered_media",
          packageId: "pkg_lower_third",
          motionId: "motion_lower_third",
          artifactHandleId: expect.any(String),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      }
    });
    expect(encodeCount).toBe(1);
    const reused = await sdk.render(request);
    expect(reused).toMatchObject({ ok: true, output: { artifact: { sha256: rendered.ok ? rendered.output.artifact?.sha256 : "" }, warnings: [expect.stringContaining("Reused attested local render")] } });
    expect(encodeCount).toBe(1);
    if (process.platform !== "win32") {
      await chmod(artifactRoot, 0o777);
      const sharedRootReuse = await sdk.render(request);
      expect(sharedRootReuse).toMatchObject({
        ok: false,
        error: { code: "local_operation_failed", message: expect.stringMatching(/group- or world-writable|exclusive child authority/i) }
      });
      expect(encodeCount).toBe(1);
      await chmod(artifactRoot, 0o700);
    }
    const cutPlan = JSON.parse(await readFile(rendered.output.cutHandoff!.path, "utf8"));
    expect(cutPlan).toMatchObject({
      schema: "shellx-motion/cut-import-plan@1",
      ok: true,
      packageId: rendered.output.packageId,
      motionId: rendered.output.motionId,
      targetId: "shellx-cut",
      mode: "rendered_media",
      operations: [{ renderedMedia: { handle: rendered.output.artifactReference } }]
    });
    expect(cutPlan.receipt.inputHashes).toMatchObject({ artifactDescriptorSha256: rendered.output.artifactReference!.sha256, artifactOperationHash: rendered.cacheKey, manifestSha256: rendered.output.artifact!.packageLineage!.manifestSha256 });
    expect(JSON.parse(await readFile(join(receiptsRoot, `${rendered.output.receiptId}.receipt.json`), "utf8")).inputHashes).toEqual({ operationHash: rendered.cacheKey, manifestSha256: rendered.output.artifact!.packageLineage!.manifestSha256, motionSha256: rendered.output.artifact!.packageLineage!.motionSha256 });
    const collision = await sdk.render({ ...request, outputPath: join(artifactRoot, "different.mp4"), idempotencyKey: rendered.cacheKey });
    expect(collision).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: "SDK idempotency key was already used for a different render request." } });
    expect(encodeCount).toBe(1);

    if (!rendered.output.artifact) throw new Error("expected rendered artifact");
    const descriptorPath = join(artifactRoot, ".shellx-motion", "artifacts", `${rendered.cacheKey}.artifact.json`);
    const handle = await readAttestedArtifactHandle(descriptorPath);
    await expect(verifyAttestedArtifactHandle(artifactRoot, handle, { requiredReceiptRoles: ["render"], probe: false })).resolves.toMatchObject({ path: await realpath(outputPath) });

    const status = await sdk.status({ receiptsRoot });
    expect(status).toMatchObject({ ok: true, output: { jobs: [expect.objectContaining({ jobId: rendered.output.receiptId, state: "succeeded" })], stateCounts: { succeeded: 1 } } });

    const queued = receipt({ id: "render-sdk-queued", operation: "render.final", status: "not_run", packageId: "pkg_lower_third", output: { callerId: "sdk:local", path: join(artifactRoot, "queued.mp4") } });
    await writeFile(join(receiptsRoot, "queued.receipt.json"), `${JSON.stringify(queued, null, 2)}\n`);
    const cancelled = await sdk.cancel({ receiptsRoot, jobId: queued.id, reason: "user stopped export" });
    expect(cancelled).toMatchObject({ ok: false, error: { code: "job_unknown" } });
    const cancelledStatus = await sdk.status({ receiptsRoot, jobId: queued.id });
    expect(cancelledStatus).toMatchObject({ ok: true, output: { jobs: [{ jobId: queued.id, state: "pending" }], stateCounts: { pending: 1 } } });

    const cutPlanPath = rendered.output.cutHandoff!.path;
    const outsidePlan = join(root, "outside-cut-plan.json");
    await writeFile(outsidePlan, await readFile(cutPlanPath));
    await rm(cutPlanPath);
    let fileSymlinkSupported = true;
    try {
      await symlink(outsidePlan, cutPlanPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
      fileSymlinkSupported = false;
    }
    if (fileSymlinkSupported) {
      const swappedCutPlan = await sdk.render(request);
      expect(swappedCutPlan).toMatchObject({
        ok: false,
        error: { code: "local_operation_failed", message: expect.stringContaining("bounded canonical regular file") }
      });
    }
  }, 45_000);

  it("stamps an sdk actor onto host receipts, honoring a host-supplied actor identity", async () => {
    const source = resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third");

    // Helper: run a timeline edit through the local SDK and return the persisted host receipt's actor.
    const editAndReadActor = async (options?: { actor?: { kind?: "agent" | "human" | "host" | "unknown"; label?: string } }) => {
      const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-actor-"));
      tempDirs.push(root);
      const receiptsRoot = join(root, "host-receipts");
      const sdk = createLocalMotionSdk(withTestAuthoringRoots(options ? { actor: options.actor } : {}, { inputRoots: [source], outputRoots: [root] }));
      const edited = await sdk.timelineEdit({
        packageRoot: source,
        outDir: join(root, "edited"),
        receiptsRoot,
        edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 150, value: 0.5, easing: "ease-in-out" }
      });
      expect(edited.ok).toBe(true);
      const receiptId = edited.ok ? (edited.output.receipt as { id: string }).id : "";
      return JSON.parse(await readFile(join(receiptsRoot, `${receiptId}.receipt.json`), "utf8")).actor;
    };

    // Default: an in-process host embedding, transport "sdk".
    const defaulted = await editAndReadActor();
    expect(defaulted.kind).toBe("host");
    expect(defaulted.label).toBe("sdk");
    expect(defaulted.transport).toBe("sdk");
    expect(defaulted.grantedTier).toBe("edit_motion");

    // A host app can name itself; the observed "sdk" transport is still recorded and cannot be overridden.
    const named = await editAndReadActor({ actor: { kind: "agent", label: "studio-builder" } });
    expect(named.kind).toBe("agent");
    expect(named.label).toBe("studio-builder");
    expect(named.transport).toBe("sdk");
  });

  it("applies an atomic timeline edit and returns a receipt bound to the reopened package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-edit-"));
    tempDirs.push(root);
    const source = resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third");
    const sdk = createLocalMotionSdk(withTestAuthoringRoots({}, { inputRoots: [source, root], outputRoots: [root] }));
    const outDir = join(root, "edited");
    const edited = await sdk.timelineEdit({
      packageRoot: source,
      outDir,
      createdBy: "sdk-local-test",
      edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 150, value: 0.5, easing: "ease-in-out" }
    });
    expect(edited).toMatchObject({
      ok: true,
      output: {
        packageRoot: outDir,
        package: { packageId: "pkg_editable_lower_third", motionId: "motion_editable_lower_third", motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 150, value: 0.5, easing: "ease-in-out" },
        receipt: {
          schema: "shellx-motion/receipt@1",
          operation: "timeline.keyframe.upsert",
          status: "passed",
          path: join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      }
    });
    const reopened = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(reopened.layers.find((layer: { id: string }) => layer.id === "title")?.keyframes?.opacity).toEqual([
      { atMs: 150, value: 0.5, easing: "ease-in-out" }
    ]);
    expect(await readFile(join(outDir, "receipts", "timeline-keyframe-upsert.receipt.json"), "utf8")).toContain("timeline.keyframe.upsert");

    const movedDir = join(root, "moved");
    const moved = await sdk.timelineEdit({
      packageRoot: outDir,
      outDir: movedDir,
      edit: { kind: "keyframe.move", layerId: "title", target: "opacity", fromMs: 150, toMs: 260 }
    });
    expect(moved).toMatchObject({
      ok: true,
      output: {
        edit: { kind: "keyframe.move", layerId: "title", target: "opacity", fromMs: 150, toMs: 260 },
        receipt: { operation: "timeline.keyframe.move", status: "passed" }
      }
    });
    const movedMotion = JSON.parse(await readFile(join(movedDir, "motion.json"), "utf8"));
    expect(movedMotion.layers.find((layer: { id: string }) => layer.id === "title")?.keyframes?.opacity).toEqual([
      { atMs: 260, value: 0.5, easing: "ease-in-out" }
    ]);

    const repeated = await sdk.timelineEdit({
      packageRoot: source,
      outDir,
      edit: { kind: "keyframe.delete", layerId: "title", target: "opacity", atMs: 150 }
    });
    expect(repeated).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("empty or absent") } });
  });

  it("refuses an authoring output reached through an operating-system path alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-alias-"));
    tempDirs.push(root);
    const canonicalParent = join(root, "canonical");
    const aliasParent = join(root, "alias");
    await mkdir(canonicalParent, { recursive: true, mode: 0o700 });
    await symlink(canonicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const outDir = join(aliasParent, "edited");

    const source = resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third");
    const edited = await createLocalMotionSdk(withTestAuthoringRoots({}, { inputRoots: [source], outputRoots: [canonicalParent] })).timelineEdit({
      packageRoot: source,
      outDir,
      edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 150, value: 0.5 }
    });

    expect(edited).toMatchObject({ ok: false, error: { code: "timeline_keyframe_upsert_failed", message: expect.stringMatching(/authoring output root/i) } });
    if (!edited.ok) expect(edited.error.message).not.toContain(outDir);
  });

  it("applies allowlisted rich controls, including analytic particle fields, through the same atomic receipt path", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-rich-edit-"));
    tempDirs.push(root);
    const source = join(root, "source");
    await cp(resolve(import.meta.dirname, "../../../fixtures/packages/editable-lower-third"), source, { recursive: true });
    const sourceMotionPath = join(source, "motion.json");
    const sourceMotion = JSON.parse(await readFile(sourceMotionPath, "utf8"));
    const accent = sourceMotion.layers.find((layer: { id: string }) => layer.id === "accent");
    accent.effects = { motionBlur: { samples: 4, shutterAngle: 180 } };
    sourceMotion.layers.push({
      id: "dust", type: "particles", startMs: 0, durationMs: 1_000,
      transform: { x: 0, y: 0, width: 320, height: 180 },
      emitter: {
        seed: 7, count: 32, lifetimeMs: 900, color: "#ffffff",
        field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "vortex", centerX: 0.5, centerY: 0.5, strength: 0.4, softening: 0.2 }] }
      }
    });
    await writeFile(sourceMotionPath, `${JSON.stringify(sourceMotion, null, 2)}\n`);

    const outDir = join(root, "edited");
    const sdk = createLocalMotionSdk(withTestAuthoringRoots({}, { inputRoots: [root], outputRoots: [root] }));
    const result = await sdk.timelineEdit({
      packageRoot: source,
      outDir,
      createdBy: "canvas-rich-inspector",
      edit: { kind: "rich.set", layerId: "accent", path: "effects.motionBlur.shutterAngle", value: 270 }
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result).toMatchObject({
      ok: true,
      output: {
        packageRoot: outDir,
        edit: { kind: "rich.set", layerId: "accent", path: "effects.motionBlur.shutterAngle", value: 270 },
        receipt: { operation: "timeline.layer.rich.set", status: "passed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
      }
    });
    const reopened = JSON.parse(await readFile(join(outDir, "motion.json"), "utf8"));
    expect(reopened.layers.find((layer: { id: string }) => layer.id === "accent")?.effects.motionBlur.shutterAngle).toBe(270);
    expect(await readFile(join(outDir, "receipts", "timeline-layer-rich-set.receipt.json"), "utf8")).toContain("timeline.layer.rich.set");

    const fieldDir = join(root, "field-edited");
    const fieldResult = await sdk.timelineEdit({
      packageRoot: outDir,
      outDir: fieldDir,
      edit: { kind: "rich.set", layerId: "dust", path: "emitter.field.sources.0.strength", value: -0.35 }
    });
    expect(fieldResult).toMatchObject({ ok: true, output: { edit: { kind: "rich.set", layerId: "dust", path: "emitter.field.sources.0.strength", value: -0.35 }, receipt: { operation: "timeline.layer.rich.set", status: "passed" } } });
    const fieldMotion = JSON.parse(await readFile(join(fieldDir, "motion.json"), "utf8"));
    expect(fieldMotion.layers.find((layer: { id: string }) => layer.id === "dust")?.emitter.field.sources[0].strength).toBe(-0.35);
  });

  it("rejects render paths and receipt roots outside the declared artifact root before encoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-root-"));
    tempDirs.push(root);
    const ffmpegRunner = async () => { throw new Error("must not run FFmpeg"); };
    const sdk = createLocalMotionSdk({ ffmpegRunner });
    const result = await sdk.render({
      packageRoot: resolve(import.meta.dirname, "../../../fixtures/packages/lower-third"),
      artifactRoot: join(root, "artifacts"),
      outputPath: join(root, "outside", "final.mp4"),
      preset: "mp4-h264"
    });
    expect(result).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: "render output must be inside artifactRoot." } });

    const artifactRoot = join(root, "symlink-root");
    const outside = join(root, "symlink-outside");
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await symlink(outside, join(artifactRoot, "escaped"), process.platform === "win32" ? "junction" : "dir");
    const escaped = await sdk.render({
      packageRoot: resolve(import.meta.dirname, "../../../fixtures/packages/lower-third"),
      artifactRoot,
      outputPath: join(artifactRoot, "escaped", "final.mp4"),
      preset: "mp4-h264"
    });
    expect(escaped).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: "render output must be inside artifactRoot." } });
  });
});

function receipt(input: {
  id: string; operation: string; packageId: string; status?: OperationReceipt["status"]; output: unknown;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: input.operation,
    status: input.status ?? "passed",
    packageId: input.packageId,
    inputHashes: { source: "a".repeat(64) },
    createdAt: "2026-07-12T00:00:00.000Z",
    lane: "sdk-test",
    output: input.output,
    warnings: []
  };
}
