/**
 * update-state.test.ts — INTEGRATION contract test for the engine-room update flow.
 *
 * This replaces the previous split "mock-shape" unit tests (which fed the client
 * normalizer invented `{ state: "..." }` bodies the server never emits, and so
 * never caught the integration mismatch). Instead it pipes the actual results of the server half
 * `runWorkbenchUpdateCheck` / `runWorkbenchUpdateApply` (imported read-only) into
 * the client-half `normalizeCheckState` / `normalizeApplyState` / `buildUpdateView`
 * exactly as the About page (workbench/about.js) does, and asserts that every
 * contract state renders distinct, truthful copy and
 * truthful controls:
 *
 *   unconfigured, update available, current, network failure, source checkout,
 *   manual download, and truly applied.
 *
 * The release feed is mocked with the same GitHub `releases/latest` JSON fixtures
 * the server endpoint tests use (workbench-engine-room.test.ts). The client module
 * ships as a browser ES module (served static from workbench/), so it is imported
 * through a computed file URL to exercise the exact code the browser runs.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runWorkbenchUpdateApply, runWorkbenchUpdateCheck, type UpdateApplyResult, type UpdateCheckResult, type UpdateFetch } from "./workbench-update";

interface UpdateView {
  kind: string;
  tone: "neutral" | "positive" | "warn" | "danger";
  title: string;
  message: string;
  currentVersion: string;
  latestVersion: string;
  notesUrl: string;
  checkDisabled: boolean;
  showCheck: boolean;
  canApply: boolean;
  applyDisabled: boolean;
}

interface UpdateStateModule {
  normalizeCheckState: (body: unknown) => string;
  normalizeCachedUpdateState: (body: unknown) => string;
  normalizeApplyState: (body: unknown) => string;
  buildUpdateView: (kind: string, data?: Record<string, unknown>) => UpdateView;
}

let mod: UpdateStateModule;

beforeAll(async () => {
  const moduleUrl = new URL("../workbench/update-state.js", import.meta.url).href;
  mod = (await import(moduleUrl)) as UpdateStateModule;
});

/**
 * A mock `UpdateFetch` returning a GitHub `releases/latest` payload, matching the
 * fixtures the server endpoint tests use. `status` drives ok/failure.
 */
function releaseFeed(release: Record<string, unknown> | null, status = 200): UpdateFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? "Service Unavailable" : "OK",
    // The pinned fetcher contract requires content-type visibility; the
    // JSON media type keeps these fixtures valid for the hardened client.
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(release ?? {})
  });
}

/** The rich release fixture (mirrors workbench-engine-room.test.ts). */
const RELEASE_1_4_0 = {
  tag_name: "v1.4.0",
  name: "ShellX Motion 1.4.0",
  body: "First public release.",
  html_url: "https://example.test/releases/1.4.0",
  published_at: "2026-08-01T00:00:00Z",
  prerelease: false,
  draft: false,
  assets: [{ name: "motion-linux.tar.gz", size: 1234, content_type: "application/gzip", browser_download_url: "https://example.test/a.tar.gz" }]
} as const;

const CURRENT_VERSION = "1.0.0";

/**
 * Mirror the About page's check pipeline: server body -> normalizeCheckState ->
 * buildUpdateView, with the exact data fields about.js forwards.
 */
function renderCheck(body: UpdateCheckResult): { kind: string; view: UpdateView } {
  const record = body as Record<string, unknown>;
  const kind = mod.normalizeCheckState(record);
  const view = mod.buildUpdateView(kind, {
    currentVersion: typeof record.currentVersion === "string" ? record.currentVersion : "",
    latestVersion: typeof record.latestVersion === "string" ? record.latestVersion : "",
    notesUrl: typeof record.notesUrl === "string" ? record.notesUrl : "",
    errorCode: typeof (record.error as Record<string, unknown> | undefined)?.code === "string"
      ? (record.error as Record<string, unknown>).code
      : ""
  });
  return { kind, view };
}

/**
 * Mirror the About page's apply pipeline: server body -> normalizeApplyState ->
 * buildUpdateView, with the exact data fields about.js forwards.
 */
function renderApply(body: Record<string, unknown>): { kind: string; view: UpdateView } {
  const kind = mod.normalizeApplyState(body);
  const view = mod.buildUpdateView(kind, {
    latestVersion: typeof body.latestVersion === "string" ? body.latestVersion : "",
    ref: typeof body.ref === "string" ? body.ref : "",
    checkedOut: body.checkedOut === true || body.applied === true,
    message: typeof body.message === "string" ? body.message : "",
    notesUrl: typeof body.releasePageUrl === "string" ? body.releasePageUrl : ""
  });
  return { kind, view };
}

describe("update-check contract — real server result piped through the client view-model", () => {
  it("unconfigured channel renders 'not configured' and never a fabricated up-to-date", async () => {
    const result = await runWorkbenchUpdateCheck({ repo: null, apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION });
    expect(result).toMatchObject({ ok: true, configured: false });
    const { kind, view } = renderCheck(result);
    expect(kind).toBe("unconfigured");
    expect(view.title.toLowerCase()).toContain("not configured");
    expect(view.tone).toBe("neutral");
    expect(view.canApply).toBe(false);
  });

  it("an available update renders 'Update available' and exposes the Apply control", async () => {
    const result = await runWorkbenchUpdateCheck({
      repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null,
      currentVersion: CURRENT_VERSION, fetchImpl: releaseFeed(RELEASE_1_4_0)
    });
    expect(result).toMatchObject({ ok: true, configured: true, latestVersion: "1.4.0", upToDate: false });
    const { kind, view } = renderCheck(result);
    expect(kind).toBe("update-available");
    expect(view.title.toLowerCase()).toContain("update available");
    expect(view.tone).toBe("warn");
    expect(view.canApply).toBe(true);
    expect(view.message).toContain("1.4.0");
    expect(view.notesUrl).toBe("https://example.test/releases/1.4.0");
  });

  it("a current install renders 'Up to date' with no Apply control", async () => {
    const result = await runWorkbenchUpdateCheck({
      repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null,
      currentVersion: CURRENT_VERSION, fetchImpl: releaseFeed({ ...RELEASE_1_4_0, tag_name: `v${CURRENT_VERSION}` })
    });
    expect(result).toMatchObject({ ok: true, configured: true, upToDate: true });
    const { kind, view } = renderCheck(result);
    expect(kind).toBe("up-to-date");
    expect(view.title.toLowerCase()).toContain("up to date");
    expect(view.tone).toBe("positive");
    expect(view.canApply).toBe(false);
  });

  it("a feed failure renders a danger network-error that still allows a retry", async () => {
    const result = await runWorkbenchUpdateCheck({
      repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null,
      currentVersion: CURRENT_VERSION, fetchImpl: releaseFeed(null, 503)
    });
    expect(result).toMatchObject({ ok: false });
    const { kind, view } = renderCheck(result);
    expect(kind).toBe("network-error");
    expect(view.tone).toBe("danger");
    expect(view.showCheck).toBe(true);
    expect(view.canApply).toBe(false);
  });
});

describe("update-apply contract — real server result piped through the client view-model", () => {
  it("a source checkout renders 'source workflow required' and never claims applied", () => {
    const result: UpdateApplyResult = runWorkbenchUpdateApply({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION });
    expect(result).toMatchObject({ ok: true, applied: false, mode: "source-checkout" });
    const { kind, view } = renderApply(result as unknown as Record<string, unknown>);
    expect(kind).toBe("source-workflow-required");
    expect(view.title.toLowerCase()).toContain("cannot update itself");
    expect(view.tone).toBe("warn");
    expect(view.canApply).toBe(false);
    expect(view.title.toLowerCase()).not.toContain("applied");
    expect(view.message.toLowerCase()).not.toContain("update applied");
  });

  it("a packaged install without a signed channel renders 'manual download required' with the release link", () => {
    const result: UpdateApplyResult = runWorkbenchUpdateApply({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: "/opt/shellx-motion", currentVersion: CURRENT_VERSION });
    expect(result).toMatchObject({ ok: true, applied: false, mode: "manual-download", releasePageUrl: "https://github.com/shellx/motion/releases/latest" });
    const { kind, view } = renderApply(result as unknown as Record<string, unknown>);
    expect(kind).toBe("manual-action-required");
    expect(view.title.toLowerCase()).toContain("download required");
    expect(view.tone).toBe("warn");
    expect(view.canApply).toBe(false);
    expect(view.message).not.toMatch(/HTTP|git|pnpm|checkout/i);
    expect(view.notesUrl).toBe("https://github.com/shellx/motion/releases/latest");
    expect(view.title.toLowerCase()).not.toContain("applied");
  });

  it("only a server-confirmed applied === true renders the truly-applied state", () => {
    // The server has no in-place apply path yet (always applied:false), so this
    // asserts the CLIENT correctly reserves the "applied" state for a real
    // applied === true body.
    const notApplied = renderApply({ ok: true, applied: false, mode: "source-checkout" });
    expect(notApplied.kind).not.toBe("applied");

    const trulyApplied = renderApply({ ok: true, applied: true, latestVersion: "1.4.0", ref: "v1.4.0", checkedOut: true });
    expect(trulyApplied.kind).toBe("applied");
    expect(trulyApplied.view.tone).toBe("positive");
    expect(trulyApplied.view.title.toLowerCase()).toContain("applied");
    expect(trulyApplied.view.message.toLowerCase()).toContain("restart");
    expect(trulyApplied.view.canApply).toBe(false);
  });

  it("a non-ok apply body maps to apply-error, not a fabricated success", () => {
    const { kind, view } = renderApply({ ok: false, error: { code: "apply_failed", message: "git checkout failed" } });
    expect(kind).toBe("apply-error");
    expect(view.tone).toBe("danger");
    expect(view.title.toLowerCase()).not.toContain("applied to");
    expect(view.message).not.toContain("git checkout failed");
  });
});

describe("update acceptance — every contract state renders distinct, truthful copy and controls", () => {
  it("the seven acceptance states each produce unique title+message and correct Apply exposure", async () => {
    const unconfigured = renderCheck(await runWorkbenchUpdateCheck({ repo: null, apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION }));
    const available = renderCheck(await runWorkbenchUpdateCheck({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION, fetchImpl: releaseFeed(RELEASE_1_4_0) }));
    const current = renderCheck(await runWorkbenchUpdateCheck({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION, fetchImpl: releaseFeed({ ...RELEASE_1_4_0, tag_name: `v${CURRENT_VERSION}` }) }));
    const networkFailure = renderCheck(await runWorkbenchUpdateCheck({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION, fetchImpl: releaseFeed(null, 503) }));
    const sourceCheckout = renderApply(runWorkbenchUpdateApply({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: null, currentVersion: CURRENT_VERSION }) as unknown as Record<string, unknown>);
    const manualDownload = renderApply(runWorkbenchUpdateApply({ repo: "shellx/motion", apiBaseUrl: "https://api.github.com", installRoot: "/opt/shellx-motion", currentVersion: CURRENT_VERSION }) as unknown as Record<string, unknown>);
    const trulyApplied = renderApply({ ok: true, applied: true, latestVersion: "1.4.0", ref: "v1.4.0", checkedOut: true });

    const states = { unconfigured, available, current, networkFailure, sourceCheckout, manualDownload, trulyApplied };

    // Each acceptance state must resolve to its own distinct kind.
    const kinds = Object.values(states).map((state) => state.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual([
      "unconfigured", "update-available", "up-to-date", "network-error",
      "source-workflow-required", "manual-action-required", "applied"
    ]);

    // Copy must be distinct across every state (no two states share title+message).
    const copies = Object.values(states).map((state) => `${state.view.title}${state.view.message}`);
    expect(new Set(copies).size).toBe(copies.length);

    // Controls are truthful: only the available update exposes Apply; nothing else does.
    expect(available.view.canApply).toBe(true);
    for (const [name, state] of Object.entries(states)) {
      if (name === "available") continue;
      expect(state.view.canApply, `${name} must not expose Apply`).toBe(false);
    }

    // Truth invariant: only the truly-applied state may claim success.
    for (const [name, state] of Object.entries(states)) {
      if (name === "trulyApplied") continue;
      expect(state.view.message.toLowerCase(), `${name} must not claim the update was applied`).not.toContain("update applied");
      expect(state.view.message.toLowerCase(), `${name} must not claim a completed checkout`).not.toContain("now checked out");
    }
  });
});

describe("client lifecycle states", () => {
  it("idle waits honestly for the automatic startup check and offers a manual refresh", () => {
    const view = mod.buildUpdateView("idle");
    expect(view.showCheck).toBe(true);
    expect(view.canApply).toBe(false);
    expect(view.title.toLowerCase()).toContain("startup check");
    expect(view.message.toLowerCase()).toContain("first check");
  });

  it("maps cached startup and completed states through the same check normalizer", () => {
    expect(mod.normalizeCachedUpdateState({ status: "not_checked", result: null })).toBe("idle");
    expect(mod.normalizeCachedUpdateState({ status: "checking", result: null })).toBe("checking");
    expect(mod.normalizeCachedUpdateState({ status: "checked", result: { ok: true, configured: true, upToDate: false } })).toBe("update-available");
  });

  it("checking disables the check button while in flight", () => {
    const view = mod.buildUpdateView("checking");
    expect(view.checkDisabled).toBe(true);
  });

  it("applying disables the buttons while in flight", () => {
    const view = mod.buildUpdateView("applying", { latestVersion: "v2" });
    expect(view.applyDisabled).toBe(true);
    expect(view.checkDisabled).toBe(true);
  });

  it("endpoint-absent degrades honestly when the server build lacks the endpoint", () => {
    const view = mod.buildUpdateView("endpoint-absent");
    expect(view.title.toLowerCase()).toContain("unavailable");
  });

  it("rejects a non-http notes url (never emits an unsafe link target)", () => {
    const view = mod.buildUpdateView("update-available", { latestVersion: "v2", notesUrl: "javascript:alert(1)" });
    expect(view.notesUrl).toBe("");
  });

  it("rejects malformed and credential-bearing release links", () => {
    expect(mod.buildUpdateView("update-available", { notesUrl: "https://" }).notesUrl).toBe("");
    expect(mod.buildUpdateView("update-available", { notesUrl: "https://user:password@example.test/release" }).notesUrl).toBe("");
    expect(mod.buildUpdateView("update-available", { notesUrl: "https://example.test/release" }).notesUrl).toBe("https://example.test/release");
  });

  it("maps an unknown kind to an honest neutral 'unknown' state without throwing", () => {
    const view = mod.buildUpdateView("something-else");
    expect(view.tone).toBe("neutral");
    expect(view.title.toLowerCase()).toContain("unknown");
  });
});
