/**
 * Batch-package and Canvas-bridge fixture builders for the ShellX Motion CLI test suite.
 *
 * Role: builders that write multi-row batch fixture packages (asset/audio/fast/variant) and the Canvas
 * bridge root used by connector tests. Extracted verbatim from `main.test.ts` for the module-size gate
 * without changing behavior.
 *
 * Dependencies: node fs/os/path built-ins plus the shared `tempDirs` registry from `main.test-support`
 * (one builder registers its own temp dir; the rest return roots the caller registers).
 *
 * Primary callers: `packages/cli/src/main.test.ts`.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tempDirs } from "./main.test-support";

export async function writeBatchPackageWithAsset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-batch-assets-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "product.txt"), "asset payload\n", "utf8");
  await writeFile(join(root, "data", "rows.json"), `${JSON.stringify([{ id: "one", title: "One" }], null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_asset_batch",
      name: "Asset Batch",
      motion: "motion.json",
      assets: ["assets/product.txt"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] },
      data: { rows: "data/rows.json" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_asset_batch",
      name: "Asset {{title}}",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [
        {
          id: "title",
          type: "text",
          text: "{{title}}",
          startMs: 0,
          durationMs: 300,
          transform: { x: 4, y: 4, scale: 1 },
          style: { color: "#ffffff", fontSize: 14 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

export async function writeAudioBatchPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-audio-batch-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "music.wav"), "fake wav bytes", "utf8");
  await writeFile(join(root, "data", "rows.json"), `${JSON.stringify({
    schema: "shellx-motion/data-rows@1",
    rows: [
      { id: "ada", name: "Ada" },
      { id: "grace", name: "Grace" }
    ]
  }, null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_audio_batch",
      name: "Audio Batch {{name}}",
      motion: "motion.json",
      assets: ["assets/music.wav"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion"] },
      data: { rows: "data/rows.json" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_audio_batch",
      name: "Audio Batch {{name}}",
      durationMs: 300,
      fps: 10,
      width: 640,
      height: 360,
      background: "#111827",
      layers: [
        {
          id: "title",
          type: "text",
          text: "Hello {{name}}",
          startMs: 0,
          durationMs: 300,
          transform: { x: 64, y: 132, scale: 1 },
          style: { color: "#f8fafc", fontSize: 56, fontWeight: 800, width: 520 }
        },
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 300,
          volume: 0.6
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "batch-render" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

export async function writeFastBatchPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-fast-batch-"));
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "data", "rows.json"), `${JSON.stringify({
    schema: "shellx-motion/data-rows@1",
    rows: [
      { id: "ada", name: "Ada", background: "#0f172a", accent: "#38bdf8" },
      { id: "grace", name: "Grace", background: "#111827", accent: "#22c55e" }
    ]
  }, null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_batch_card",
      name: "Batch Card {{name}}",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion"] },
      data: { rows: "data/rows.json" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_batch_card",
      name: "Batch Card {{name}}",
      durationMs: 300,
      fps: 10,
      width: 640,
      height: 360,
      background: "{{background}}",
      layers: [
        {
          id: "panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 300,
          transform: { x: 0, y: 0, scale: 1 },
          width: 640,
          height: 360,
          style: { fill: "{{background}}" }
        },
        {
          id: "title",
          type: "text",
          text: "Hello {{name}}",
          startMs: 0,
          durationMs: 300,
          transform: { x: 64, y: 132, scale: 1 },
          style: { color: "{{accent}}", fontSize: 56, fontWeight: 800, width: 520 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "batch-render" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

export async function writeVariantBatchPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-variant-batch-"));
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "data", "rows.json"), `${JSON.stringify({
    schema: "shellx-motion/data-rows@1",
    rows: [
      {
        id: "portrait",
        title: "Portrait",
        motion: { width: 1080, height: 1920, fps: 30, durationMs: 1500, background: "#101828" },
        variant: { panel: { width: 960, height: 640 }, titleWidth: 820 },
        theme: { background: "#101828", accent: "#f97316" }
      },
      {
        id: "square",
        title: "Square",
        motion: { width: 1080, height: 1080, fps: 24, durationMs: 1200, background: "#111827" },
        variant: { panel: { width: 880, height: 360 }, titleWidth: 720 },
        theme: { background: "#111827", accent: "#38bdf8" }
      }
    ]
  }, null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_variant_card",
      name: "Variant Card {{title}}",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion"] },
      data: { rows: "data/rows.json" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_variant_card",
      name: "Variant Card {{title}}",
      durationMs: 600,
      fps: 12,
      width: 640,
      height: 360,
      background: "#0f172a",
      layers: [
        {
          id: "panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 600,
          width: "{{variant.panel.width}}",
          height: "{{variant.panel.height}}",
          transform: { x: 60, y: 96, scale: 1 },
          style: { fill: "{{theme.background}}" }
        },
        {
          id: "title",
          type: "text",
          text: "{{title}} export",
          startMs: 0,
          durationMs: 600,
          transform: { x: 92, y: 132, scale: 1 },
          style: { color: "{{theme.accent}}", width: "{{variant.titleWidth}}", fontSize: 64, fontWeight: 800 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "batch-render" }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

export async function writeCanvasBridgeRoot(): Promise<string> {
  const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-canvas-root-"));
  tempDirs.push(canvasRoot);
  await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
  await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
  await writeFile(
    join(canvasRoot, "app", "server", "motion-package.mjs"),
    `
      import { mkdir, writeFile } from "node:fs/promises";
      import { dirname } from "node:path";
      export function buildMotionFrameSelection(input) {
        return {
          schema: "shellx-canvas/frame-selection@1",
          selectedFrameId: "frame_" + input.target,
          project: { id: input.target, name: input.projectName },
          brand: { tokens: input.brandTokens },
          frames: [{
            id: "frame_" + input.target,
            name: input.frameName,
            durationMs: input.durationMs,
            fps: input.fps,
            width: input.doc.width,
            height: input.doc.height,
            layers: input.doc.layers[0].ops.map((op) => ({ id: op.id, kind: op.kind, startMs: 0, durationMs: input.durationMs }))
          }],
          imageEditorOutputs: []
        };
      }
      export async function writeMotionFrameSelection(selection, options) {
        await mkdir(dirname(options.outPath), { recursive: true, mode: 0o700 });
        await writeFile(options.outPath, JSON.stringify(selection, null, 2) + "\\n", "utf8");
        return { ok: true, path: options.outPath, schema: selection.schema };
      }
    `,
    "utf8"
  );
  return canvasRoot;
}
