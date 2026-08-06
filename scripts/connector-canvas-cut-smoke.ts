import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCanvasBridgeFrameSelectionExport } from "../packages/connectors/src/index";

const repoRoot = resolve(import.meta.dirname, "..");
const canvasRoot = process.env.SHELLX_CANVAS_ROOT
  ? resolve(process.env.SHELLX_CANVAS_ROOT)
  : resolve(repoRoot, "..", "shellx-canvas");
const canvasBridgePath = join(canvasRoot, "app", "server", "motion-package.mjs");
const outRoot = join(repoRoot, ".scratch", "connectors", "canvas-real-project-cut");
const selectionPath = join(outRoot, "canvas-frame-selection.json");
const connectorOut = join(outRoot, "motion-to-cut");

if (!existsSync(canvasBridgePath)) {
  console.error(`Design Studio Motion bridge not found at ${canvasBridgePath}.`);
  console.error("Set SHELLX_CANVAS_ROOT to a compatible Design Studio checkout.");
  process.exit(2);
}

const canvasExport = await runCanvasBridgeFrameSelectionExport({
  canvasRoot,
  outPath: selectionPath,
  target: "sample",
  projectName: "Canvas Sample Project",
  frameName: "Story Hero",
  selectedIds: ["rect-blue", "heading"],
  generatedAt: new Date().toISOString(),
  trustedCanvasRoots: [canvasRoot]
});

console.log(JSON.stringify({
  ok: canvasExport.ok,
  command: "connector.canvas-frame-selection-export",
  canvasRoot,
  selectionPath,
  ...(canvasExport.ok
    ? { schema: canvasExport.schema, selectedFrameId: canvasExport.selectedFrameId, layerIds: canvasExport.layerIds }
    : { error: canvasExport.error })
}));

if (!canvasExport.ok) {
  process.exit(1);
}

const pnpm = pnpmProcessCommand([
    "--filter",
    "@shellx-motion/cli",
    "run",
    "cli",
    "--",
    "connector",
    "canvas-to-cut",
    selectionPath,
    "--out",
    connectorOut,
    "--dry-run-render"
  ]);
const child = spawn(
  pnpm.executable,
  pnpm.args,
  {
    cwd: repoRoot,
    env: process.env,
    shell: false,
    stdio: "inherit"
  }
);

child.on("error", (error) => {
  console.error(`Failed to start connector:canvas-cut-smoke: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`connector:canvas-cut-smoke stopped by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function pnpmProcessCommand(args: string[]): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: "cmd.exe", args: ["/d", "/s", "/c", "pnpm", ...args] };
  }
  return { executable: "pnpm", args };
}
