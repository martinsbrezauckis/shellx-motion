/**
 * Exhaustive human Workbench click-through.
 *
 * Every visible control on Inspector, History, Connections, Docs, and About is exercised through a real
 * Chromium page and paired with an observable result. Native file dialogs are host-owned and
 * covered separately by the exact-host picker proof; this gate injects deterministic selections
 * so it can prove every Browse button's browser wiring and post-selection state without blocking.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { startMotionDebugServer } from "../packages/debug-server/src/index";
import type { WorkbenchPathPurpose } from "../packages/debug-server/src/workbench-path-picker";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fixtureRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const evidenceRoot = resolve(optionValue("--out") ?? join(repoRoot, ".scratch", "workbench-ui-clickthrough", process.platform));
const capabilityToken = "ui-clickthrough-capability-token-000000000000000000000000";
const workbenchBootstrapToken = "ui-clickthrough-bootstrap-token-000000000000000000000000";
const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-ui-clickthrough-"));
const receiptsRoot = join(tempRoot, "receipts");
const scratchRoot = join(tempRoot, "scratch");
const renderOutput = join(tempRoot, "workbench-render.png");
const qualityManifest = join(tempRoot, "quality-manifest.json");
const receiptOutput = join(tempRoot, "existing-render.mp4");
const pickerCalls: WorkbenchPathPurpose[] = [];
const revealCalls: string[] = [];
const configuredProviders: string[] = [];
const coverage: Array<{ page: string; control: string; outcome: string }> = [];
const browserErrors: string[] = [];
const expectedUnauthorizedErrors: string[] = [];
const unauthorizedResponses: string[] = [];

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
await assertStaticControlInventory();
await mkdir(receiptsRoot, { recursive: true });
await mkdir(scratchRoot, { recursive: true });
await writeFile(qualityManifest, "{}\n");
await writeFile(receiptOutput, "ui click-through fixture\n");
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
      tag_name: "v0.1.1",
      name: "ShellX Motion 0.1.1",
      body: "Click-through release fixture.",
      html_url: "https://example.test/shellx-motion/releases/v0.1.1",
      published_at: "2026-08-04T00:00:00.000Z",
      prerelease: false,
      draft: false,
      assets: []
    })
  }),
  pathPicker: async (request) => {
    pickerCalls.push(request.purpose);
    return pathSelections[request.purpose];
  },
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
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const error = `console: ${message.text()}`;
    if (error.includes("401 (Unauthorized)")) expectedUnauthorizedErrors.push(error);
    else browserErrors.push(error);
  });
  page.on("response", (response) => {
    if (response.status() !== 401) return;
    const url = new URL(response.url());
    unauthorizedResponses.push(`${response.request().method()} ${url.pathname}`);
  });

  await exerciseInspector(page);
  await exerciseHistory(page);
  await exerciseConnections(page);
  await exerciseDocs(page);
  await exerciseAbout(page, context);
  await exercisePrimaryNavigation(page);
  await exerciseCompactLayout(page);
  await exerciseStartMotionBootstrap(page);

  assert.deepEqual(
    [...pickerCalls].sort(),
    ["package-root", "quality-manifest", "receipts-root", "receipts-root", "render-output"].sort(),
    "Every visible Browse button/purpose must be exercised exactly once (receipts exists on two pages)."
  );
  assert.equal(revealCalls.length, 1, "History Open folder must reach the injected OS opener exactly once.");
  assert.deepEqual(configuredProviders, ["codex", "claude", "grok"], "Each one-click agent setup must reach the allowlisted configurator exactly once.");
  assert.deepEqual(
    unauthorizedResponses.sort(),
    ["GET /debug/contracts", "POST /workbench/bootstrap"].sort(),
    "Only the deliberate rejected-key and consumed-bootstrap requests may return 401."
  );
  assert.equal(browserErrors.length, 0, `Browser errors occurred:\n${browserErrors.join("\n")}`);
  assert(coverage.length >= 80, `Expected at least 80 checked UI outcomes, got ${coverage.length}.`);

  const report = {
    ok: true,
    command: "workbench:ui-smoke",
    platform: process.platform,
    browser: { executablePath, version: browser.version() },
    server: { engineVersion: "0.1.0", pageCount: 5 },
    coverageCount: coverage.length,
    pickerCalls,
    revealCalls,
    configuredProviders,
    expectedUnauthorizedErrors,
    unauthorizedResponses,
    browserErrors,
    screenshots: ["inspector.png", "history.png", "connections.png", "docs.png", "about.png", "compact-connections.png", "compact-docs.png", "compact-about.png"],
    coverage
  };
  await writeFile(join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}

async function exerciseInspector(page: Page): Promise<void> {
  await page.goto(new URL("/workbench", server.url).href, { waitUntil: "domcontentloaded" });
  await page.locator("#connectDialog").waitFor({ state: "visible" });
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
  await click(page, "Inspector", "Connect succeeds", page.locator('#connectForm button[type="submit"]'), async () => {
    await expectText(page.locator("#sessionButton"), "Disconnect");
    await page.locator("#connectDialog").waitFor({ state: "hidden" });
  });

  await click(page, "Inspector", "Package Browse selects and loads", page.locator("#packageBrowse"), async () => {
    await expectText(page.locator("#packageCount"), "1");
    await page.locator("#previewImage").waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await dataPath(page, "#packageRoot"), fixtureRoot);
  });
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
  await click(page, "Inspector", "Zoom in", page.locator("#zoomIn"), async () => {
    assert.equal((await page.locator("#zoomValue").textContent())?.trim(), "125%");
  });
  await click(page, "Inspector", "Zoom out", page.locator("#zoomOut"), async () => {
    assert.equal((await page.locator("#zoomValue").textContent())?.trim(), "100%");
  });

  await click(page, "Inspector", "Queue tab", page.locator('[role="tab"][data-panel="queuePanel"]'), async () => {
    await page.locator("#queuePanel").waitFor({ state: "visible" });
  });
  await click(page, "Inspector", "Queue Refresh", page.locator('[data-refresh-panel="queue"]'), async () => {
    await page.locator("#queueList").waitFor();
  });
  await click(page, "Inspector", "Receipts tab", page.locator('[role="tab"][data-panel="receiptsPanel"]'), async () => {
    await page.locator("#receiptsPanel").waitFor({ state: "visible" });
  });
  await click(page, "Inspector", "Receipts Browse selects and loads", page.locator("#receiptsBrowse"), async () => {
    await waitDataPath(page, "#receiptsRoot", canonicalReceiptsRoot);
    await expectText(page.locator("#receiptsSummary"), "1 of 1");
  });
  await click(page, "Inspector", "Receipts Refresh", page.locator('[data-refresh-panel="receipts"]'), async () => {
    await expectText(page.locator("#receiptsSummary"), "1 of 1");
  });
  await click(page, "Inspector", "Inspector tab", page.locator('[role="tab"][data-panel="inspectorPanel"]'), async () => {
    await page.locator("#inspectorPanel").waitFor({ state: "visible" });
  });

  await click(page, "Inspector", "Render opens dialog", page.locator("#renderButton"), async () => {
    await page.locator("#renderDialog").waitFor({ state: "visible" });
  });
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
  await page.locator("#renderPreset").selectOption("mp4-h264");
  await page.locator("#motionGate").check();
  assert(await page.locator("#motionGate").isChecked());
  await page.locator("#motionGate").uncheck();
  record("Inspector", "Motion gate checkbox", "checked and unchecked");
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

async function exerciseHistory(page: Page): Promise<void> {
  await page.goto(new URL("/workbench/history", server.url).href, { waitUntil: "domcontentloaded" });
  await expectText(page.locator("#sessionButton"), "Disconnect");
  await click(page, "History", "Receipts Browse selects and loads", page.locator("#receiptsBrowse"), async () => {
    await waitDataPath(page, "#receiptsRoot", canonicalReceiptsRoot);
    await page.locator(".receipt-card").first().waitFor({ state: "visible" });
  });
  await click(page, "History", "Load receipts", page.locator("#reloadButton"), async () => {
    await expectText(page.locator("#statusMessage"), "receipts loaded");
    assert(Number((await page.locator("#shownCount").textContent())?.trim()) >= 2);
  });
  await page.locator("#packageFilter").selectOption("pkg_ui_clickthrough");
  assert.equal((await page.locator(".receipt-card").count()), 1);
  record("History", "Package filter", "matching card remains");
  await page.locator("#operationFilter").selectOption("render.final");
  assert.equal((await page.locator(".receipt-card").count()), 1);
  record("History", "Operation filter", "matching card remains");
  await page.locator("#statusFilter").selectOption("failed");
  await expectText(page.locator("#shownCount"), "0");
  record("History", "Result filter", "non-matching state shows zero");
  await page.locator("#statusFilter").selectOption("");
  await page.locator("#packageFilter").selectOption("pkg_ui_clickthrough");
  await page.locator("#operationFilter").selectOption("");

  await click(page, "History", "Details", page.getByRole("button", { name: "Details" }), async () => {
    await page.locator("#detailDialog").waitFor({ state: "visible" });
  });
  await click(page, "History", "Show raw JSON", page.locator("#rawToggle"), async () => {
    await page.locator(".json-block").waitFor({ state: "visible" });
  });
  await click(page, "History", "Show structured view", page.locator("#rawToggle"), async () => {
    await page.locator(".kv-table").first().waitFor({ state: "visible" });
  });
  await click(page, "History", "Detail Close", page.locator('[data-close-dialog="detailDialog"]').last(), async () => {
    await assertDialogClosed(page, "#detailDialog");
  });
  await page.getByRole("button", { name: "Details" }).click();
  await click(page, "History", "Detail icon close", page.getByRole("button", { name: "Close detail" }), async () => {
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
  const pageIds = await page.locator(".docs-nav-link").evaluateAll((links) => links.map((link) => (link as HTMLElement).dataset.pageId));
  assert(!pageIds.includes("templates"), "Agent template reference leaked into the human Docs reader.");
  for (const pageId of pageIds) {
    assert(pageId);
    const link = page.locator(`.docs-nav-link[data-page-id="${pageId}"]`);
    await link.click();
    await page.locator(`.docs-nav-link[data-page-id="${pageId}"][aria-current="page"]`).waitFor();
    await page.locator("#docsContent h1").waitFor({ state: "visible" });
    record("Docs", `Documentation page ${pageId}`, "selected and rendered markdown");
  }
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
  await expectText(page.locator("#engineVersion"), "0.1.0");
  await click(page, "About", "Check now", page.locator("#checkButton"), async () => {
    await expectText(page.locator("#updateBadgeLabel"), "update available");
    await page.locator("#applyButton").waitFor({ state: "visible" });
  });
  const popupPromise = browserContext.waitForEvent("page");
  await page.locator("#updateNotes").click();
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.hostname === "example.test");
  assert.equal(new URL(popup.url()).hostname, "example.test");
  await popup.close();
  record("About", "View release notes", "opened validated release URL in a new tab");
  await click(page, "About", "Update options", page.locator("#applyButton"), async () => {
    await expectText(page.locator("#updateBadgeLabel"), "manual update");
  });
  await disconnectAndReconnect(page, "About");
  await page.screenshot({ path: join(evidenceRoot, "about.png"), fullPage: true });
}

async function exercisePrimaryNavigation(page: Page): Promise<void> {
  await page.goto(new URL("/workbench", server.url).href, { waitUntil: "domcontentloaded" });
  const labels = await page.locator(".wb-subnav a").allTextContents();
  assert.deepEqual(labels.map((label) => label.trim()), ["Inspector", "History", "Connections", "Docs", "About"]);
  for (const [label, suffix] of [["History", "/workbench/history"], ["Inspector", "/workbench"], ["Connections", "/workbench/connections"], ["Docs", "/workbench/docs"], ["About", "/workbench/about"]] as const) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await page.waitForURL((url) => url.pathname === suffix);
    record("Navigation", label, `navigated to ${suffix}`);
  }
}

async function exerciseCompactLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 760, height: 900 });
  for (const [name, path, screenshot] of [
    ["Inspector", "/workbench", null],
    ["History", "/workbench/history", null],
    ["Connections", "/workbench/connections", "compact-connections.png"],
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
  await page.locator("#capabilityToken").fill(capabilityToken);
  await click(page, pageName, "Reconnect", page.locator('#connectForm button[type="submit"]'), async () => {
    await expectText(page.locator("#sessionButton"), "Disconnect");
    await page.locator("#connectDialog").waitFor({ state: "hidden" });
  });
}

async function click(page: Page, pageName: string, control: string, locator: Locator, outcome: () => Promise<void>): Promise<void> {
  await locator.waitFor({ state: "visible" });
  const deadline = Date.now() + 30_000;
  while (!await locator.isEnabled() && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert(await locator.isEnabled(), `${pageName} / ${control} is disabled.`);
  await locator.click();
  await outcome();
  record(pageName, control, "checked");
}

function record(page: string, control: string, outcome: string): void {
  coverage.push({ page, control, outcome });
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
  if (!found) throw new Error("No Chrome/Chromium executable found. Pass --browser <absolute path>.");
  return found;
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

/** Fail when a human page adds/removes a static interactive element without extending this gate. */
async function assertStaticControlInventory(): Promise<void> {
  const expected = {
    "index.html": { button: 22, input: 3, select: 1, anchor: 0 },
    "history.html": { button: 8, input: 1, select: 3, anchor: 0 },
    "docs.html": { button: 3, input: 1, select: 0, anchor: 0 },
    "about.html": { button: 5, input: 1, select: 0, anchor: 1 },
    "connections.html": { button: 14, input: 1, select: 0, anchor: 0 }
  };
  for (const [file, counts] of Object.entries(expected)) {
    const html = await readFile(join(repoRoot, "packages", "debug-server", "workbench", file), "utf8");
    const actual = {
      button: (html.match(/<button\b/g) ?? []).length,
      input: (html.match(/<input\b/g) ?? []).length,
      select: (html.match(/<select\b/g) ?? []).length,
      anchor: (html.match(/<a\b/g) ?? []).length
    };
    assert.deepEqual(actual, counts, `${file} interactive inventory changed; extend the click-through before accepting it.`);
  }
}
