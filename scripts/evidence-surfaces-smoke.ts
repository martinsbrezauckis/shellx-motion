import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { arch, hostname, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const outDir = join(repoRoot, ".scratch", "evidence-surfaces-smoke");
const receiptsRoot = join(outDir, "receipts");
const previewOutDir = join(outDir, "preview");
const previewPath = join(previewOutDir, "preview.frame.png");
const renderOutDir = join(outDir, "render");
const renderPath = join(renderOutDir, "render.frame.png");
const supportOutDir = join(outDir, "support");
const reviewOutDir = join(outDir, "review");
const connectorOutDir = join(outDir, "connector");
const connectorSelectionPath = join(connectorOutDir, "canvas-selection.json");
const evidenceHostId = "local-evidence";

await rm(outDir, { recursive: true, force: true });
await mkdir(receiptsRoot, { recursive: true });

const previewResult = await dispatchDebugCommand(
  "motion.preview.frame",
  {
    packageRoot,
    outDir: previewOutDir,
    outputPath: previewPath,
    atMs: 0,
    createdAt: "2026-07-03T00:00:00.000Z"
  },
  {
    tier: "render_motion",
    scratchRoot: outDir,
    receiptsRoot
  }
);

assert(previewResult.ok, `motion.preview.frame failed: ${JSON.stringify(previewResult, null, 2)}`);
await stat(previewPath);
const previewPng = await readFile(previewPath);
assert(previewPng.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "preview.frame output is not a PNG");

const previewPayload = readObject(previewResult.result, "previewResult.result");
const previewReceipt = readObject(readObjectField(previewPayload, "receipt", "previewResult.receipt"), "preview receipt");
await writeJson(join(receiptsRoot, "preview-frame.receipt.json"), previewReceipt);

const renderResult = await dispatchDebugCommand(
  "motion.render.final",
  {
    packageRoot,
    outputPath: renderPath,
    framesDir: join(renderOutDir, "frames"),
    preset: "png-frame",
    atMs: 0
  },
  {
    tier: "render_motion",
    scratchRoot: outDir,
    receiptsRoot
  }
);
assert(renderResult.ok, `motion.render.final failed: ${JSON.stringify(renderResult, null, 2)}`);
await stat(renderPath);

await mkdir(connectorOutDir, { recursive: true });
await writeJson(connectorSelectionPath, animatedCanvasSelection());
const connectorResult = await dispatchDebugCommand(
  "motion.connector.canvas_to_cut",
  {
    canvasSelectionPath: connectorSelectionPath,
    outDir: connectorOutDir,
    cutImportMode: "rendered_media",
    dryRunRender: false,
    createdAt: "2026-07-03T00:00:01.500Z"
  },
  {
    tier: "write_local",
    scratchRoot: outDir,
    receiptsRoot
  }
);
assert(connectorResult.ok, `motion.connector.canvas_to_cut failed: ${JSON.stringify(connectorResult, null, 2)}`);
assertVisibleField(connectorResult.visibleState, "ok", true);
const connectorPayload = readObject(connectorResult.result, "connectorResult.result");
const connectorRender = readObject(readObjectField(connectorPayload, "render", "connectorResult.render"), "connector render");
const connectorRenderedMediaPath = readObjectField(connectorRender, "outputPath", "connectorResult.render.outputPath");
assert(typeof connectorRenderedMediaPath === "string", "connector rendered media path missing");
await stat(connectorRenderedMediaPath);

const platformReceipt = {
  schema: "shellx-motion/platform-verification@1",
  status: "passed",
  dryRun: false,
  host: {
    id: evidenceHostId,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    release: release(),
    node: process.version
  },
  hostMatrix: {
    required: [evidenceHostId],
    current: evidenceHostId,
    currentRequired: true,
    satisfied: [evidenceHostId],
    missing: [],
    complete: true,
    status: "complete"
  },
  repoRoot,
  startedAt: "2026-07-03T00:00:02.000Z",
  finishedAt: "2026-07-03T00:00:03.000Z",
  commands: [
    { id: "typecheck", command: ["pnpm", "typecheck"], required: true, category: "core", status: "passed", durationMs: 1 },
    { id: "test", command: ["pnpm", "test"], required: true, category: "core", status: "passed", durationMs: 1 },
    { id: "evidence-surfaces:smoke", command: ["pnpm", "run", "evidence-surfaces:smoke"], required: true, category: "agent", status: "passed", durationMs: 1 },
    { id: "render-alpha:smoke", command: ["pnpm", "run", "render-alpha:smoke"], required: true, category: "render", status: "passed", durationMs: 1 }
  ]
};
await writeJson(join(receiptsRoot, "linux.platform.json"), platformReceipt);

const receiptsPanel = await dispatchDebugCommand(
  "motion.receipts.panel",
  { receiptsRoot, limit: 10 },
  { tier: "read_motion", receiptsRoot }
);
assert(receiptsPanel.ok, `motion.receipts.panel failed: ${JSON.stringify(receiptsPanel, null, 2)}`);
assertVisibleField(receiptsPanel.visibleState, "panel", "receipts");
assertNumberAtLeast(readObjectField(receiptsPanel.visibleState, "receiptCount", "receiptsPanel.visibleState"), 2, "receiptsPanel.receiptCount");
assertNumberAtLeast(readObjectField(receiptsPanel.visibleState, "artifactCount", "receiptsPanel.visibleState"), 1, "receiptsPanel.artifactCount");
const receiptsPanelPayload = readObject(receiptsPanel.result, "receiptsPanel.result");
assertArtifactRoles(readArray(readObjectField(receiptsPanelPayload, "artifacts", "receiptsPanel.artifacts")), [
  "canvas_selection",
  "rendered_media",
  "cut_plan",
  "connector_receipt"
]);

const platformPanel = await dispatchDebugCommand(
  "motion.platform.verification.panel",
  { receiptsRoot, requiredHosts: [evidenceHostId] },
  { tier: "read_motion", receiptsRoot }
);
assert(platformPanel.ok, `motion.platform.verification.panel failed: ${JSON.stringify(platformPanel, null, 2)}`);
assertVisibleField(platformPanel.visibleState, "operation", "platform.verification.panel");
assertVisibleField(platformPanel.visibleState, "status", "passed");

const exportPanel = await dispatchDebugCommand(
  "motion.export.panel",
  { receiptsRoot, requiredHosts: [evidenceHostId] },
  { tier: "read_motion", receiptsRoot }
);
assert(exportPanel.ok, `motion.export.panel failed: ${JSON.stringify(exportPanel, null, 2)}`);
assertVisibleField(exportPanel.visibleState, "panel", "export");
assertVisibleField(exportPanel.visibleState, "platformVerificationStatus", "passed");
const exportPayload = readObject(exportPanel.result, "exportPanel.result");
const platformVerification = readObject(readObjectField(exportPayload, "platformVerification", "exportPanel.platformVerification"), "exportPanel.platformVerification");
assert.deepEqual(readObjectField(platformVerification, "satisfiedHosts", "platformVerification.satisfiedHosts"), [evidenceHostId]);

const packagesBrowse = await dispatchDebugCommand(
  "motion.packages.browse",
  { packageRoot },
  { tier: "read_motion" }
);
assert(packagesBrowse.ok, `motion.packages.browse failed: ${JSON.stringify(packagesBrowse, null, 2)}`);
assertVisibleField(packagesBrowse.visibleState, "panel", "packages");
assertVisibleField(packagesBrowse.visibleState, "packageCount", 1);

const actionsPanel = await dispatchDebugCommand(
  "motion.actions.panel",
  {},
  { tier: "read_motion" }
);
assert(actionsPanel.ok, `motion.actions.panel failed: ${JSON.stringify(actionsPanel, null, 2)}`);
assertVisibleField(actionsPanel.visibleState, "panel", "actions");
const actionsPayload = readObject(actionsPanel.result, "actionsPanel.result");
const actionIds = readArray(readObjectField(actionsPayload, "actions", "actionsPanel.actions"))
  .map((action) => readObjectField(action, "id", "action.id"));
assert(actionIds.includes("motion.support.bundle"), "actions panel missing motion.support.bundle");
assert(actionIds.includes("motion.review.html.bundle"), "actions panel missing motion.review.html.bundle");

const supportBundle = await dispatchDebugCommand(
  "motion.support.bundle",
  { packageRoot, outDir: supportOutDir, receiptsRoot },
  { tier: "write_local", scratchRoot: outDir, receiptsRoot }
);
assert(supportBundle.ok, `motion.support.bundle failed: ${JSON.stringify(supportBundle, null, 2)}`);
const supportPath = join(supportOutDir, "support-bundle.json");
await stat(supportPath);
const supportPayload = readObject(supportBundle.result, "supportBundle.result");
const supportBundlePayload = readObject(readObjectField(supportPayload, "bundle", "supportBundle.bundle"), "support bundle");
assertVisibleField(supportBundlePayload, "schema", "shellx-motion/support-bundle@1");
assertNumberAtLeast(readObjectField(readObjectField(supportBundlePayload, "receipts", "supportBundle.receipts"), "receiptCount", "supportBundle.receipts"), 2, "support receipt count");
assertNumberAtLeast(readObjectField(readObjectField(supportBundlePayload, "platformVerification", "supportBundle.platformVerification"), "receiptCount", "supportBundle.platformVerification"), 1, "support platform receipt count");
const supportReceipts = readArray(readObjectField(readObjectField(supportBundlePayload, "receipts", "supportBundle.receipts"), "receipts", "supportBundle.receipts"));
assert(
  supportReceipts.some((receipt) => readObjectField(receipt, "operation", "support receipt") === "connector.canvas_to_cut"),
  "support bundle missing connector.canvas_to_cut receipt summary"
);

const reviewBundle = await dispatchDebugCommand(
  "motion.review.html.bundle",
  { packageRoot, outDir: reviewOutDir, receiptsRoot, title: "Evidence Surfaces Smoke" },
  { tier: "write_local", scratchRoot: outDir, receiptsRoot }
);
assert(reviewBundle.ok, `motion.review.html.bundle failed: ${JSON.stringify(reviewBundle, null, 2)}`);
const reviewHtmlPath = join(reviewOutDir, "review-html-bundle.html");
await stat(reviewHtmlPath);
const reviewPayload = readObject(reviewBundle.result, "reviewBundle.result");
assertNumberAtLeast(readObjectField(reviewPayload, "receiptCount", "reviewBundle.receiptCount"), 2, "review receipt count");
assertNumberAtLeast(readObjectField(reviewPayload, "copiedArtifactCount", "reviewBundle.copiedArtifactCount"), 1, "review copied artifact count");
assertArtifactRoles(readArray(readObjectField(reviewPayload, "copiedArtifacts", "reviewBundle.copiedArtifacts")), [
  "canvas_selection",
  "rendered_media",
  "cut_plan",
  "connector_receipt"
]);
const reviewHtml = await readFile(reviewHtmlPath, "utf8");
assert(reviewHtml.includes("Evidence Surfaces Smoke"), "review-html-bundle.html missing title");
assert(reviewHtml.includes("pkg_lower_third"), "review-html-bundle.html missing package id");
assert(reviewHtml.includes("connector.canvas_to_cut"), "review-html-bundle.html missing connector receipt operation");

console.log(JSON.stringify({
  ok: true,
  command: "evidence-surfaces:smoke",
  packageRoot,
  receiptsRoot,
  previewPath,
  surfaces: {
    receiptsPanel: {
      receiptCount: readObjectField(receiptsPanel.visibleState, "receiptCount", "receiptsPanel.visibleState"),
      artifactCount: readObjectField(receiptsPanel.visibleState, "artifactCount", "receiptsPanel.visibleState")
    },
    platformPanel: {
      status: readObjectField(platformPanel.visibleState, "status", "platformPanel.visibleState")
    },
    exportPanel: {
      platformVerificationStatus: readObjectField(exportPanel.visibleState, "platformVerificationStatus", "exportPanel.visibleState")
    },
    packagesBrowse: {
      packageCount: readObjectField(packagesBrowse.visibleState, "packageCount", "packagesBrowse.visibleState")
    },
    actionsPanel: {
      actionCount: readObjectField(actionsPanel.visibleState, "actionCount", "actionsPanel.visibleState")
    },
    supportBundle: {
      bundlePath: supportPath,
      connectorReceipt: "connector.canvas_to_cut"
    },
    reviewBundle: {
      htmlPath: reviewHtmlPath,
      copiedArtifactCount: readObjectField(reviewPayload, "copiedArtifactCount", "reviewBundle.copiedArtifactCount")
    }
  }
}, null, 2));

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value as Record<string, unknown>;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  return Reflect.get(readObject(value, label), key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function assertVisibleField(value: unknown, key: string, expected: unknown): void {
  assert.deepEqual(readObjectField(value, key, `visibleState.${key}`), expected, `${key} mismatch`);
}

function assertNumberAtLeast(value: unknown, minimum: number, label: string): void {
  assert(typeof value === "number", `${label} must be a number`);
  assert(value >= minimum, `${label} must be at least ${minimum}, got ${value}`);
}

function assertArtifactRoles(artifacts: unknown[], expectedRoles: string[]): void {
  const roles = artifacts.map((artifact) => readObjectField(artifact, "role", "artifact.role"));
  for (const role of expectedRoles) {
    assert(roles.includes(role), `missing artifact role ${role}; roles=${JSON.stringify(roles)}`);
  }
}

function animatedCanvasSelection(): Record<string, unknown> {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_evidence",
    project: { id: "canvas_evidence", name: "Canvas Evidence" },
    brand: { tokens: { color: { accent: "#2563eb", ink: "#101828" } } },
    frames: [
      {
        id: "frame_evidence",
        name: "Evidence",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        background: "#f8fafc",
        layers: [
          {
            id: "panel",
            kind: "shape",
            shape: "rectangle",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 48, y: 44, width: 250, height: 150, opacity: 1 },
            style: { fill: "#2563eb" },
            ...revealMotion()
          },
          {
            id: "title",
            kind: "text",
            text: "Evidence render",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 64, y: 240, width: 420, height: 60, opacity: 1 },
            style: { fontSize: 36, color: "#101828" },
            ...revealMotion()
          }
        ]
      }
    ],
    imageEditorOutputs: []
  };
}

function revealMotion(): Record<string, unknown> {
  return {
    transitions: {
      in: { type: "slide", direction: "down", distance: 24, durationMs: 320, easing: "ease-out" },
      out: { type: "fade", durationMs: 260, easing: "ease-in" }
    },
    keyframes: {
      opacity: [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 320, value: 1 },
        { atMs: 740, value: 1, easing: "ease-in" },
        { atMs: 1000, value: 0 }
      ]
    }
  };
}
