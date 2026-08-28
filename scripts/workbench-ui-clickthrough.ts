/**
 * Exhaustive human Workbench click-through.
 *
 * Every visible control on Inspector, History, Connections, Effects, Docs, and About is exercised through a real
 * Chromium page and paired with an observable result. Native file dialogs are host-owned and
 * covered separately by the exact-host picker proof; this gate injects deterministic selections
 * so it can prove every Browse button's browser wiring and post-selection state without blocking.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { motionBrowserExecutableVerificationProblem, resolveMotionBrowserExecutable } from "../packages/core/src/index";
import { startMotionDebugServer } from "../packages/debug-server/src/index";
import { createEffectModuleRegistryAuthority } from "../packages/renderer-browser/src/effect-module-registry";
import type { WorkbenchPathPickerRequest, WorkbenchPathPurpose } from "../packages/debug-server/src/workbench-path-picker";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const canonicalVersion = (JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const canonicalVersionParts = canonicalVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
assert(canonicalVersionParts, `Expected a numeric canonical version, got ${JSON.stringify(canonicalVersion)}.`);
const fixtureUpdateVersion = `${canonicalVersionParts[1]}.${canonicalVersionParts[2]}.${Number(canonicalVersionParts[3]) + 1}`;
const fixtureRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const requestedEvidenceRoot = optionValue("--out");
const profileScratchRoot = requestedEvidenceRoot ? null : await preparePrivateRepoScratch(repoRoot);
const evidenceRoot = requestedEvidenceRoot
  ? resolve(requestedEvidenceRoot)
  : join(profileScratchRoot, "workbench-ui-clickthrough", process.platform);
const capabilityToken = "ui-clickthrough-capability-token-000000000000000000000000";
const workbenchBootstrapToken = "ui-clickthrough-bootstrap-token-000000000000000000000000";
const tempRoot = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-ui-clickthrough-"));
const receiptsRoot = join(tempRoot, "receipts");
const scratchRoot = join(tempRoot, "scratch");
const renderOutput = join(tempRoot, "workbench-render.png");
const qualityManifest = join(tempRoot, "quality-manifest.json");
const receiptOutput = join(tempRoot, "existing-render.mp4");
const effectModulesRoot = join(tempRoot, "effect-modules");
const effectManifest = join(tempRoot, "afterimage-stack.json");
const pickerCalls: WorkbenchPathPickerRequest["purpose"][] = [];
const revealCalls: string[] = [];
const configuredProviders: string[] = [];
/**
 * Supplementary evidence count. The semantic inventory below is the acceptance
 * authority; this list remains useful when reading the emitted click-through
 * report, but a large count can never compensate for an unlisted control.
 */
const coverage: Array<{ page: string; control: string; outcome: string }> = [];
const semanticCoverage = new Map<string, { page: string; id: string; selector: string; outcome: string }>();
const observedSemanticControls = new Set<string>();
const browserErrors: string[] = [];
const expectedUnauthorizedErrors: string[] = [];
const unauthorizedResponses: string[] = [];
const expectedGpuHttpFailures: string[] = [];
const expectedHttpConsoleErrors: string[] = [];
const expectedReceiptStoreHttpFailures: string[] = [];
const expectedReceiptStoreConsoleErrors: string[] = [];
const pendingResponseChecks: Array<Promise<void>> = [];
let gpuProofOutcome: "passed" | "failed" | null = null;
let gpuProbeResponseDiagnostic: GpuProbeResponseDiagnostic | null = null;
let gpuUiDiagnostic: GpuUiDiagnostic | null = null;
let activePage: Page | null = null;

type GpuProbeResponseDiagnostic = Readonly<{
  method: string;
  path: string;
  command: string;
  httpStatus: number;
  bodyOk: boolean | null;
  errorCode: string;
  errorMessage: string;
  errorSuggestedAction: string;
}>;

type GpuUiDiagnostic = Readonly<{
  label: string;
  status: string;
  dataState: string;
  readinessDetail: string;
}>;

type WorkbenchPage = "Inspector" | "History" | "Connections" | "Effects" | "Docs" | "About" | "Navigation";

/**
 * Receipt discovery keeps an OS-held descriptor chain and is intentionally
 * Linux-only until equivalent no-follow primitives are available elsewhere.
 * The Workbench must render that typed refusal, rather than pretending an
 * unavailable receipt store is empty.
 */
const stableReceiptStoreSupported = process.platform === "linux";
const STABLE_RECEIPT_STORE_COMMANDS = new Set([
  "motion.receipts.list",
  "motion.receipts.panel",
  "motion.render.queue"
]);
const STABLE_RECEIPT_STORE_UNAVAILABLE = "requires Linux descriptor-relative no-follow receipt-store capability";

type SemanticControl = Readonly<{
  /** Stable report identity, scoped to the user-visible page or shared navigation. */
  page: WorkbenchPage;
  id: string;
  /** Exact DOM selector for this control or a deliberately named repeated control family. */
  selector: string;
  /** Distinguishes controls with an otherwise shared generated selector. */
  accessibleName?: string;
  /** Allows a dynamic, truthful name while preventing an unrelated control from matching. */
  accessibleNamePrefix?: string;
}>;

const semanticControl = (page: WorkbenchPage, id: string, selector: string, options: Omit<SemanticControl, "page" | "id" | "selector"> = {}): SemanticControl => ({ page, id, selector, ...options });

type WorkbenchDocsCatalog = Readonly<{
  /** Ordered page ids that the Workbench's human-only index must expose. */
  humanPageIds: readonly string[];
  /** Ordered page ids that the Workbench must keep out of its human reader. */
  agentPageIds: readonly string[];
  /** One stable semantic identity per visible human Docs navigation button. */
  navigationControls: readonly SemanticControl[];
}>;

const WORKBENCH_DOC_PAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `docs/public/index.json` is the checked-in, server-owned catalog. Keep the
 * smoke inventory derived from that same authority: adding a human guide then
 * automatically requires one visible button and one exercised outcome.
 */
function readWorkbenchDocsCatalog(index: unknown): WorkbenchDocsCatalog {
  assert(typeof index === "object" && index !== null && !Array.isArray(index), "Workbench Docs catalog must be an object.");
  const sections = (index as { sections?: unknown }).sections;
  assert(Array.isArray(sections), "Workbench Docs catalog must declare a sections array.");

  const humanPageIds: string[] = [];
  const agentPageIds: string[] = [];
  const seenPageIds = new Set<string>();
  for (const [sectionIndex, section] of sections.entries()) {
    assert(typeof section === "object" && section !== null && !Array.isArray(section), `Workbench Docs catalog section ${sectionIndex} must be an object.`);
    const pages = (section as { pages?: unknown }).pages;
    assert(Array.isArray(pages), `Workbench Docs catalog section ${sectionIndex} must declare a pages array.`);
    for (const [pageIndex, page] of pages.entries()) {
      assert(typeof page === "object" && page !== null && !Array.isArray(page), `Workbench Docs catalog page ${sectionIndex}/${pageIndex} must be an object.`);
      const { id, audience } = page as { id?: unknown; audience?: unknown };
      assert(typeof id === "string" && WORKBENCH_DOC_PAGE_ID.test(id), `Workbench Docs catalog page ${sectionIndex}/${pageIndex} needs a stable kebab-case id.`);
      assert(!seenPageIds.has(id), `Workbench Docs catalog declares duplicate page id: ${id}.`);
      assert(audience === undefined || audience === "human" || audience === "agent", `Workbench Docs catalog page ${id} has an unsupported audience.`);
      seenPageIds.add(id);
      if (audience === "agent") agentPageIds.push(id);
      else humanPageIds.push(id);
    }
  }
  assert(humanPageIds.length > 0, "Workbench Docs catalog must expose at least one human page.");
  // Template authoring remains intentionally agent-only. This is a policy
  // assertion, not a hand-maintained ledger of ordinary human documentation.
  assert(agentPageIds.includes("templates"), "Agent template reference must remain withheld from the human Workbench Docs reader.");
  return {
    humanPageIds,
    agentPageIds,
    navigationControls: humanPageIds.map((id) => semanticControl("Docs", `document-${id}`, `.docs-nav-link[data-page-id="${id}"]`))
  };
}

const workbenchDocsCatalog = readWorkbenchDocsCatalog(
  JSON.parse(await readFile(join(repoRoot, "docs", "public", "index.json"), "utf8"))
);

/**
 * The Workbench human-control contract.
 *
 * This is intentionally a selector/identity ledger, not an HTML tag count. It
 * includes controls that appear only after a package, receipt, update, or
 * effect lifecycle state is present. `Navigation` is a shared component: every
 * page is still scanned for the six links, while one verified route traversal
 * supplies the one semantic outcome for each shared link.
 */
const semanticInventory: readonly SemanticControl[] = [
  semanticControl("Navigation", "inspector", '.wb-subnav a[href="/workbench"]'),
  semanticControl("Navigation", "history", '.wb-subnav a[href="/workbench/history"]'),
  semanticControl("Navigation", "connections", '.wb-subnav a[href="/workbench/connections"]'),
  semanticControl("Navigation", "effects", '.wb-subnav a[href="/workbench/effect-modules"]'),
  semanticControl("Navigation", "docs", '.wb-subnav a[href="/workbench/docs"]'),
  semanticControl("Navigation", "about", '.wb-subnav a[href="/workbench/about"]'),

  semanticControl("Inspector", "refresh-package", "#refreshButton"),
  semanticControl("Inspector", "session", "#sessionButton"),
  semanticControl("Inspector", "open-render", "#renderButton"),
  semanticControl("Inspector", "browse-package", "#packageBrowse"),
  semanticControl("Inspector", "stage-black", '[data-stage="black"]'),
  semanticControl("Inspector", "stage-neutral", '[data-stage="neutral"]'),
  semanticControl("Inspector", "preview-browser", '[data-preview-lane="browser"]'),
  semanticControl("Inspector", "preview-gpu", '[data-preview-lane="gpu"]'),
  semanticControl("Inspector", "refresh-preview", "#previewButton"),
  semanticControl("Inspector", "playback", "#playButton"),
  semanticControl("Inspector", "scrubber", "#scrubber"),
  semanticControl("Inspector", "zoom-out", "#zoomOut"),
  semanticControl("Inspector", "zoom-in", "#zoomIn"),
  semanticControl("Inspector", "tab-inspector", '[role="tab"][data-panel="inspectorPanel"]'),
  semanticControl("Inspector", "tab-queue", '[role="tab"][data-panel="queuePanel"]'),
  semanticControl("Inspector", "tab-receipts", '[role="tab"][data-panel="receiptsPanel"]'),
  semanticControl("Inspector", "gpu-active-proof", "#gpuProofButton"),
  semanticControl("Inspector", "refresh-queue", '[data-refresh-panel="queue"]'),
  semanticControl("Inspector", "refresh-receipts", '[data-refresh-panel="receipts"]'),
  semanticControl("Inspector", "browse-receipts", "#receiptsBrowse"),
  semanticControl("Inspector", "connect-token", "#capabilityToken"),
  semanticControl("Inspector", "connect-cancel", '[data-close-dialog="connectDialog"]'),
  semanticControl("Inspector", "connect-submit", '#connectForm button[type="submit"]'),
  semanticControl("Inspector", "package-row", ".package-row"),
  semanticControl("Inspector", "timeline-label", ".timeline-label"),
  semanticControl("Inspector", "timeline-clip", ".layer-clip"),
  semanticControl("Inspector", "render-output", "#renderOutputBrowse"),
  semanticControl("Inspector", "render-frame-lane", "#renderFrameLane"),
  semanticControl("Inspector", "render-preset", "#renderPreset"),
  semanticControl("Inspector", "render-quality-manifest", "#qualityManifestBrowse"),
  semanticControl("Inspector", "render-motion-gate", "#motionGate"),
  semanticControl("Inspector", "render-cancel", "#renderCancelButton"),
  semanticControl("Inspector", "render-submit", "#renderSubmitButton"),

  semanticControl("History", "session", "#sessionButton"),
  semanticControl("History", "browse-receipts", "#receiptsBrowse"),
  semanticControl("History", "load-receipts", "#reloadButton"),
  semanticControl("History", "connect-token", "#capabilityToken"),
  semanticControl("History", "connect-cancel", '[data-close-dialog="connectDialog"]'),
  semanticControl("History", "connect-submit", '#connectForm button[type="submit"]'),
  ...(stableReceiptStoreSupported ? [
    semanticControl("History", "filter-package", "#packageFilter"),
    semanticControl("History", "filter-operation", "#operationFilter"),
    semanticControl("History", "filter-status", "#statusFilter"),
    semanticControl("History", "receipt-details", ".receipt-card button", { accessibleName: "Details" }),
    semanticControl("History", "reveal-output", '.receipt-card button[aria-label^="Open folder for"]'),
    semanticControl("History", "detail-icon-close", '[data-close-dialog="detailDialog"]', { accessibleName: "Close detail" }),
    semanticControl("History", "detail-raw-toggle", "#rawToggle"),
    semanticControl("History", "detail-close", '[data-close-dialog="detailDialog"]', { accessibleName: "Close" })
  ] : []),

  semanticControl("Docs", "session", "#sessionButton"),
  semanticControl("Docs", "connect-token", "#capabilityToken"),
  semanticControl("Docs", "connect-cancel", '[data-close-dialog="connectDialog"]'),
  semanticControl("Docs", "connect-submit", '#connectForm button[type="submit"]'),
  ...workbenchDocsCatalog.navigationControls,

  semanticControl("About", "session", "#sessionButton"),
  semanticControl("About", "check-update", "#checkButton"),
  semanticControl("About", "view-release-notes", "#updateNotes"),
  semanticControl("About", "update-options", "#applyButton"),
  semanticControl("About", "connect-token", "#capabilityToken"),
  semanticControl("About", "connect-cancel", '[data-close-dialog="connectDialog"]'),
  semanticControl("About", "connect-submit", '#connectForm button[type="submit"]'),

  semanticControl("Connections", "session", "#sessionButton"),
  semanticControl("Connections", "copy-codex", '[data-copy-provider="codex"]'),
  semanticControl("Connections", "configure-codex", '[data-configure-provider="codex"]'),
  semanticControl("Connections", "copy-claude", '[data-copy-provider="claude"]'),
  semanticControl("Connections", "configure-claude", '[data-configure-provider="claude"]'),
  semanticControl("Connections", "copy-grok", '[data-copy-provider="grok"]'),
  semanticControl("Connections", "configure-grok", '[data-configure-provider="grok"]'),
  semanticControl("Connections", "copy-generic", '[data-copy-provider="generic"]'),
  semanticControl("Connections", "copy-mcp-url", "#copyMcpUrl"),
  semanticControl("Connections", "copy-debug-url", "#copyDebugApiUrl"),
  semanticControl("Connections", "reveal-access-key", "#revealAccessKey"),
  semanticControl("Connections", "copy-access-key", "#copyAccessKey"),
  semanticControl("Connections", "connect-token", "#capabilityToken"),
  semanticControl("Connections", "connect-cancel", '[data-close-dialog="connectDialog"]'),
  semanticControl("Connections", "connect-submit", '#connectForm button[type="submit"]'),

  semanticControl("Effects", "session", "#sessionButton"),
  semanticControl("Effects", "install", "#installButton"),
  semanticControl("Effects", "refresh", "#refreshButton"),
  semanticControl("Effects", "confirm-install", "#confirmButton"),
  semanticControl("Effects", "cancel-install", "#cancelButton"),
  semanticControl("Effects", "connect-token", "#capabilityToken"),
  semanticControl("Effects", "connect-cancel", '[data-close-dialog="connectDialog"]'),
  semanticControl("Effects", "connect-submit", '#connectForm button[type="submit"]'),
  semanticControl("Effects", "inspect-installed", "#moduleList button", { accessibleName: "Inspect" }),
  semanticControl("Effects", "revoke-installed", "#moduleList button", { accessibleName: "Revoke" })
];

const inventoryKeys = new Set(semanticInventory.map((control) => semanticControlKey(control)));
assert.equal(inventoryKeys.size, semanticInventory.length, "Every semantic Workbench control needs one unique page/id identity.");
const HUMAN_CONTROL_SELECTOR = "button, input:not([type='hidden']), select, textarea, a[href], [role='button'], [role='tab'], [role='link']";

if (profileScratchRoot) await assertPrivateRepoScratchPath(repoRoot, evidenceRoot);
await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
await mkdir(effectModulesRoot, { mode: 0o700 });
await writeFile(qualityManifest, "{}\n");
await writeFile(receiptOutput, "ui click-through fixture\n");
await writeFile(effectManifest, `${JSON.stringify({
  schema: "shellx-motion/effect-module-manifest@1",
  moduleId: "motion.afterimage-stack",
  version: "1.0.0",
  displayName: "Afterimage Stack",
  intrinsic: "motion.afterimage-stack.v1",
  rendererAbi: "shellx-motion/gpu-effect-module@1",
  parameterSchema: "motion.afterimage-stack.parameters@1"
})}\n`, { mode: 0o600 });
await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify(sampleReceipt(receiptOutput), null, 2)}\n`);
const canonicalTempRoot = await realpath(tempRoot);
const canonicalReceiptsRoot = join(canonicalTempRoot, "receipts");
const canonicalRenderOutput = join(canonicalTempRoot, "workbench-render.png");
const canonicalQualityManifest = join(canonicalTempRoot, "quality-manifest.json");

const pathSelections: Record<WorkbenchPathPurpose, string> = {
  "package-root": fixtureRoot,
  "receipts-root": receiptsRoot,
  "render-output": renderOutput,
  "quality-manifest": qualityManifest
};

const server = await startMotionDebugServer({
  port: 0,
  capabilityToken,
  workbenchBootstrapToken,
  grantedTier: "write_local",
  artifactRoots: [tempRoot],
  installRoot: tempRoot,
  updateRepo: "shellx/motion",
  updateApiBaseUrl: "http://127.0.0.1:9",
  updateAllowUnsafeBase: true,
  updateAutoCheck: false,
  updateFetch: async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    text: async () => JSON.stringify({
      tag_name: `v${fixtureUpdateVersion}`,
      name: `ShellX Motion ${fixtureUpdateVersion}`,
      body: "Click-through release fixture.",
      html_url: `https://example.test/shellx-motion/releases/v${fixtureUpdateVersion}`,
      published_at: "2026-08-04T00:00:00.000Z",
      prerelease: false,
      draft: false,
      assets: []
    })
  }),
  pathPicker: async (request) => {
    pickerCalls.push(request.purpose);
    if (request.purpose === "effect-module-manifest") {
      assert.equal(request.kind, "file");
      assert.deepEqual(request.extensions, [".json"]);
      return pickerCalls.filter((purpose) => purpose === "effect-module-manifest").length === 1 ? null : effectManifest;
    }
    return pathSelections[request.purpose];
  },
  effectModulesRoot,
  effectModuleRegistryFactory: (stateRoot) => createEffectModuleRegistryAuthority({
    stateRoot,
    readManifestFileForTest: async (path) => {
      const bytes = await readFile(path);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
  }),
  revealOpener: async (target) => {
    revealCalls.push(target.path);
    return { ok: true };
  },
  connectionConfigurator: async (provider, bridge) => {
    assert.equal(bridge.command, process.execPath);
    assert(bridge.args.length === 1 && bridge.args[0].endsWith("shellx-motion-mcp.mjs"));
    configuredProviders.push(provider);
    return { provider, configured: true, alreadyConfigured: false };
  },
  context: {
    scratchRoot,
    receiptsRoot,
    qualityInputRoots: [tempRoot],
    authoringInputRoots: [repoRoot, tempRoot],
    authoringOutputRoots: [tempRoot],
    callerId: "workbench-ui-clickthrough",
    crossCallerJobScope: true
  }
});

const executablePath = browserExecutable();
const browser = await chromium.launch({
  executablePath,
  headless: optionValue("--headed") === undefined,
  args: process.platform === "linux" && isContainerLike() ? ["--no-sandbox"] : []
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url.origin });
await context.route("https://example.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Release notes</title>" }));

try {
  const page = await context.newPage();
  activePage = page;
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const error = `console: ${message.text()}`;
    if (error.includes("401 (Unauthorized)")) expectedUnauthorizedErrors.push(error);
    else if (error.includes("Failed to load resource:") && error.includes("500 (Internal Server Error)")) expectedHttpConsoleErrors.push(error);
    else if (!stableReceiptStoreSupported && error.includes("Failed to load resource:") && error.includes("503 (Service Unavailable)")) expectedReceiptStoreConsoleErrors.push(error);
    else browserErrors.push(error);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const request = response.request();
    let payload: { command?: unknown } | null = null;
    try {
      payload = request.postDataJSON() as { command?: unknown } | null;
    } catch {
      payload = null;
    }
    const command = typeof payload?.command === "string" ? payload.command : null;
    const isGpuProbe = command === "motion.platform.gpu.probe";
    if (response.status() === 401 && !isGpuProbe) {
      unauthorizedResponses.push(`${request.method()} ${url.pathname}`);
      return;
    }
    if (!isGpuProbe && response.status() < 400) return;

    const pending = (async () => {
      const body = await response.json().catch(() => null) as {
        ok?: unknown;
        error?: { code?: unknown; message?: unknown; suggestedAction?: unknown };
      } | null;
      const code = redactedDiagnosticString(body?.error?.code, 128);
      const diagnostic = `response: ${request.method()} ${url.pathname}${command ? ` (${command})` : ""}${code ? ` [${code}]` : ""} -> ${response.status()}`;
      if (isGpuProbe) {
        recordGpuProbeResponse({
          method: request.method(),
          path: url.pathname,
          command,
          httpStatus: response.status(),
          bodyOk: typeof body?.ok === "boolean" ? body.ok : null,
          errorCode: code,
          errorMessage: redactedDiagnosticString(body?.error?.message, 512),
          errorSuggestedAction: redactedDiagnosticString(body?.error?.suggestedAction, 512)
        });
      }
      if (response.status() === 401) {
        unauthorizedResponses.push(`${request.method()} ${url.pathname}`);
        return;
      }
      if (!stableReceiptStoreSupported
        && response.status() === 503
        && command !== null
        && STABLE_RECEIPT_STORE_COMMANDS.has(command)
        && code === "capability_unavailable") {
        expectedReceiptStoreHttpFailures.push(diagnostic);
        return;
      }
      if (response.status() < 400) return;
      if (isGpuProbe && response.status() === 500 && code.startsWith("gpu_")) {
        expectedGpuHttpFailures.push(diagnostic);
        return;
      }
      browserErrors.push(diagnostic);
    })();
    pendingResponseChecks.push(pending);
  });

  await exerciseInspector(page);
  await exerciseHistory(page);
  await exerciseConnections(page);
  await exerciseDocs(page);
  await exerciseAbout(page, context);
  await exerciseStartMotionBootstrap(page);
  await exerciseEffects(page);
  await exercisePrimaryNavigation(page);
  await exerciseCompactLayout(page);
  await Promise.all(pendingResponseChecks);
  assertCompleteSemanticInventory();

  assert.deepEqual(
    [...pickerCalls].sort(),
    ["effect-module-manifest", "effect-module-manifest", "effect-module-manifest", "package-root", "quality-manifest", "receipts-root", "receipts-root", "render-output"].sort(),
    "Every visible Browse button/purpose must be exercised exactly once (receipts exists on two pages; Effects proves picker cancel, UI cancel, and confirm)."
  );
  assert.equal(
    revealCalls.length,
    stableReceiptStoreSupported ? 1 : 0,
    stableReceiptStoreSupported
      ? "History Open folder must reach the injected OS opener exactly once."
      : "An unavailable receipt store must not expose a receipt artifact to open."
  );
  assert.deepEqual(configuredProviders, ["codex", "claude", "grok"], "Each one-click agent setup must reach the allowlisted configurator exactly once.");
  assert.deepEqual(
    unauthorizedResponses.sort(),
    ["GET /debug/contracts", "POST /workbench/bootstrap"].sort(),
    "Only the deliberate rejected-key and consumed-bootstrap requests may return 401."
  );
  const gpuConsistencyDiagnostic = gpuDiagnosticSummary();
  assert(gpuProofOutcome, `Active GPU proof control must report a terminal outcome.\n${gpuConsistencyDiagnostic}`);
  assert.equal(expectedGpuHttpFailures.length, gpuProofOutcome === "failed" ? 1 : 0,
    `Only a visibly fail-closed active GPU proof may retain one typed GPU HTTP failure.\n${gpuConsistencyDiagnostic}`);
  assert.equal(expectedHttpConsoleErrors.length, expectedGpuHttpFailures.length,
    `Every generic browser HTTP 500 diagnostic must correspond to the one accepted typed GPU refusal.\n${gpuConsistencyDiagnostic}`);
  if (stableReceiptStoreSupported) {
    assert.equal(expectedReceiptStoreHttpFailures.length, 0, "Linux receipt browsing must not take the unavailable-capability path.");
  } else {
    assert(expectedReceiptStoreHttpFailures.length > 0, "Unsupported receipt-store hosts must visibly receive typed capability refusals.");
    assert(expectedReceiptStoreHttpFailures.some((failure) => failure.includes("motion.receipts.panel")), "Unsupported receipt-store hosts must exercise the Inspector receipt-panel refusal.");
    assert(expectedReceiptStoreHttpFailures.some((failure) => failure.includes("motion.receipts.list")), "Unsupported receipt-store hosts must exercise the History receipt-list refusal.");
    assert(expectedReceiptStoreHttpFailures.some((failure) => failure.includes("motion.render.queue")), "Unsupported receipt-store hosts must exercise the render-queue refusal.");
    assert(expectedReceiptStoreConsoleErrors.length <= expectedReceiptStoreHttpFailures.length,
      "Every accepted receipt-store HTTP console diagnostic must correspond to a typed receipt-store refusal.");
  }
  assert.equal(browserErrors.length, 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);
  if (stableReceiptStoreSupported) {
    assert(coverage.length >= 95, `Expected at least 95 checked UI outcomes, got ${coverage.length}.`);
  }

  const report = {
    ok: true,
    command: "workbench:ui-smoke",
    platform: process.platform,
    browser: { executable: portablePathIdentity("browser-executable", executablePath), version: browser.version() },
    server: { engineVersion: canonicalVersion, pageCount: 6 },
    coverageCount: coverage.length,
    pickerCalls,
    revealCalls: revealCalls.map((path) => portablePathIdentity("revealed-local-artifact", path)),
    configuredProviders,
    expectedUnauthorizedErrors,
    unauthorizedResponses,
    gpuProofOutcome,
    gpuProbeResponseDiagnostic,
    gpuUiDiagnostic,
    expectedGpuHttpFailures,
    expectedHttpConsoleErrors,
    receiptStore: {
      supported: stableReceiptStoreSupported,
      expectedHttpFailures: expectedReceiptStoreHttpFailures,
      expectedConsoleErrors: expectedReceiptStoreConsoleErrors
    },
    browserErrors,
    screenshots: ["inspector.png", "history.png", "connections.png", "docs.png", "about.png", "effects.png", "compact-connections.png", "compact-effects.png", "compact-docs.png", "compact-about.png"],
    semanticInventory: semanticInventory.map((control) => ({ page: control.page, id: control.id, selector: control.selector, accessibleName: control.accessibleName, accessibleNamePrefix: control.accessibleNamePrefix })),
    semanticCoverage: [...semanticCoverage.values()],
    observedSemanticControls: [...observedSemanticControls].sort(),
    coverage
  };
  assertPortableReportPaths(report, [
    tempRoot,
    fixtureRoot,
    receiptsRoot,
    scratchRoot,
    renderOutput,
    qualityManifest,
    receiptOutput,
    effectModulesRoot,
    effectManifest,
    executablePath,
    ...revealCalls
  ]);
  await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await Promise.all(pendingResponseChecks).catch(() => undefined);
  await writeFailureEvidence(error, activePage).catch(() => undefined);
  throw error;
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}

async function exerciseInspector(page: Page): Promise<void> {
  await page.goto(new URL("/workbench", server.url).href, { waitUntil: "domcontentloaded" });
  await page.locator("#connectDialog").waitFor({ state: "visible" });
  await assertVisibleSemanticControls(page, "Inspector", "initial connect dialog");
  await click(page, "Inspector", "Connect dialog Cancel", page.locator('[data-close-dialog="connectDialog"]'), async () => {
    await assertDialogClosed(page, "#connectDialog");
  });
  await click(page, "Inspector", "Connect button opens dialog", page.locator("#sessionButton"), async () => {
    await page.locator("#connectDialog").waitFor({ state: "visible" });
  });
  await page.locator("#capabilityToken").fill("wrong-access-key-000000000000000000000000");
  await click(page, "Inspector", "Rejected key reports error", page.locator('#connectForm button[type="submit"]'), async () => {
    await page.locator("#connectError").waitFor({ state: "visible" });
    assert((await page.locator("#connectError").textContent())?.trim());
  });
  await page.locator("#capabilityToken").fill(capabilityToken);
  await assertInputOutcome(page, "Inspector", page.locator("#capabilityToken"), capabilityToken, "accepted the valid local access key");
  await click(page, "Inspector", "Connect succeeds", page.locator('#connectForm button[type="submit"]'), async () => {
    await expectText(page.locator("#sessionButton"), "Disconnect");
    await page.locator("#connectDialog").waitFor({ state: "hidden" });
  });
  await click(page, "Inspector", "Receipts tab", page.locator('[role="tab"][data-panel="receiptsPanel"]'), async () => {
    await page.locator("#receiptsPanel").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, "Inspector", "receipts panel");
  await click(page, "Inspector", "Receipts Browse selects and loads", page.locator("#receiptsBrowse"), async () => {
    await waitDataPath(page, "#receiptsRoot", canonicalReceiptsRoot);
    await expectReceiptPanelOutcome(page);
  });
  await click(page, "Inspector", "Receipts Refresh", page.locator('[data-refresh-panel="receipts"]'), async () => {
    await expectReceiptPanelOutcome(page);
  });
  await click(page, "Inspector", "Inspector tab", page.locator('[role="tab"][data-panel="inspectorPanel"]'), async () => {
    await page.locator("#inspectorPanel").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, "Inspector", "connected empty package state");

  await click(page, "Inspector", "Package Browse selects and loads", page.locator("#packageBrowse"), async () => {
    await expectText(page.locator("#packageCount"), "1");
    await page.locator("#previewImage").waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await dataPath(page, "#packageRoot"), fixtureRoot);
  });
  await assertVisibleSemanticControls(page, "Inspector", "loaded package and timeline");
  await click(page, "Inspector", "Package row reloads package", page.locator(".package-row").first(), async () => {
    await expectText(page.locator("#statusMessage"), "Ready");
  });
  await click(page, "Inspector", "Timeline label selects layer", page.locator(".timeline-label").first(), async () => {
    assert.notEqual((await page.locator("#selectionName").textContent())?.trim(), "Lower Third");
  });
  await click(page, "Inspector", "Timeline clip selects layer", page.locator(".layer-clip").first(), async () => {
    assert(await page.locator(".timeline-row.selected").count() >= 1);
  });
  await click(page, "Inspector", "Neutral preview stage", page.locator('[data-stage="neutral"]'), async () => {
    assert.equal(await page.locator("#previewStage").getAttribute("data-background"), "neutral");
  });
  await click(page, "Inspector", "Black preview stage", page.locator('[data-stage="black"]'), async () => {
    assert.equal(await page.locator("#previewStage").getAttribute("data-background"), "black");
  });
  await click(page, "Inspector", "Refresh package state", page.locator("#refreshButton"), async () => {
    await expectText(page.locator("#statusMessage"), "Ready");
  });
  await click(page, "Inspector", "Refresh preview frame", page.locator("#previewButton"), async () => {
    await expectText(page.locator("#statusMessage"), "Preview ready");
  });
  await click(page, "Inspector", "Strict GPU preview lane", page.locator('[data-preview-lane="gpu"]'), async () => {
    assert.equal(await page.locator('[data-preview-lane="gpu"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-preview-lane="browser"]').getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#previewRegion").getAttribute("aria-label"), "Strict GPU preview monitor");
    await expectText(page.locator("#statusMessage"), "Strict GPU preview selected");
    await expectGpuReadinessSettled(page, "source-only GPU readiness");
  });
  await click(page, "Inspector", "Run active GPU proof", page.locator("#gpuProofButton"), async () => {
    gpuProofOutcome = await expectGpuProofOutcome(page);
  });
  await click(page, "Inspector", "Browser preview lane", page.locator('[data-preview-lane="browser"]'), async () => {
    assert.equal(await page.locator('[data-preview-lane="browser"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-preview-lane="gpu"]').getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#previewRegion").getAttribute("aria-label"), "Browser preview monitor");
    await expectText(page.locator("#statusMessage"), "Browser preview selected");
  });
  await click(page, "Inspector", "Play timeline", page.locator("#playButton"), async () => {
    assert.equal(await page.locator("#playButton").getAttribute("aria-label"), "Pause");
  });
  await page.waitForTimeout(180);
  await click(page, "Inspector", "Pause timeline", page.locator("#playButton"), async () => {
    assert.equal(await page.locator("#playButton").getAttribute("aria-label"), "Play");
  });
  const scrubber = page.locator("#scrubber");
  await scrubber.evaluate((element: HTMLInputElement) => {
    element.value = String(Math.max(1, Math.round(Number(element.max) / 2)));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expectText(page.locator("#statusMessage"), "Preview ready", 60_000);
  record("Inspector", "Timeline scrubber", "playhead changed and preview refreshed");
  await recordSemanticOutcome(page, "Inspector", scrubber, "playhead changed and preview refreshed");
  await click(page, "Inspector", "Zoom in", page.locator("#zoomIn"), async () => {
    assert.equal((await page.locator("#zoomValue").textContent())?.trim(), "125%");
  });
  await click(page, "Inspector", "Zoom out", page.locator("#zoomOut"), async () => {
    assert.equal((await page.locator("#zoomValue").textContent())?.trim(), "100%");
  });

  await click(page, "Inspector", "Queue tab", page.locator('[role="tab"][data-panel="queuePanel"]'), async () => {
    await page.locator("#queuePanel").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, "Inspector", "queue panel");
  await click(page, "Inspector", "Queue Refresh", page.locator('[data-refresh-panel="queue"]'), async () => {
    if (stableReceiptStoreSupported) await page.locator("#queueList").waitFor();
    else await expectText(page.locator("#queueList"), STABLE_RECEIPT_STORE_UNAVAILABLE);
  });
  await click(page, "Inspector", "Render opens dialog", page.locator("#renderButton"), async () => {
    await page.locator("#renderDialog").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, "Inspector", "render dialog");
  const pngFramePreset = page.locator('#renderPreset option[value="png-frame"]');
  await page.locator("#renderFrameLane").selectOption("gpu");
  assert.equal(await page.locator("#renderFrameLane").inputValue(), "gpu");
  await recordSemanticOutcome(page, "Inspector", page.locator("#renderFrameLane"), "selected strict GPU final frame lane and showed its guards");
  await page.locator("#gpuFinalContract").waitFor({ state: "visible" });
  await page.locator("#renderGpuReadiness").waitFor({ state: "visible" });
  assert(await page.locator("#qualityManifestBrowse").isDisabled());
  assert(await pngFramePreset.evaluate((option: HTMLOptionElement) => option.disabled));
  record("Inspector", "GPU strict final frame lane", "strict-video guard, readiness, and manifest refusal are visible");
  await page.locator("#renderFrameLane").selectOption("browser");
  assert.equal(await page.locator("#renderFrameLane").inputValue(), "browser");
  await page.locator("#gpuFinalContract").waitFor({ state: "hidden" });
  await page.locator("#renderGpuReadiness").waitFor({ state: "hidden" });
  assert(await page.locator("#qualityManifestBrowse").isEnabled());
  assert(!await pngFramePreset.evaluate((option: HTMLOptionElement) => option.disabled));
  record("Inspector", "Browser final frame lane", "GPU-only guards clear and standard controls return");
  await click(page, "Inspector", "Render output Browse", page.locator("#renderOutputBrowse"), async () => {
    await waitDataPath(page, "#renderOutputPath", canonicalRenderOutput);
  });
  await click(page, "Inspector", "Quality manifest Browse", page.locator("#qualityManifestBrowse"), async () => {
    await waitDataPath(page, "#qualityManifestPath", canonicalQualityManifest);
  });
  for (const [value, extension] of [["webm-vp9", ".webm"], ["gif", ".gif"], ["mp4-h264", ".mp4"], ["png-frame", ".png"]] as const) {
    await page.locator("#renderPreset").selectOption(value);
    assert((await dataPath(page, "#renderOutputPath")).endsWith(extension));
    record("Inspector", `Render preset ${value}`, `output extension ${extension}`);
  }
  await recordSemanticOutcome(page, "Inspector", page.locator("#renderPreset"), "changed every render preset and derived its output extension");
  await page.locator("#renderPreset").selectOption("mp4-h264");
  await page.locator("#motionGate").check();
  assert(await page.locator("#motionGate").isChecked());
  await page.locator("#motionGate").uncheck();
  assert(!await page.locator("#motionGate").isChecked());
  record("Inspector", "Motion gate checkbox", "checked and unchecked");
  await recordSemanticOutcome(page, "Inspector", page.locator("#motionGate"), "checked and unchecked the frame-to-frame motion requirement");
  await click(page, "Inspector", "Render Cancel", page.locator("#renderCancelButton"), async () => {
    await assertDialogClosed(page, "#renderDialog");
  });

  await click(page, "Inspector", "Render reopens", page.locator("#renderButton"), async () => {
    await page.locator("#renderDialog").waitFor({ state: "visible" });
  });
  await page.locator("#renderPreset").selectOption("png-frame");
  await page.locator("#qualityManifestPath").evaluate((element) => {
    element.dataset.path = "";
    element.dataset.empty = "true";
    element.textContent = "None selected";
  });
  await click(page, "Inspector", "Start PNG render", page.locator("#renderSubmitButton"), async () => {
    await page.locator("#renderDialog").waitFor({ state: "hidden", timeout: 90_000 });
    await expectText(page.locator("#statusMessage"), "Final render completed", 90_000);
    await stat(renderOutput);
  });
  await click(page, "Inspector", "Disconnect", page.locator("#sessionButton"), async () => {
    await expectText(page.locator("#sessionButton"), "Connect");
  });
  await click(page, "Inspector", "Connect after disconnect", page.locator("#sessionButton"), async () => {
    await page.locator("#connectDialog").waitFor({ state: "visible" });
  });
  await page.locator("#capabilityToken").fill(capabilityToken);
  await click(page, "Inspector", "Reconnect", page.locator('#connectForm button[type="submit"]'), async () => {
    await expectText(page.locator("#sessionButton"), "Disconnect");
    await page.locator("#connectDialog").waitFor({ state: "hidden" });
  });
  await page.locator("#stageProgress").waitFor({ state: "hidden", timeout: 60_000 });
  await page.locator("#previewImage").waitFor({ state: "visible", timeout: 60_000 });
  await page.screenshot({ path: join(evidenceRoot, "inspector.png"), fullPage: true });
}

async function expectReceiptPanelOutcome(page: Page): Promise<void> {
  if (stableReceiptStoreSupported) {
    await expectText(page.locator("#receiptsSummary"), "1 of 1");
    return;
  }
  await expectText(page.locator("#receiptList"), STABLE_RECEIPT_STORE_UNAVAILABLE);
  assert.equal((await page.locator("#receiptsSummary").textContent())?.trim(), "", "An unavailable receipt store must not be rendered as an empty receipt count.");
}

async function expectReceiptHistoryUnavailable(page: Page): Promise<void> {
  await expectText(page.locator("#timeline"), "Could not load receipts");
  await expectText(page.locator("#statusMessage"), STABLE_RECEIPT_STORE_UNAVAILABLE);
  assert.equal((await page.locator("#shownCount").textContent())?.trim(), "0", "An unavailable receipt store must not be rendered as an empty history result.");
}

async function exerciseHistory(page: Page): Promise<void> {
  await page.goto(new URL("/workbench/history", server.url).href, { waitUntil: "domcontentloaded" });
  await expectText(page.locator("#sessionButton"), "Disconnect");
  const reloadButton = page.locator("#reloadButton");
  const readyDeadline = Date.now() + 30_000;
  while (!await reloadButton.isEnabled() && Date.now() < readyDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert(await reloadButton.isEnabled(), "History did not finish its initial receipt load before Browse.");
  await assertVisibleSemanticControls(page, "History", "connected receipt history");
  // History auto-loads the host receipt root on connection. The Browse picker can therefore select
  // the same root, and waiting only for an already-visible receipt card races the second load. Arm
  // the disabled transition before clicking so this gate proves the picker-triggered load itself.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("#reloadButton");
    if (!button) throw new Error("History reload button is unavailable.");
    Reflect.set(globalThis, "__shellxHistoryReloadDisabled", new Promise<void>((resolvePromise, rejectPromise) => {
      const observer = new MutationObserver(() => {
        if (!button.disabled) return;
        observer.disconnect();
        resolvePromise();
      });
      observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
      window.setTimeout(() => {
        observer.disconnect();
        rejectPromise(new Error("History Browse did not start a receipt reload."));
      }, 30_000);
    }));
  });
  await click(page, "History", "Receipts Browse selects and loads", page.locator("#receiptsBrowse"), async () => {
    await page.evaluate(() => Reflect.get(globalThis, "__shellxHistoryReloadDisabled"));
    await waitDataPath(page, "#receiptsRoot", canonicalReceiptsRoot);
    const loadedDeadline = Date.now() + 30_000;
    while (!await reloadButton.isEnabled() && Date.now() < loadedDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert(await reloadButton.isEnabled(), "History Browse-triggered receipt load did not finish.");
    if (stableReceiptStoreSupported) await page.locator(".receipt-card").first().waitFor({ state: "visible" });
    else await expectReceiptHistoryUnavailable(page);
  });
  await click(page, "History", "Load receipts", reloadButton, async () => {
    if (stableReceiptStoreSupported) {
      await expectText(page.locator("#statusMessage"), "receipts loaded");
      assert(Number((await page.locator("#shownCount").textContent())?.trim()) >= 2);
    } else {
      await expectReceiptHistoryUnavailable(page);
    }
  });
  if (!stableReceiptStoreSupported) {
    await disconnectAndReconnect(page, "History");
    await page.screenshot({ path: join(evidenceRoot, "history.png"), fullPage: true });
    return;
  }
  await assertVisibleSemanticControls(page, "History", "loaded receipt cards");
  await page.locator("#packageFilter").selectOption("pkg_ui_clickthrough");
  assert.equal((await page.locator(".receipt-card").count()), 1);
  record("History", "Package filter", "matching card remains");
  await recordSemanticOutcome(page, "History", page.locator("#packageFilter"), "filtered to the fixture package");
  await page.locator("#operationFilter").selectOption("render.final");
  assert.equal((await page.locator(".receipt-card").count()), 1);
  record("History", "Operation filter", "matching card remains");
  await recordSemanticOutcome(page, "History", page.locator("#operationFilter"), "filtered to the final-render operation");
  await page.locator("#statusFilter").selectOption("failed");
  await expectText(page.locator("#shownCount"), "0");
  record("History", "Result filter", "non-matching state shows zero");
  await recordSemanticOutcome(page, "History", page.locator("#statusFilter"), "filtered to a visibly empty failed-result state");
  await page.locator("#statusFilter").selectOption("");
  await page.locator("#packageFilter").selectOption("pkg_ui_clickthrough");
  await page.locator("#operationFilter").selectOption("");

  await click(page, "History", "Details", page.getByRole("button", { name: "Details" }), async () => {
    await page.locator("#detailDialog").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, "History", "receipt detail dialog");
  await click(page, "History", "Show raw JSON", page.locator("#rawToggle"), async () => {
    await page.locator(".json-block").waitFor({ state: "visible" });
  });
  await click(page, "History", "Show structured view", page.locator("#rawToggle"), async () => {
    await page.locator(".kv-table").first().waitFor({ state: "visible" });
  });
  const detailFooterClose = page.getByRole("button", { name: "Close", exact: true });
  const detailIconClose = page.locator('[data-close-dialog="detailDialog"][aria-label="Close detail"]');
  assert.equal(await detailFooterClose.count(), 1, "History must expose exactly one accessible footer Close control.");
  assert.equal(await detailIconClose.count(), 1, "History must expose exactly one accessible icon Close detail control.");
  await click(page, "History", "Detail Close", detailFooterClose, async () => {
    await assertDialogClosed(page, "#detailDialog");
  });
  await page.getByRole("button", { name: "Details" }).click();
  await click(page, "History", "Detail icon close", detailIconClose, async () => {
    await assertDialogClosed(page, "#detailDialog");
  });
  await click(page, "History", "Open containing folder", page.getByRole("button", { name: /Open folder for/ }), async () => {
    await expectText(page.locator("#toast"), "Opened the containing folder");
  });
  await disconnectAndReconnect(page, "History");
  await page.screenshot({ path: join(evidenceRoot, "history.png"), fullPage: true });
}

async function exerciseDocs(page: Page): Promise<void> {
  await page.goto(new URL("/workbench/docs", server.url).href, { waitUntil: "domcontentloaded" });
  await expectText(page.locator("#sessionButton"), "Disconnect");
  await page.locator(".docs-nav-link").first().waitFor({ state: "visible" });
  await assertVisibleSemanticControls(page, "Docs", "loaded documentation navigation");
  const pageIds = await page.locator(".docs-nav-link").evaluateAll((links) => links.map((link) => (link as HTMLElement).dataset.pageId));
  assert.deepEqual(pageIds, workbenchDocsCatalog.humanPageIds, "Workbench Docs navigation must exactly mirror the checked-in human catalog.");
  for (const pageId of workbenchDocsCatalog.agentPageIds) {
    assert(!pageIds.includes(pageId), `Agent-only documentation page ${pageId} leaked into the human Docs reader.`);
    const response = await page.request.get(new URL(`/workbench/docs/page?id=${encodeURIComponent(pageId)}`, server.url).href, {
      headers: { authorization: `Bearer ${capabilityToken}` }
    });
    assert.equal(response.status(), 404, `Agent-only documentation page ${pageId} must remain refused by the human Docs endpoint.`);
  }
  for (const pageId of pageIds) {
    assert(pageId);
    const link = page.locator(`.docs-nav-link[data-page-id="${pageId}"]`);
    await link.click();
    await page.locator(`.docs-nav-link[data-page-id="${pageId}"][aria-current="page"]`).waitFor();
    await page.locator("#docsContent h1").waitFor({ state: "visible" });
    record("Docs", `Documentation page ${pageId}`, "selected and rendered markdown");
    await recordSemanticOutcome(page, "Docs", link, `selected documentation page ${pageId} and rendered its markdown`);
  }
  await page.locator('.docs-nav-link[data-page-id="quickstart"]').click();
  const renderingAnchor = page.locator('#docsContent a[data-doc-page-id="rendering"][data-doc-anchor="choosing-a-lane"]');
  await renderingAnchor.waitFor({ state: "visible" });
  assert.equal(await renderingAnchor.count(), 1, "Quickstart must expose exactly one index-backed Rendering lane anchor.");
  await renderingAnchor.click();
  await page.locator('.docs-nav-link[data-page-id="rendering"][aria-current="page"]').waitFor();
  await page.locator('#docsContent [id="choosing-a-lane"]').waitFor({ state: "visible" });
  record("Docs", "Indexed relative document anchor", "opened Rendering lanes inside the authenticated reader at #choosing-a-lane");

  await page.locator('.docs-nav-link[data-page-id="host-integration"]').click();
  const samePageAnchor = page.locator('#docsContent a[data-doc-page-id="host-integration"][data-doc-anchor="1a-asking-what-a-job-is-doing-right-now"]');
  await samePageAnchor.waitFor({ state: "visible" });
  assert.equal(await samePageAnchor.count(), 1, "Host integration must expose exactly one bounded same-page Docs anchor.");
  await samePageAnchor.click();
  await page.locator('#docsContent [id="1a-asking-what-a-job-is-doing-right-now"]').waitFor({ state: "visible" });
  record("Docs", "Indexed same-page anchor", "scrolled within the authenticated reader without browser URL navigation");
  await disconnectAndReconnect(page, "Docs");
  await page.screenshot({ path: join(evidenceRoot, "docs.png"), fullPage: true });
}

async function exerciseConnections(page: Page): Promise<void> {
  await page.goto(new URL("/workbench/connections", server.url).href, { waitUntil: "domcontentloaded" });
  await expectText(page.locator("#sessionButton"), "Disconnect");
  await expectText(page.locator("#connectionBadgeLabel"), "Motion is ready");
  await expectText(page.locator("#codexCommand"), "codex mcp add shellx-motion");
  await expectText(page.locator("#claudeCommand"), "claude mcp add --scope user shellx-motion");
  await expectText(page.locator("#grokCommand"), "grok mcp add --scope user shellx-motion");
  await expectText(page.locator("#genericCommand"), "shellx-motion-mcp");
  await assertVisibleSemanticControls(page, "Connections", "connected provider and address controls");
  const displayedCommands = await page.locator(".setup-command").allTextContents();
  assert(displayedCommands.every((command) => !/shellx-motion-mcp\.mjs|[A-Za-z]:[\\/]|\/(?:home|Users|private|tmp|var|opt|usr|Applications|Volumes|mnt)\//.test(command)));
  record("Connections", "Connection state", "same-key addresses and provider commands loaded");

  for (const provider of ["codex", "claude", "grok"] as const) {
    await click(page, "Connections", `Copy ${provider} command`, page.locator(`[data-copy-provider="${provider}"]`), async () => {
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert(copied.includes(`${provider} mcp add`));
      await expectText(page.locator("#toast"), "copied");
    });
    await click(page, "Connections", `Configure ${provider}`, page.locator(`[data-configure-provider="${provider}"]`), async () => {
      await expectText(page.locator("#toast"), "is connected");
      await expectText(page.locator(`[data-configure-provider="${provider}"]`), "Configured");
    });
  }
  await click(page, "Connections", "Copy generic MCP command", page.locator('[data-copy-provider="generic"]'), async () => {
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, "shellx-motion-mcp");
    assert(!copied.includes("mcp add"));
  });

  await click(page, "Connections", "Copy MCP address", page.locator("#copyMcpUrl"), async () => {
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), new URL("/rpc", server.url).toString());
  });
  await click(page, "Connections", "Copy Debug API address", page.locator("#copyDebugApiUrl"), async () => {
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), new URL("/debug", server.url).toString());
  });
  await click(page, "Connections", "Reveal local access key", page.locator("#revealAccessKey"), async () => {
    assert.equal((await page.locator("#accessKey").textContent())?.trim(), capabilityToken);
    await expectText(page.locator("#revealAccessKey"), "Hide");
  });
  await click(page, "Connections", "Copy local access key", page.locator("#copyAccessKey"), async () => {
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), capabilityToken);
  });
  await click(page, "Connections", "Hide local access key", page.locator("#revealAccessKey"), async () => {
    assert.notEqual((await page.locator("#accessKey").textContent())?.trim(), capabilityToken);
    await expectText(page.locator("#revealAccessKey"), "Reveal");
  });
  await disconnectAndReconnect(page, "Connections");
  await page.screenshot({ path: join(evidenceRoot, "connections.png"), fullPage: true });
}

async function exerciseAbout(page: Page, browserContext: BrowserContext): Promise<void> {
  await page.goto(new URL("/workbench/about", server.url).href, { waitUntil: "domcontentloaded" });
  await expectText(page.locator("#sessionButton"), "Disconnect");
  await expectText(page.locator("#engineVersion"), canonicalVersion);
  await assertVisibleSemanticControls(page, "About", "connected update state");
  await click(page, "About", "Check now", page.locator("#checkButton"), async () => {
    await expectText(page.locator("#updateBadgeLabel"), "update available");
    await page.locator("#applyButton").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, "About", "update available");
  const popupPromise = browserContext.waitForEvent("page");
  const releaseNotes = page.locator("#updateNotes");
  await releaseNotes.click();
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.hostname === "example.test");
  assert.equal(new URL(popup.url()).hostname, "example.test");
  await popup.close();
  record("About", "View release notes", "opened validated release URL in a new tab");
  await recordSemanticOutcome(page, "About", releaseNotes, "opened the validated release URL in a new tab");
  await click(page, "About", "Update options", page.locator("#applyButton"), async () => {
    await expectText(page.locator("#updateBadgeLabel"), "manual update");
  });
  await disconnectAndReconnect(page, "About");
  await page.screenshot({ path: join(evidenceRoot, "about.png"), fullPage: true });
}

async function exerciseEffects(page: Page): Promise<void> {
  await page.goto(new URL("/workbench/effect-modules", server.url).href, { waitUntil: "domcontentloaded" });
  await page.locator("#connectDialog").waitFor({ state: "visible" });
  await assertVisibleSemanticControls(page, "Effects", "initial connect dialog");
  await click(page, "Effects", "Connect dialog Cancel", page.locator('[data-close-dialog="connectDialog"]'), async () => {
    await assertDialogClosed(page, "#connectDialog");
  });
  await click(page, "Effects", "Connect button opens dialog", page.locator("#sessionButton"), async () => {
    await page.locator("#connectDialog").waitFor({ state: "visible" });
  });
  await page.locator("#capabilityToken").fill(capabilityToken);
  await assertInputOutcome(page, "Effects", page.locator("#capabilityToken"), capabilityToken, "accepted the local operator access key");
  await click(page, "Effects", "Connect succeeds", page.locator('#connectForm button[type="submit"]'), async () => {
    await expectText(page.locator("#sessionButton"), "Disconnect");
    await page.locator("#connectDialog").waitFor({ state: "hidden" });
    await expectText(page.locator("#moduleList"), "No local effects are installed.");
  });
  await assertVisibleSemanticControls(page, "Effects", "connected empty registry");
  await click(page, "Effects", "Refresh empty registry", page.locator("#refreshButton"), async () => {
    await expectText(page.locator("#statusMessage"), "Installed local effects loaded.");
    await expectText(page.locator("#moduleList"), "No local effects are installed.");
  });
  await click(page, "Effects", "Install picker cancellation", page.locator("#installButton"), async () => {
    await expectText(page.locator("#statusMessage"), "Installation cancelled.");
    await page.locator("#pendingPanel").waitFor({ state: "hidden" });
  });
  await click(page, "Effects", "Install opens confirmation", page.locator("#installButton"), async () => {
    await page.locator("#pendingPanel").waitFor({ state: "visible" });
    await expectText(page.locator("#pendingSummary"), "Afterimage Stack 1.0.0");
  });
  await assertVisibleSemanticControls(page, "Effects", "frozen installation confirmation");
  await click(page, "Effects", "Cancel frozen installation", page.locator("#cancelButton"), async () => {
    await page.locator("#pendingPanel").waitFor({ state: "hidden" });
    await expectText(page.locator("#statusMessage"), "Installation cancelled.");
  });
  await click(page, "Effects", "Install reopens confirmation", page.locator("#installButton"), async () => {
    await page.locator("#pendingPanel").waitFor({ state: "visible" });
    await expectText(page.locator("#pendingSummary"), "Afterimage Stack 1.0.0");
  });
  await click(page, "Effects", "Confirm installation", page.locator("#confirmButton"), async () => {
    await page.locator("#pendingPanel").waitFor({ state: "hidden" });
    await expectText(page.locator("#statusMessage"), "Local effect installed.");
    await expectText(page.locator("#moduleList"), "Afterimage Stack");
    const visibleCopy = await page.locator(".er-page").textContent();
    assert(!visibleCopy?.includes(tempRoot), "Effects must not disclose the host-only registry or manifest path.");
    assert(!visibleCopy?.includes(effectManifest), "Effects must not disclose the selected manifest path.");
  });
  await assertVisibleSemanticControls(page, "Effects", "installed module controls");
  await click(page, "Effects", "Inspect installed module", page.getByRole("button", { name: "Inspect", exact: true }), async () => {
    await page.locator("#detailPanel").waitFor({ state: "visible" });
    await expectText(page.locator("#detailList"), "motion.afterimage-stack");
    const detailCopy = await page.locator("#detailList").textContent();
    assert(!detailCopy?.includes(tempRoot), "Effect details must not disclose host paths.");
  });
  const revokeInstalledModule = page.locator("#moduleList").getByRole("button", { name: "Revoke", exact: true });
  assert.equal(await revokeInstalledModule.count(), 1, "The installed module must expose exactly one accessible Revoke control.");
  await click(page, "Effects", "Revoke installed module", revokeInstalledModule, async () => {
    await expectText(page.locator("#statusMessage"), "Local effect revoked.");
    await expectText(page.locator("#moduleList"), "Revoked");
    assert.equal(await page.getByRole("button", { name: "Revoke", exact: true }).count(), 0, "Revoked entries must no longer offer a second revoke action.");
  });
  await click(page, "Effects", "Refresh revoked registry", page.locator("#refreshButton"), async () => {
    await expectText(page.locator("#statusMessage"), "Installed local effects loaded.");
    await expectText(page.locator("#moduleList"), "Revoked");
  });
  await disconnectAndReconnect(page, "Effects");
  await expectText(page.locator("#moduleList"), "Revoked");
  await page.screenshot({ path: join(evidenceRoot, "effects.png"), fullPage: true });
}

async function exercisePrimaryNavigation(page: Page): Promise<void> {
  await page.goto(new URL("/workbench", server.url).href, { waitUntil: "domcontentloaded" });
  const labels = await page.locator(".wb-subnav a").allTextContents();
  assert.deepEqual(labels.map((label) => label.trim()), ["Inspector", "History", "Connections", "Effects", "Docs", "About"]);
  for (const [label, suffix] of [["History", "/workbench/history"], ["Inspector", "/workbench"], ["Connections", "/workbench/connections"], ["Effects", "/workbench/effect-modules"], ["Docs", "/workbench/docs"], ["About", "/workbench/about"]] as const) {
    const link = page.getByRole("link", { name: label, exact: true });
    await link.click();
    await page.waitForURL((url) => url.pathname === suffix);
    record("Navigation", label, `navigated to ${suffix}`);
    await recordSemanticOutcome(page, "Navigation", link, `navigated to ${suffix}`);
  }
}

async function exerciseCompactLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 760, height: 900 });
  for (const [name, path, screenshot] of [
    ["Inspector", "/workbench", null],
    ["History", "/workbench/history", null],
    ["Connections", "/workbench/connections", "compact-connections.png"],
    ["Effects", "/workbench/effect-modules", "compact-effects.png"],
    ["Docs", "/workbench/docs", "compact-docs.png"],
    ["About", "/workbench/about", "compact-about.png"]
  ] as const) {
    await page.goto(new URL(path, server.url).href, { waitUntil: "domcontentloaded" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 1, `Compact ${name} layout overflows horizontally by ${overflow}px.`);
    if (screenshot) await page.screenshot({ path: join(evidenceRoot, screenshot), fullPage: true });
    record("Responsive", `Compact ${name}`, "760px layout has no horizontal overflow");
  }
}

async function exerciseStartMotionBootstrap(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(new URL("/workbench/about", server.url).href, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.clear());
  const launchUrl = new URL("/workbench", server.url);
  launchUrl.hash = new URLSearchParams({ bootstrap: workbenchBootstrapToken }).toString();
  await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
  await expectText(page.locator("#sessionButton"), "Disconnect");
  assert.equal(new URL(page.url()).hash, "", "Start Motion must clear the one-use value from the browser address.");
  assert.equal(await page.locator("#connectDialog").evaluate((dialog: HTMLDialogElement) => dialog.open), false);
  record("Onboarding", "Start Motion bootstrap", "one-use launch opened an authenticated Workbench without a prompt");

  await page.evaluate(() => sessionStorage.clear());
  await page.goto(new URL("/workbench/about", server.url).href, { waitUntil: "domcontentloaded" });
  await page.goto(launchUrl.href, { waitUntil: "domcontentloaded" });
  await page.locator("#connectDialog").waitFor({ state: "visible" });
  await expectText(page.locator("#connectError"), "already been used");
  assert.equal(new URL(page.url()).hash, "", "Consumed launch values must also be cleared from the browser address.");
  record("Onboarding", "Bootstrap replay refusal", "consumed one-use value was rejected and manual connection remained available");
}

async function disconnectAndReconnect(page: Page, pageName: string): Promise<void> {
  await click(page, pageName, "Disconnect", page.locator("#sessionButton"), async () => {
    await expectText(page.locator("#sessionButton"), "Connect");
  });
  await click(page, pageName, "Connect opens dialog", page.locator("#sessionButton"), async () => {
    await page.locator("#connectDialog").waitFor({ state: "visible" });
  });
  await assertVisibleSemanticControls(page, pageName as WorkbenchPage, "reconnect dialog");
  await click(page, pageName, "Connect dialog cancel", page.locator('[data-close-dialog="connectDialog"]'), async () => {
    await assertDialogClosed(page, "#connectDialog");
  });
  await click(page, pageName, "Connect dialog reopens after cancel", page.locator("#sessionButton"), async () => {
    await page.locator("#connectDialog").waitFor({ state: "visible" });
  });
  await page.locator("#capabilityToken").fill(capabilityToken);
  await assertInputOutcome(page, pageName as WorkbenchPage, page.locator("#capabilityToken"), capabilityToken, "accepted a manual local access key");
  await click(page, pageName, "Reconnect", page.locator('#connectForm button[type="submit"]'), async () => {
    await expectText(page.locator("#sessionButton"), "Disconnect");
    await page.locator("#connectDialog").waitFor({ state: "hidden" });
  });
  await assertVisibleSemanticControls(page, pageName as WorkbenchPage, "reconnected");
}

async function click(page: Page, pageName: string, control: string, locator: Locator, outcome: () => Promise<void>): Promise<void> {
  await locator.waitFor({ state: "visible" });
  const deadline = Date.now() + 30_000;
  while (!await locator.isEnabled() && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert(await locator.isEnabled(), `${pageName} / ${control} is disabled.`);
  // A successful action can replace the clicked element. Resolve its exact semantic identity while
  // it is still visible, then record it only after the asserted observable outcome has occurred.
  const semanticControl = await semanticControlForLocator(page, pageName as WorkbenchPage, locator);
  await locator.click();
  await outcome();
  record(pageName, control, "checked");
  recordSemanticOutcomeForControl(semanticControl, `${control}: checked outcome`);
}

function record(page: string, control: string, outcome: string): void {
  coverage.push({ page, control, outcome });
}

function semanticControlKey(control: Pick<SemanticControl, "page" | "id">): string {
  return `${control.page}:${control.id}`;
}

function describeHumanControl(element: Element): string {
  const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  const attributes = ["id", "class", "role", "href", "data-panel", "data-stage", "data-preview-lane", "data-copy-provider", "data-configure-provider", "data-close-dialog"]
    .flatMap((name) => {
      const value = element.getAttribute(name);
      return value === null ? [] : [`${name}=${JSON.stringify(value)}`];
    });
  return `<${element.tagName.toLowerCase()}${attributes.length ? ` ${attributes.join(" ")}` : ""} name=${JSON.stringify(name)}>`;
}

async function matchingSemanticControls(page: Page, pageName: WorkbenchPage, locator: Locator): Promise<SemanticControl[]> {
  const candidates = semanticInventory.filter((control) => control.page === pageName || control.page === "Navigation");
  const matches = await Promise.all(candidates.map(async (control) => {
    const matched = await locator.evaluate((element, expected) => {
      if (!element.matches(expected.selector)) return false;
      const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (expected.accessibleName !== undefined && name !== expected.accessibleName) return false;
      if (expected.accessibleNamePrefix !== undefined && !name.startsWith(expected.accessibleNamePrefix)) return false;
      return true;
    }, control).catch(() => false);
    return matched ? control : null;
  }));
  return matches.filter((control): control is SemanticControl => control !== null);
}

async function semanticControlForLocator(page: Page, pageName: WorkbenchPage, locator: Locator): Promise<SemanticControl | null> {
  const matches = await matchingSemanticControls(page, pageName, locator);
  if (matches.length === 0) {
    const human = await locator.evaluate((element, selector) => element.matches(selector), HUMAN_CONTROL_SELECTOR).catch(() => false);
    assert(!human, `${pageName} checked a human control with no semantic inventory identity.`);
    return null;
  }
  assert.equal(matches.length, 1, `${pageName} action matched multiple semantic controls: ${matches.map(semanticControlKey).join(", ")}.`);
  return matches[0];
}

function recordSemanticOutcomeForControl(control: SemanticControl | null, outcome: string): void {
  if (!control) return;
  const key = semanticControlKey(control);
  if (!semanticCoverage.has(key)) {
    semanticCoverage.set(key, { page: control.page, id: control.id, selector: control.selector, outcome });
  }
}

async function recordSemanticOutcome(page: Page, pageName: WorkbenchPage, locator: Locator, outcome: string): Promise<void> {
  recordSemanticOutcomeForControl(await semanticControlForLocator(page, pageName, locator), outcome);
}

async function assertInputOutcome(page: Page, pageName: WorkbenchPage, locator: Locator, value: string, outcome: string): Promise<void> {
  assert.equal(await locator.inputValue(), value);
  record(pageName, "Local access key", outcome);
  await recordSemanticOutcome(page, pageName, locator, outcome);
}

async function assertVisibleSemanticControls(page: Page, pageName: WorkbenchPage, checkpoint: string): Promise<void> {
  const visibleControls = page.locator(HUMAN_CONTROL_SELECTOR);
  const unlisted: string[] = [];
  const ambiguous: string[] = [];
  for (let index = 0; index < await visibleControls.count(); index += 1) {
    const locator = visibleControls.nth(index);
    if (!await locator.isVisible()) continue;
    const ignoredDocumentContent = await locator.evaluate((element) => Boolean(element.closest("#docsContent")));
    // Rendered markdown is document content, not a Workbench control. Its strict
    // renderer has its own tests; the Docs navigation still has an exact entry per page.
    if (ignoredDocumentContent) continue;
    const matches = await matchingSemanticControls(page, pageName, locator);
    const description = await locator.evaluate(describeHumanControl);
    if (matches.length === 0) unlisted.push(description);
    else if (matches.length > 1) ambiguous.push(`${description} -> ${matches.map(semanticControlKey).join(", ")}`);
    else observedSemanticControls.add(semanticControlKey(matches[0]));
  }
  assert.deepEqual(ambiguous, [], `${pageName} / ${checkpoint} has controls with more than one semantic identity.`);
  assert.deepEqual(unlisted, [], `${pageName} / ${checkpoint} exposed unlisted human controls. Add a selector identity and a checked outcome before accepting it.`);
}

function assertCompleteSemanticInventory(): void {
  const expected = semanticInventory.map(semanticControlKey).sort();
  const observed = [...observedSemanticControls].sort();
  const covered = [...semanticCoverage.keys()].sort();
  assert.deepEqual(observed, expected, `Semantic inventory entries were not visibly observed:\n${expected.filter((key) => !observed.includes(key)).join("\n")}`);
  assert.deepEqual(covered, expected, `Expected human controls lack one checked semantic outcome:\n${expected.filter((key) => !covered.includes(key)).join("\n")}`);
  assert.equal(semanticCoverage.size, semanticInventory.length, "Each expected visible control must have exactly one semantic coverage record.");
}

async function expectText(locator: Locator, text: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    const value = (await locator.textContent().catch(() => "")) ?? "";
    if (value.toLowerCase().includes(text.toLowerCase())) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() < deadline);
  throw new Error(`Expected ${await locator.evaluate((element) => element.id || element.tagName)} to contain: ${text}`);
}

function boundedDiagnosticString(value: unknown, maximumLength = 512): string {
  if (typeof value !== "string") return "";
  return value
    .replaceAll(capabilityToken, "[redacted]")
    .replaceAll(workbenchBootstrapToken, "[redacted]")
    .slice(0, maximumLength);
}

function recordGpuProbeResponse(diagnostic: GpuProbeResponseDiagnostic): void {
  // The click-through invokes the active proof once. Record only its bounded,
  // schema-shaped response rather than retaining an arbitrary response body.
  gpuProbeResponseDiagnostic = diagnostic;
}

async function captureGpuUiDiagnostic(page: Page | null): Promise<GpuUiDiagnostic | null> {
  if (!page || page.isClosed()) return null;
  const label = page.locator("#gpuReadinessLabel");
  const status = page.locator("#statusMessage");
  const readiness = page.locator("#gpuReadiness");
  const readinessDetail = page.locator("#gpuReadinessDetail");
  const [labelCount, statusCount, readinessCount, readinessDetailCount] = await Promise.all([
    label.count().catch(() => 0),
    status.count().catch(() => 0),
    readiness.count().catch(() => 0),
    readinessDetail.count().catch(() => 0)
  ]);
  if (labelCount === 0 && statusCount === 0 && readinessCount === 0 && readinessDetailCount === 0) return null;
  const [labelText, statusText, dataState, readinessDetailText] = await Promise.all([
    label.textContent().catch(() => ""),
    status.textContent().catch(() => ""),
    readiness.getAttribute("data-state").catch(() => ""),
    readinessDetail.textContent().catch(() => "")
  ]);
  return {
    label: redactedDiagnosticString(labelText, 512),
    status: redactedDiagnosticString(statusText, 512),
    dataState: redactedDiagnosticString(dataState, 128),
    // This is where an active-proof validator reports its caught cause. It remains redacted and
    // bounded so a failed smoke test retains the useful error without retaining arbitrary page text.
    readinessDetail: redactedDiagnosticString(readinessDetailText, 2048)
  };
}

function gpuDiagnosticSummary(): string {
  return JSON.stringify({
    gpuProofOutcome,
    gpuProbeResponseDiagnostic,
    gpuUiDiagnostic
  }, null, 2);
}

function redactedDiagnosticString(value: unknown, maximumLength: number): string {
  return boundedDiagnosticString(value, maximumLength)
    .replace(/(?:[A-Za-z]:[\\/]|https?:\/\/|\/)[^\s"')]+/g, "[redacted-path]");
}

/**
 * Preserve enough path context to diagnose a Workbench smoke result without
 * retaining a machine-specific path in a portable evidence archive. Do not hash
 * the source path: a stable-looking digest would still be an unnecessary machine
 * identity and is less useful to a human than the explicit redaction marker.
 */
function portablePathIdentity(purpose: string, path: string): { purpose: string; basename: string; identity: string } {
  const basename = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "[redacted]";
  return {
    purpose,
    basename: boundedDiagnosticString(basename, 160),
    identity: `[redacted:${purpose}]`
  };
}

/** Ensure the retained report cannot accidentally recover a literal fixture or host path. */
function assertPortableReportPaths(report: unknown, privatePaths: readonly string[]): void {
  const serialized = JSON.stringify(report);
  for (const path of privatePaths) {
    if (path && serialized.includes(path)) {
      throw new Error(`Portable Workbench evidence retained a literal machine path for ${portablePathIdentity("path", path).basename}.`);
    }
  }
}

function gpuDiagnosticForFailure(diagnostic: GpuProbeResponseDiagnostic | null): Omit<GpuProbeResponseDiagnostic, "path"> | null {
  if (!diagnostic) return null;
  const { path: _path, ...redacted } = diagnostic;
  return redacted;
}

async function writeFailureEvidence(error: unknown, page: Page | null): Promise<void> {
  const currentUiDiagnostic = await captureGpuUiDiagnostic(page);
  if (currentUiDiagnostic) gpuUiDiagnostic = currentUiDiagnostic;
  const failure = {
    ok: false,
    command: "workbench:ui-smoke",
    error: error instanceof Error
      ? { name: boundedDiagnosticString(error.name, 128), message: redactedDiagnosticString(error.message, 2048) }
      : { name: "Error", message: redactedDiagnosticString(String(error), 2048) },
    gpu: {
      proofOutcome: gpuProofOutcome,
      probeResponse: gpuDiagnosticForFailure(gpuProbeResponseDiagnostic),
      ui: gpuUiDiagnostic
    },
    counts: {
      coverage: coverage.length,
      semanticCoverage: semanticCoverage.size,
      observedSemanticControls: observedSemanticControls.size,
      pendingResponseChecks: pendingResponseChecks.length,
      expectedGpuHttpFailures: expectedGpuHttpFailures.length,
      expectedHttpConsoleErrors: expectedHttpConsoleErrors.length,
      browserErrors: browserErrors.length
    },
    errorCounts: {
      browserErrors: browserErrors.length,
      expectedGpuHttpFailures: expectedGpuHttpFailures.length,
      expectedHttpConsoleErrors: expectedHttpConsoleErrors.length,
      unauthorizedResponses: unauthorizedResponses.length,
      expectedUnauthorizedErrors: expectedUnauthorizedErrors.length
    }
  };
  // A failure may happen before an explicit --out directory exists. Preserve
  // its bounded diagnostics before the surrounding finally removes temp state.
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(evidenceRoot, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
}

async function expectGpuReadinessSettled(page: Page, context: string): Promise<void> {
  const label = page.locator("#gpuReadinessLabel");
  const deadline = Date.now() + 30_000;
  do {
    const value = (await label.textContent())?.trim() ?? "";
    if (value && !value.startsWith("Checking GPU")) {
      assert.notEqual(await page.locator("#gpuReadiness").getAttribute("data-state"), "checking");
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() < deadline);
  throw new Error(`${context} did not settle.`);
}

async function expectGpuProofOutcome(page: Page): Promise<"passed" | "failed"> {
  try {
    const label = page.locator("#gpuReadinessLabel");
    const deadline = Date.now() + 90_000;
    do {
      const value = (await label.textContent())?.trim() ?? "";
      if (value === "GPU hardware proof passed." || value === "GPU hardware proof did not pass.") {
        await expectText(page.locator("#statusMessage"), value);
        assert.notEqual(await page.locator("#gpuReadiness").getAttribute("data-state"), "checking");
        return value === "GPU hardware proof passed." ? "passed" : "failed";
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } while (Date.now() < deadline);
    throw new Error("Active GPU proof did not report either a verified proof or its explicit fail-closed outcome.");
  } finally {
    const diagnostic = await captureGpuUiDiagnostic(page);
    if (diagnostic) gpuUiDiagnostic = diagnostic;
  }
}

async function assertDialogClosed(page: Page, selector: string): Promise<void> {
  assert.equal(await page.locator(selector).evaluate((dialog: HTMLDialogElement) => dialog.open), false);
}

async function dataPath(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((element: HTMLElement) => element.dataset.path ?? "");
}

async function waitDataPath(page: Page, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  do {
    if (await dataPath(page, selector) === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() < deadline);
  assert.equal(await dataPath(page, selector), expected);
}

function browserExecutable(): string {
  const candidates = [
    optionValue("--browser"),
    process.env.SHELLX_MOTION_BROWSER,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  const discovered = resolveMotionBrowserExecutable();
  const problem = motionBrowserExecutableVerificationProblem(discovered);
  if (problem) throw new Error("No Chrome/Chromium executable found. Pass --browser <absolute path>.");
  return discovered.executable;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

function isContainerLike(): boolean {
  return existsSync("/.dockerenv") || process.env.CI === "true";
}

function sampleReceipt(outputPath: string): Record<string, unknown> {
  return {
    schema: "shellx-motion/receipt@1",
    id: "render-ui-clickthrough",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_ui_clickthrough",
    lane: "ffmpeg",
    createdAt: "2026-08-04T00:00:00.000Z",
    inputHashes: { motion: "a".repeat(64) },
    output: {
      path: outputPath,
      width: 1280,
      height: 720,
      durationMs: 2000,
      encoder: "libx264",
      encoderSource: "software",
      encoderReason: "software-default",
      qualityCheck: { status: "passed" }
    },
    actor: { kind: "agent", label: "UI click-through", transport: "http", grantedTier: "write_local" },
    artifacts: [{ role: "rendered_media", path: outputPath, status: "available", mediaType: "video/mp4", primary: true }],
    warnings: []
  };
}
