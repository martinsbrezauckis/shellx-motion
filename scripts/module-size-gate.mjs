/**
 * Keep package modules small enough to expose coherent extraction boundaries.
 *
 * Every source module beneath packages/<package>/src is governed. New production
 * modules receive the default cap; only named, existing legacy hotspots may use
 * a non-growth baseline while their extraction work is staged separately.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_MODULE = /^packages\/[^/]+\/src\/.+\.(?:[cm]?[jt]sx?)$/;
const TEST_MODULE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

const DEFAULT_LIMITS = Object.freeze({
  production: 350,
  test: 600
});

// These are deliberately tighter than the directory defaults. They keep the small boundary
// modules that were extracted during previous sweeps from silently growing back together.
const REVIEWED_LIMITS = new Map([
  ["packages/debug-api/src/command-metadata.ts", 200],
  ["packages/debug-api/src/command-metadata-shared.ts", 200],
  ["packages/debug-api/src/domains/agent-plan-arguments.ts", 200],
  ["packages/debug-api/src/domains/enum-error.ts", 200],
  ["packages/actions/src/catalog-surface-commands.ts", 200],
  ["packages/debug-server/src/websocket-frame.ts", 200],
  ["packages/renderer-browser/src/index.fixtures-text.ts", 450],
  ["packages/core/src/capability-cards.ts", 400],
  ["packages/core/src/validate-schemas.ts", 200],
  ["packages/core/src/motion-density.ts", 400],
  ["packages/cli/src/help-command.ts", 200],
  ["packages/cli/src/browser-workflow-decode.ts", 200],
  ["packages/cli/src/entry-point.ts", 100],
  ["packages/cli/src/retired-options.ts", 100],
  ["packages/cli/src/main.test-support.ts", 500],
  ["packages/cli/src/main.fixtures-packages.ts", 550],
  ["packages/renderer-ffmpeg/src/report-redaction.ts", 200],
  ["packages/core/src/executable-trust.ts", 250],
  ["packages/core/src/playwright-browser-cache.ts", 250],
  ["packages/renderer-browser/src/browser-screenshot-integrity.ts", 180],
  ["packages/connectors/src/ffprobe-readback.test-support.ts", 200],
  ["packages/debug-api/src/ffprobe-readback.test-support.ts", 200],
  ["packages/debug-api/src/caller-boundary.ts", 200],
  ["packages/debug-api/src/receipt-raw-prompt-purge.ts", 200],
  ["packages/debug-api/src/receipt-store-discovery.ts", 200],
  ["packages/debug-api/src/prompt-reentry-fence.test.ts", 300],
  ["packages/debug-api/src/receipt-expiry-purge.test.ts", 300],
  ["packages/debug-api/src/agent-revision-contact-sheet-fence.test.ts", 300],
  ["packages/debug-server/src/sdk-route.ts", 200],
  ["packages/debug-server/src/sdk-transport-fence.test.ts", 300],
  ["packages/debug-server/src/receipts-root-declaration.test.ts", 300],
  ["packages/sdk/src/local-debug-context.ts", 150],
  ["packages/sdk/src/types.ts", 285],
  ["packages/sdk/src/local.test.ts", 491],
  ["packages/sdk/src/local-keyframe-edits.test.ts", 300]
]);

// Existing oversized files are explicit non-growth baselines, not a pattern or directory-wide
// exemption. A newly added path cannot inherit one of these values.
const LEGACY_NON_GROWTH_BASELINES = new Map([
  ["packages/core/src/adapter-diagnostics.ts", 1_489],
  ["packages/core/src/capabilities.ts", 453],
  ["packages/core/src/types.ts", 755],
  ["packages/core/src/validate.ts", 5_207],
  ["packages/core/src/timeline.ts", 5_795],
  ["packages/core/src/timeline.test.ts", 5_815],
  ["packages/renderer-browser/src/index.ts", 4_759],
  ["packages/renderer-native/src/index.ts", 1_322],
  ["packages/renderer-browser/src/index.test.ts", 6_423],
  ["packages/actions/src/catalog.ts", 2_991],
  ["packages/actions/src/catalog.test.ts", 1_494],
  ["packages/sdk/src/local.ts", 1_101],
  ["packages/sdk/src/client.ts", 383],
  ["packages/debug-server/src/index.ts", 1_500],
  ["packages/debug-api/src/command-metadata-core.ts", 834],
  ["packages/debug-api/src/index.ts", 9_891],
  ["packages/debug-api/src/index.test.ts", 24_200],
  ["packages/cli/src/main.ts", 7_427],
  ["packages/cli/src/main.test.ts", 17_995],
  ["packages/adapters-canvas/src/fixture-parse.ts", 370],
  ["packages/adapters-cut/src/index.test.ts", 1_007],
  ["packages/adapters-cut/src/index.ts", 1_097],
  ["packages/adapters-html/src/index.test.ts", 743],
  ["packages/adapters-html/src/index.ts", 300],
  ["packages/adapters-otio/src/index.ts", 773],
  ["packages/adapters-script/src/index.test.ts", 834],
  ["packages/adapters-script/src/index.ts", 1_132],
  ["packages/agent-runtime/src/index.test.ts", 738],
  ["packages/agent-runtime/src/index.ts", 1_121],
  ["packages/analysis-tracking/src/index.ts", 351],
  ["packages/connectors/src/canvas-bridge.ts", 379],
  ["packages/connectors/src/canvas-to-cut.test.ts", 1_167],
  ["packages/connectors/src/canvas-to-cut.ts", 586],
  ["packages/connectors/src/canvas-to-mp4.test.ts", 861],
  ["packages/connectors/src/canvas-to-mp4.ts", 487],
  ["packages/connectors/src/script-to-cut.ts", 567],
  ["packages/connectors/src/template-to-cut.ts", 693],
  ["packages/core/src/agent-job.ts", 551],
  ["packages/core/src/artifact-handle.ts", 636],
  ["packages/core/src/bounded-markup.ts", 715],
  ["packages/core/src/browser-workflow-catalog.ts", 365],
  ["packages/core/src/capabilities.test.ts", 1_757],
  ["packages/core/src/chart-template.ts", 455],
  ["packages/core/src/data.ts", 561],
  ["packages/core/src/generated/job-status.ts", 541],
  ["packages/core/src/integration-protocol.ts", 369],
  ["packages/core/src/job-governor.ts", 1_058],
  ["packages/core/src/job-lease.ts", 477],
  ["packages/core/src/keyframe-readability.ts", 448],
  ["packages/core/src/output-dir-guard.ts", 371],
  ["packages/core/src/package-archive.ts", 687],
  ["packages/core/src/package-create.ts", 398],
  ["packages/core/src/package.ts", 555],
  ["packages/core/src/quality.ts", 1_006],
  ["packages/core/src/receipts.ts", 432],
  ["packages/core/src/review-bundle.ts", 538],
  ["packages/core/src/schema.test.ts", 4_091],
  ["packages/core/src/source-import.ts", 686],
  ["packages/core/src/tracking-analysis.ts", 782],
  ["packages/core/src/tracking-solver.ts", 633],
  ["packages/debug-api/src/domains/agent.ts", 424],
  ["packages/debug-api/src/domains/authoring-tracking.ts", 617],
  ["packages/debug-api/src/domains/authoring-vector-package.ts", 476],
  ["packages/debug-api/src/domains/capabilities.ts", 481],
  ["packages/debug-api/src/domains/integration-browser-workflow.ts", 538],
  ["packages/debug-api/src/domains/integration.ts", 725],
  ["packages/debug-api/src/domains/package-edit-transaction.ts", 542],
  ["packages/debug-api/src/domains/render-quality-check.ts", 403],
  ["packages/debug-api/src/domains/router.test.ts", 1_488],
  ["packages/debug-api/src/domains/timeline-controls.ts", 381],
  ["packages/debug-api/src/domains/timeline-layer-create-args.ts", 416],
  ["packages/debug-api/src/domains/timeline-layers-structural.ts", 372],
  ["packages/debug-api/src/domains/workspace.ts", 514],
  ["packages/debug-server/src/cli.ts", 364],
  ["packages/debug-server/src/index.test.ts", 1_235],
  ["packages/debug-server/src/mcp-args-validation.ts", 490],
  ["packages/debug-server/src/workbench-update.ts", 569],
  ["packages/prompt/src/index.test.ts", 2_457],
  ["packages/prompt/src/index.ts", 608],
  ["packages/renderer-ffmpeg/src/index.test.ts", 3_827],
  ["packages/renderer-ffmpeg/src/index.ts", 3_776],
  ["packages/renderer-native/src/index.test.ts", 4_248]
]);

// These non-package files were intentionally governed before the package-directory defaults
// existed; retain their existing caps without widening this gate to every documentation file.
const OTHER_GOVERNED_LIMITS = new Map([
  ["skill/shellx-motion/SKILL.md", 350],
  ["skill/shellx-motion/references/cli.md", 500],
  ["scripts/template-host-parity-gate.ts", 350],
  ["scripts/render-smoke-status.ts", 350],
  ["scripts/package-corpus-validate-gate.ts", 350]
]);

function parseRoot(args) {
  if (args.length === 0) return repositoryRoot;
  if (args.length === 2 && args[0] === "--root") return resolve(args[1]);
  throw new Error("usage: node scripts/module-size-gate.mjs [--root <repository-root>]");
}

function lineCount(contents) {
  return contents.endsWith("\n") ? contents.split("\n").length - 1 : contents.split("\n").length;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareCodeUnits(left.name, right.name))
    .flatMap((entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(entryPath);
      return entry.isFile() ? [entryPath] : [];
    });
}

function packageModules(root) {
  const packagesRoot = resolve(root, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareCodeUnits(left.name, right.name))
    .flatMap((entry) => walkFiles(resolve(packagesRoot, entry.name, "src")))
    .map((file) => relative(root, file).split(sep).join("/"))
    .filter((file) => PACKAGE_MODULE.test(file));
}

function limitFor(relativePath) {
  return REVIEWED_LIMITS.get(relativePath)
    ?? LEGACY_NON_GROWTH_BASELINES.get(relativePath)
    ?? OTHER_GOVERNED_LIMITS.get(relativePath)
    ?? (TEST_MODULE.test(relativePath) ? DEFAULT_LIMITS.test : DEFAULT_LIMITS.production);
}

const root = parseRoot(process.argv.slice(2));
const governedFiles = new Set(packageModules(root));
for (const relativePath of OTHER_GOVERNED_LIMITS.keys()) {
  if (existsSync(resolve(root, relativePath))) governedFiles.add(relativePath);
}

const failures = [];
for (const relativePath of [...governedFiles].sort()) {
  const lines = lineCount(readFileSync(resolve(root, relativePath), "utf8"));
  const limit = limitFor(relativePath);
  if (lines > limit) failures.push(`${relativePath}: ${lines} lines exceeds ${limit}`);
  else console.log(`PASS ${relativePath}: ${lines}/${limit}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
