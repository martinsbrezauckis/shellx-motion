/**
 * workbench-engine-room.test.ts — endpoint tests for the Engine Room additions:
 * documentation viewer, explicit update channel, and reveal-in-file-manager.
 *
 * These follow the existing debug-server test patterns: capability-authenticated
 * fetch, loopback-only server, temp roots cleaned in `finally`. Every endpoint is
 * proven to require authentication, reject traversal/out-of-root input, and honor
 * the honest-state contract (unconfigured update channel, network-failure payload,
 * source-checkout apply, mocked OS opener).
 */
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { MOTION_ENGINE_VERSION } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerHandle, type MotionDebugServerOptions } from "./index";
import { compareEngineVersions } from "./workbench-update";
import type { RevealOpener, RevealTarget } from "./workbench-reveal";

const TEST_CAPABILITY_TOKEN = "test-capability-token-000000000000000000000000";

function startTestServer(options: MotionDebugServerOptions = {}): Promise<MotionDebugServerHandle> {
  return startMotionDebugServer({ ...options, capabilityToken: TEST_CAPABILITY_TOKEN });
}

function authed(url: URL, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${TEST_CAPABILITY_TOKEN}`
    }
  });
}

/** A minimal docs/public tree so tests do not depend on the shipped docs content. */
async function makeDocsRoot(): Promise<string> {
  const docsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-docs-"));
  await writeFile(join(docsRoot, "index.json"), JSON.stringify({
    version: 1,
    sections: [
      { id: "getting-started", title: "Getting started", pages: [
        { id: "quickstart", title: "Quickstart", file: "quickstart.md" },
        { id: "agent-templates", title: "Agent template reference", file: "agent-templates.md", audience: "agent" }
      ] }
    ]
  }));
  await writeFile(join(docsRoot, "quickstart.md"), "# Quickstart\n\nInstall and render.\n");
  await writeFile(join(docsRoot, "agent-templates.md"), "# Agent template reference\n");
  return docsRoot;
}

/** A local stand-in for the GitHub releases API. */
function startMockGithub(handler: (repoPath: string) => { status: number; body: string }): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      const match = /^\/repos\/(.+)\/releases\/latest$/.exec(request.url ?? "");
      if (!match) {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      const result = handler(match[1]);
      response.statusCode = result.status;
      response.setHeader("content-type", "application/json");
      response.end(result.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}

describe("engine room documentation viewer", () => {
  it("serves the docs index and pages only to authenticated callers, mapping ids strictly through index.json", async () => {
    const docsRoot = await makeDocsRoot();
    const server = await startTestServer({ port: 0, docsRoot });
    try {
      const unauthenticated = await globalThis.fetch(new URL("/workbench/docs/index.json", server.url));
      expect(unauthenticated.status).toBe(401);

      const index = await authed(new URL("/workbench/docs/index.json", server.url));
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("application/json");
      const indexBody = await index.json() as { version: number; sections: Array<{ pages: Array<{ id: string }> }> };
      expect(indexBody).toMatchObject({ version: 1, sections: expect.any(Array) });
      expect(indexBody.sections.flatMap((section) => section.pages.map((entry) => entry.id))).toEqual(["quickstart"]);

      const page = await authed(new URL("/workbench/docs/page?id=quickstart", server.url));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/markdown");
      expect(await page.text()).toContain("# Quickstart");

      const agentOnly = await authed(new URL("/workbench/docs/page?id=agent-templates", server.url));
      expect(agentOnly.status).toBe(404);
      expect(await agentOnly.json()).toMatchObject({ error: { code: "docs_page_not_found" } });

      // Path-from-query is impossible: a traversal-shaped id is just an unknown id.
      const traversal = await authed(new URL(`/workbench/docs/page?id=${encodeURIComponent("../../../../etc/passwd")}`, server.url));
      expect(traversal.status).toBe(404);
      expect(await traversal.json()).toMatchObject({ error: { code: "docs_page_not_found" } });

      const missingId = await authed(new URL("/workbench/docs/page", server.url));
      expect(missingId.status).toBe(400);
      expect(await missingId.json()).toMatchObject({ error: { code: "invalid_docs_page_id" } });
    } finally {
      await server.close();
      await rm(docsRoot, { recursive: true, force: true });
    }
  });

  it("rejects an index.json that declares a file escaping the docs root", async () => {
    const docsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-docs-bad-"));
    await writeFile(join(docsRoot, "index.json"), JSON.stringify({
      version: 1,
      sections: [{ id: "s", title: "s", pages: [{ id: "escape", title: "escape", file: "/etc/passwd" }] }]
    }));
    const server = await startTestServer({ port: 0, docsRoot });
    try {
      const escape = await authed(new URL("/workbench/docs/page?id=escape", server.url));
      expect(escape.status).toBe(500);
      expect(await escape.json()).toMatchObject({ error: { code: "docs_index_invalid" } });
    } finally {
      await server.close();
      await rm(docsRoot, { recursive: true, force: true });
    }
  });

  it("serves the shipped docs/public tree by default", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const index = await authed(new URL("/workbench/docs/index.json", server.url));
      expect(index.status).toBe(200);
      const body = await index.json() as { version: number; sections: Array<{ pages: Array<{ id: string }> }> };
      expect(body.version).toBe(1);
      const pageIds = body.sections.flatMap((section) => section.pages.map((entry) => entry.id));
      expect(pageIds).not.toContain("templates");
      expect(pageIds).toEqual(expect.arrayContaining(["cutout-rigging", "transition-presets", "cut-job-integration-spec"]));
      const firstPageId = body.sections[0]?.pages[0]?.id;
      expect(firstPageId).toBeTruthy();
      const page = await authed(new URL(`/workbench/docs/page?id=${encodeURIComponent(firstPageId)}`, server.url));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/markdown");
      expect((await page.text()).length).toBeGreaterThan(0);
      for (const pageId of ["cutout-rigging", "transition-presets", "cut-job-integration-spec"]) {
        const humanGuide = await authed(new URL(`/workbench/docs/page?id=${encodeURIComponent(pageId)}`, server.url));
        expect(humanGuide.status).toBe(200);
        expect(humanGuide.headers.get("content-type")).toContain("text/markdown");
        expect((await humanGuide.text()).length).toBeGreaterThan(0);
      }
    } finally {
      await server.close();
    }
  });
});

describe("engine room update channel", () => {
  it("exposes the canonical engine version on health and contracts", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const health = await globalThis.fetch(new URL("/health", server.url));
      expect(await health.json()).toMatchObject({ ok: true, engineVersion: MOTION_ENGINE_VERSION });
      const contracts = await authed(new URL("/debug/contracts", server.url));
      expect(await contracts.json()).toMatchObject({ ok: true, engineVersion: MOTION_ENGINE_VERSION });
    } finally {
      await server.close();
    }
  });

  it("requires authentication for the update check", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const unauthenticated = await globalThis.fetch(new URL("/workbench/update-check", server.url), { method: "POST" });
      expect(unauthenticated.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("reports an honest unconfigured state when no update repo is set", async () => {
    const server = await startTestServer({ port: 0, updateRepo: "" });
    try {
      const check = await authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      expect(check.status).toBe(200);
      expect(await check.json()).toMatchObject({
        ok: true,
        configured: false,
        currentVersion: MOTION_ENGINE_VERSION
      });
    } finally {
      await server.close();
    }
  });

  it("checks a configured repo against a mocked releases feed and compares versions", async () => {
    const github = await startMockGithub((repo) => {
      expect(repo).toBe("shellx/motion");
      return {
        status: 200,
        body: JSON.stringify({
          tag_name: "v1.4.0",
          name: "ShellX Motion 1.4.0",
          body: "First public release.",
          html_url: "https://example.test/releases/1.4.0",
          published_at: "2026-08-01T00:00:00Z",
          prerelease: false,
          draft: false,
          assets: [
            { name: "motion-linux.tar.gz", size: 1234, content_type: "application/gzip", browser_download_url: "https://example.test/a.tar.gz" }
          ]
        })
      };
    });
    // Fixture server is on 127.0.0.1: the hardened update fetch rejects private addresses and a
    // non-GitHub base in production, so the loopback fixture requires the explicit unsafe dev override.
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion", updateApiBaseUrl: github.baseUrl, updateAllowUnsafeBase: true });
    try {
      const check = await authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      expect(check.status).toBe(200);
      expect(await check.json()).toMatchObject({
        ok: true,
        configured: true,
        currentVersion: MOTION_ENGINE_VERSION,
        latestVersion: "1.4.0",
        upToDate: false,
        notesUrl: "https://example.test/releases/1.4.0",
        releasedAt: "2026-08-01T00:00:00Z",
        releaseName: "ShellX Motion 1.4.0",
        notes: "First public release.",
        assets: [{ name: "motion-linux.tar.gz", size: 1234, contentType: "application/gzip", downloadUrl: "https://example.test/a.tar.gz" }]
      });
    } finally {
      await server.close();
      await closeServer(github.server);
    }
  });

  it("reports up to date when the feed matches the current version", async () => {
    const github = await startMockGithub(() => ({ status: 200, body: JSON.stringify({ tag_name: `v${MOTION_ENGINE_VERSION}` }) }));
    // Fixture server is on 127.0.0.1: the hardened update fetch rejects private addresses and a
    // non-GitHub base in production, so the loopback fixture requires the explicit unsafe dev override.
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion", updateApiBaseUrl: github.baseUrl, updateAllowUnsafeBase: true });
    try {
      const check = await authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      expect(await check.json()).toMatchObject({ ok: true, configured: true, latestVersion: MOTION_ENGINE_VERSION, upToDate: true });
    } finally {
      await server.close();
      await closeServer(github.server);
    }
  });

  it("returns an honest error payload when the feed fails, never a fabricated result", async () => {
    const github = await startMockGithub(() => ({ status: 503, body: "unavailable" }));
    // Fixture server is on 127.0.0.1: the hardened update fetch rejects private addresses and a
    // non-GitHub base in production, so the loopback fixture requires the explicit unsafe dev override.
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion", updateApiBaseUrl: github.baseUrl, updateAllowUnsafeBase: true });
    try {
      const check = await authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      expect(check.status).toBe(200);
      const body = await check.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, configured: true, error: { code: "update_feed_unavailable" } });
      expect(body).not.toHaveProperty("latestVersion");
      expect(body).not.toHaveProperty("upToDate");
    } finally {
      await server.close();
      await closeServer(github.server);
    }
  });

  it("rejects a malformed release tag instead of silently treating it as 0.0.0", async () => {
    const github = await startMockGithub(() => ({ status: 200, body: JSON.stringify({ tag_name: "release-1.4.0" }) }));
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion", updateApiBaseUrl: github.baseUrl, updateAllowUnsafeBase: true });
    try {
      const check = await authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      expect(await check.json()).toMatchObject({
        ok: false,
        configured: true,
        error: { code: "update_feed_invalid", message: expect.stringContaining("valid SemVer") }
      });
    } finally {
      await server.close();
      await closeServer(github.server);
    }
  });

  it("returns a network-failure payload when the feed is unreachable", async () => {
    // Point at a closed loopback port; the fetch fails fast, not a fake success.
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion", updateApiBaseUrl: "http://127.0.0.1:1", updateTimeoutMs: 1500, updateAllowUnsafeBase: true });
    try {
      const check = await authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      const body = await check.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, configured: true });
      expect((body.error as { code: string }).code).toMatch(/update_feed_(error|timeout)/);
    } finally {
      await server.close();
    }
  });

  it("reports the honest source-checkout state on apply when not a packaged install", async () => {
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion" });
    try {
      const apply = await authed(new URL("/workbench/update-apply", server.url), { method: "POST" });
      expect(apply.status).toBe(200);
      expect(await apply.json()).toMatchObject({ ok: true, applied: false, mode: "source-checkout", updateChannelConfigured: true });
    } finally {
      await server.close();
    }
  });

  it("reports the manual-download state on apply for a packaged install without a signed channel", async () => {
    const server = await startTestServer({ port: 0, updateRepo: "shellx/motion", installRoot: "/opt/shellx-motion" });
    try {
      const apply = await authed(new URL("/workbench/update-apply", server.url), { method: "POST" });
      expect(await apply.json()).toMatchObject({
        ok: true,
        applied: false,
        mode: "manual-download",
        releasePageUrl: "https://github.com/shellx/motion/releases/latest"
      });
    } finally {
      await server.close();
    }
  });

  it("compares strict SemVer precedence, normalizes v tags, and rejects malformed inputs", () => {
    expect(compareEngineVersions("0.0.0", "1.2.0")).toBe(-1);
    expect(compareEngineVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareEngineVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareEngineVersions("1.2.0-beta.2", "1.2.0-beta.11")).toBe(-1);
    expect(compareEngineVersions("1.2.0-beta.11", "1.2.0-rc.1")).toBe(-1);
    expect(compareEngineVersions("1.2.0-rc.1", "1.2.0")).toBe(-1);
    expect(compareEngineVersions("v1.2.0", "1.2.0+build.20260808")).toBe(0);
    expect(compareEngineVersions("1.2.0+build.1", "1.2.0+build.999")).toBe(0);
    expect(compareEngineVersions("1.2", "1.2.0")).toBeNull();
    expect(compareEngineVersions("1.2.0-01", "1.2.0")).toBeNull();
  });
});

describe("engine room reveal endpoint", () => {
  it("requires authentication", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const unauthenticated = await globalThis.fetch(new URL("/workbench/reveal", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/tmp/whatever" })
      });
      expect(unauthenticated.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("rejects a path outside the authenticated artifact roots", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "shellx-motion-reveal-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-reveal-outside-"));
    const outsidePath = join(outsideRoot, "artifact.mp4");
    await writeFile(outsidePath, "x");
    let openerCalls = 0;
    const opener: RevealOpener = async () => {
      openerCalls += 1;
      return { ok: true };
    };
    const server = await startTestServer({ port: 0, artifactRoots: [artifactRoot], revealOpener: opener });
    try {
      const reveal = await authed(new URL("/workbench/reveal", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: outsidePath })
      });
      expect(reveal.status).toBe(403);
      expect(await reveal.json()).toMatchObject({ error: { code: "reveal_target_outside_roots" } });
      expect(openerCalls).toBe(0);
    } finally {
      await server.close();
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects a request without a path", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "shellx-motion-reveal-root-"));
    const server = await startTestServer({ port: 0, artifactRoots: [artifactRoot] });
    try {
      const reveal = await authed(new URL("/workbench/reveal", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      expect(reveal.status).toBe(400);
      expect(await reveal.json()).toMatchObject({ error: { code: "invalid_reveal_path" } });
    } finally {
      await server.close();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 for a missing artifact inside a root", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "shellx-motion-reveal-root-"));
    const server = await startTestServer({ port: 0, artifactRoots: [artifactRoot] });
    try {
      const reveal = await authed(new URL("/workbench/reveal", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(artifactRoot, "does-not-exist.mp4") })
      });
      expect(reveal.status).toBe(404);
      expect(await reveal.json()).toMatchObject({ error: { code: "reveal_target_not_found" } });
    } finally {
      await server.close();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("reveals an artifact's containing folder through the injected OS opener", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "shellx-motion-reveal-root-"));
    const artifactPath = join(artifactRoot, "render.mp4");
    await writeFile(artifactPath, "video-bytes");
    const seen: RevealTarget[] = [];
    const opener: RevealOpener = async (target) => {
      seen.push(target);
      return { ok: true };
    };
    const server = await startTestServer({ port: 0, artifactRoots: [artifactRoot], revealOpener: opener });
    try {
      const reveal = await authed(new URL("/workbench/reveal", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: artifactPath })
      });
      expect(reveal.status).toBe(200);
      const expectedDir = await realpath(artifactRoot);
      expect(await reveal.json()).toMatchObject({ ok: true, revealed: expectedDir });
      expect(seen).toHaveLength(1);
      expect(seen[0].directory).toBe(expectedDir);
      expect(seen[0].path).toBe(await realpath(artifactPath));
    } finally {
      await server.close();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
