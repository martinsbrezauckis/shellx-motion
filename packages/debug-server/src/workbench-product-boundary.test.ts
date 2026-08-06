import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION_ENGINE_VERSION } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";
import type { UpdateFetch } from "./workbench-update";

const TOKEN = `product-boundary-token-${"0".repeat(23)}`;

function authed(url: URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${TOKEN}`
    }
  });
}

async function waitForChecked(server: MotionDebugServerHandle): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await authed(new URL("/workbench/update-state", server.url));
    const body = await response.json() as Record<string, unknown>;
    if (body.status === "checked") return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The startup update check did not finish.");
}

async function waitForCallCount(readCalls: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (readCalls() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (readCalls() < expected) {
    throw new Error(`The update request did not start within the deadline (expected ${expected}, received ${readCalls()}).`);
  }
}

function releaseFetch(onCall?: () => void): UpdateFetch {
  return async () => {
    onCall?.();
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
      text: async () => JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/shellx/motion/releases/tag/v9.9.9",
        prerelease: false,
        draft: false,
        assets: []
      })
    };
  };
}

describe("human Workbench path selection", () => {
  it("keeps internal debug language out of every human page and wires Browse for path fields", async () => {
    const pages = await Promise.all(["index.html", "history.html", "connections.html", "docs.html", "about.html"].map(async (name) => ({
      name,
      source: await readFile(new URL(`../workbench/${name}`, import.meta.url), "utf8")
    })));
    for (const page of pages) {
      expect(page.source, page.name).not.toMatch(/local Motion debug session|No network access requested|Capability token|mode-0600|Debug commands|grant:|Loopback only/);
    }
    const visibleControllers = await Promise.all(["workbench.js", "history.js", "connections.js", "docs.js", "about.js"].map(async (name) => ({
      name,
      source: await readFile(new URL(`../workbench/${name}`, import.meta.url), "utf8")
    })));
    for (const controller of visibleControllers) {
      expect(controller.source, controller.name).not.toMatch(/Reading timeline, assets, and preview contracts|Loading package contracts|Package, timeline, and preview contracts loaded/);
    }

    const inspector = pages.find((page) => page.name === "index.html")!.source;
    expect(inspector).toMatch(/<output id="packageRoot"[^>]*class="path-display"/);
    expect(inspector).toContain("id=\"packageBrowse\"");
    expect(inspector).toMatch(/<output id="renderOutputPath"[^>]*class="path-display"/);
    expect(inspector).toContain("id=\"renderOutputBrowse\"");
    expect(inspector).toMatch(/<output id="qualityManifestPath"[^>]*class="path-display"/);
    expect(inspector).toContain("id=\"qualityManifestBrowse\"");

    const history = pages.find((page) => page.name === "history.html")!.source;
    expect(history).toMatch(/<output id="receiptsRoot"[^>]*class="path-display"/);
    expect(history).toContain("id=\"receiptsBrowse\"");

    const about = pages.find((page) => page.name === "about.html")!.source;
    expect(about).toContain("local-first authoring and rendering engine for Motion packages");
    expect(about).toContain("startup and every 30 minutes");
    expect(about).not.toMatch(/Available actions|Engine contract|SDK schema/);

    const nav = await readFile(new URL("../workbench/workbench-nav.js", import.meta.url), "utf8");
    expect(nav).toMatch(/id: "connections".*href: "\/workbench\/connections"/);
    expect(nav).not.toMatch(/Templates|\/workbench\/gallery|id:\s*"templates"/);
    for (const retired of ["gallery.html", "gallery.css", "gallery.js", "gallery-controls.js"]) {
      await expect(readFile(new URL(`../workbench/${retired}`, import.meta.url))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const pathPicker = await readFile(new URL("../workbench/workbench-path-picker.js", import.meta.url), "utf8");
    expect(pathPicker).toContain("selectedLabel || parts.at(-1)");

    const historyController = visibleControllers.find((controller) => controller.name === "history.js")!.source;
    expect(historyController).not.toContain('facet("Lane"');
    expect(historyController).not.toContain('appendRow(kv, "Lane"');
    expect(historyController).toContain('facet("Renderer"');
    expect(historyController).toContain('"render.final": "Final render"');
    expect(historyController).toContain('pathBasename(output.path)');
    expect(historyController).not.toContain('el("span", "op-id", card.id)');
    expect(historyController).not.toContain('el("span", "output-path", output.path)');

    const docsController = visibleControllers.find((controller) => controller.name === "docs.js")!.source;
    expect(docsController).toContain("if (!session.state.connected) showDisconnectedDocs()");
    expect(docsController).not.toContain("if (!session.state.connected) void loadIndex()");
  });

  it("shows token-free MCP setup commands and configures only an allowlisted agent", async () => {
    const configured: Array<{ provider: string; command: string; args: string[] }> = [];
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      connectionConfigurator: async (provider, bridge) => {
        configured.push({ provider, command: bridge.command, args: bridge.args });
        return { provider, configured: true, alreadyConfigured: false };
      }
    });
    try {
      const page = await fetch(new URL("/workbench/connections", server.url));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Add Motion to an agent");

      const state = await authed(new URL("/workbench/connections/state", server.url));
      expect(state.status).toBe(200);
      const body = await state.json() as Record<string, any>;
      expect(body).toMatchObject({
        ok: true,
        mcpUrl: expect.stringMatching(/\/rpc$/),
        debugApiUrl: expect.stringMatching(/\/debug$/),
        setupCommands: {
          codex: expect.stringContaining("codex mcp add shellx-motion"),
          claude: expect.stringContaining("claude mcp add --scope user shellx-motion"),
          grok: expect.stringContaining("grok mcp add --scope user shellx-motion"),
          generic: "shellx-motion-mcp"
        }
      });
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(body).not.toHaveProperty("bridge");
      expect(body).not.toHaveProperty("platform");
      expect(body).not.toHaveProperty("grantedTier");
      const humanSetup = Object.values(body.setupCommands).join("\n");
      expect(humanSetup).not.toContain(process.execPath);
      expect(humanSetup).not.toMatch(/shellx-motion-mcp\.mjs|[A-Za-z]:[\\/]|\/(?:home|Users|private|tmp|var|opt|usr|Applications|Volumes|mnt)\//);
      expect(body.setupCommands.codex).toContain("-- shellx-motion-mcp");
      expect(body.setupCommands.generic).not.toMatch(/mcp add/);

      const invalid = await authed(new URL("/workbench/connections/configure", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "arbitrary-command" })
      });
      expect(invalid.status).toBe(400);
      expect(configured).toEqual([]);

      const codex = await authed(new URL("/workbench/connections/configure", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "codex" })
      });
      expect(codex.status).toBe(200);
      expect(await codex.json()).toMatchObject({ ok: true, provider: "codex", configured: true });
      expect(configured).toHaveLength(1);
      expect(configured[0]).toMatchObject({ provider: "codex", command: process.execPath });
      expect(configured[0].args[0]).toMatch(/shellx-motion-mcp\.mjs$/);
    } finally {
      await server.close();
    }
  });

  it("keeps update transport and install internals out of user-facing states", async () => {
    const moduleUrl = new URL("../workbench/update-state.js", import.meta.url).href;
    const { buildUpdateView } = await import(moduleUrl) as {
      buildUpdateView: (kind: string, data?: Record<string, unknown>) => { message: string; title: string };
    };
    for (const view of [
      buildUpdateView("network-error", { errorCode: "update_feed_unavailable", message: "HTTP 404 Not Found" }),
      buildUpdateView("source-workflow-required", { message: "run pnpm install and git checkout" }),
      buildUpdateView("apply-error", { message: "git checkout failed" })
    ]) {
      expect(`${view.title} ${view.message}`).not.toMatch(/HTTP|pnpm|git|checkout/i);
    }

    const aboutController = await readFile(new URL("../workbench/about.js", import.meta.url), "utf8");
    expect(aboutController).toContain('"network-error": "unavailable"');
    expect(aboutController).not.toContain('"network-error": "unreachable"');
  });

  it("requires authentication and returns a native package-folder selection", async () => {
    const selectedRoot = await mkdtemp(join(tmpdir(), "motion-picker-root-"));
    const seen: Array<{ purpose: string; kind: string }> = [];
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      pathPicker: async (request) => {
        seen.push({ purpose: request.purpose, kind: request.kind });
        return selectedRoot;
      }
    });
    try {
      const anonymous = await fetch(new URL("/workbench/select-path", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "package-root" })
      });
      expect(anonymous.status).toBe(401);

      const selected = await authed(new URL("/workbench/select-path", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "package-root" })
      });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({ ok: true, cancelled: false, path: await realpath(selectedRoot) });
      expect(seen).toEqual([{ purpose: "package-root", kind: "folder" }]);
    } finally {
      await server.close();
      await rm(selectedRoot, { recursive: true, force: true });
    }
  });

  it("rejects retired human template picker purposes", async () => {
    const server = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, pathPicker: async () => null });
    try {
      for (const purpose of ["template-root", "template-media"]) {
        const selected = await authed(new URL("/workbench/select-path", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose })
        });
        expect(selected.status).toBe(400);
        expect(await selected.json()).toMatchObject({ error: { code: "invalid_path_purpose" } });
      }
    } finally {
      await server.close();
    }
  });

  it("reports cancellation without inventing a path", async () => {
    const server = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, pathPicker: async () => null });
    try {
      const selected = await authed(new URL("/workbench/select-path", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "package-root" })
      });
      expect(await selected.json()).toEqual({ ok: true, cancelled: true });
    } finally {
      await server.close();
    }
  });

  it("rejects a manifest selection that is not JSON", async () => {
    const selectedRoot = await mkdtemp(join(tmpdir(), "motion-picker-file-"));
    const selectedFile = join(selectedRoot, "notes.txt");
    await writeFile(selectedFile, "not a manifest");
    const server = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, pathPicker: async () => selectedFile });
    try {
      const selected = await authed(new URL("/workbench/select-path", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "quality-manifest" })
      });
      expect(selected.status).toBe(400);
      expect(await selected.json()).toMatchObject({ error: { code: "invalid_selected_path" } });
    } finally {
      await server.close();
      await rm(selectedRoot, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported render output extension", async () => {
    const selectedRoot = await mkdtemp(join(tmpdir(), "motion-picker-output-"));
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      pathPicker: async () => join(selectedRoot, "render.exe")
    });
    try {
      const selected = await authed(new URL("/workbench/select-path", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "render-output" })
      });
      expect(selected.status).toBe(400);
      expect(await selected.json()).toMatchObject({ error: { code: "invalid_selected_path" } });
    } finally {
      await server.close();
      await rm(selectedRoot, { recursive: true, force: true });
    }
  });
});

describe("shared automatic update status", () => {
  it("checks at startup and gives the same cached result to users and agents", async () => {
    let calls = 0;
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      updateRepo: "shellx/motion",
      updateApiBaseUrl: "http://127.0.0.1:7357",
      updateAllowUnsafeBase: true,
      updateFetch: releaseFetch(() => { calls += 1; }),
      updateAutoCheck: true,
      updateCheckIntervalMs: 60_000
    });
    try {
      const cached = await waitForChecked(server);
      expect(cached).toMatchObject({
        status: "checked",
        checkedAt: expect.any(String),
        nextCheckAt: expect.any(String),
        result: { ok: true, currentVersion: MOTION_ENGINE_VERSION, latestVersion: "9.9.9", upToDate: false }
      });
      expect(calls).toBe(1);

      const discovery = await authed(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" })
      });
      expect(await discovery.json()).toMatchObject({
        result: { update: { status: "checked", latestVersion: "9.9.9", updateAvailable: true, checkedAt: cached.checkedAt } }
      });
    } finally {
      await server.close();
    }
  });

  it("deduplicates simultaneous manual refreshes into one release request", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedFetch: UpdateFetch = async (...args) => {
      calls += 1;
      await gate;
      return releaseFetch()(...args);
    };
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: TOKEN,
      updateRepo: "shellx/motion",
      updateApiBaseUrl: "http://127.0.0.1:7357",
      updateAllowUnsafeBase: true,
      updateFetch: delayedFetch
    });
    try {
      const first = authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      const second = authed(new URL("/workbench/update-check", server.url), { method: "POST" });
      // Request dispatch can take longer than a fixed 20 ms on the low-power Windows
      // fresh-install host while other Vitest workers are reading multi-megabyte posters.
      await waitForCallCount(() => calls, 1);
      expect(calls).toBe(1);
      release();
      const [left, right] = await Promise.all([first, second]);
      expect(await left.json()).toMatchObject({ ok: true, latestVersion: "9.9.9" });
      expect(await right.json()).toMatchObject({ ok: true, latestVersion: "9.9.9" });
      expect(calls).toBe(1);
    } finally {
      // Never leave the mocked fetch blocked when an assertion fails: server.close()
      // correctly waits for active requests, so an unreleased gate would hide the
      // real assertion behind the package-level test timeout.
      release();
      await server.close();
    }
  });
});
