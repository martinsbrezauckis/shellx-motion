import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { createEffectModuleRegistryAuthority, type EffectModuleRegistryAuthority } from "@shellx-motion/renderer-browser/internal/effect-modules";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

const TOKEN = "effect-module-workbench-token-000000000000000000000000";
const BOOTSTRAP = "effect-module-workbench-bootstrap-000000000000000000";
const roots: string[] = [];
const EFFECT_MODULES_BROWSER_JS = new URL("../workbench/effect-modules.js", import.meta.url);

/**
 * Evaluate the shipped browser binding without its page closure. This is intentionally the browser
 * source rather than a test duplicate: a future closure dependency would fail the lift.
 */
async function liftBrowserFunction<T extends (...args: never[]) => unknown>(source: URL, name: string): Promise<T> {
  const text = await readFile(source, "utf8");
  const declaration = text.indexOf(`function ${name}(`);
  expect(declaration, `${source} must declare ${name}`).toBeGreaterThan(-1);
  const bodyStart = text.indexOf("{", declaration);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  expect(end, `${name} in ${source} must have a balanced body`).toBeGreaterThan(-1);
  return new Function(`"use strict"; return (${text.slice(declaration, end)});`)() as T;
}

type ModuleDetailValueFormatter = (value: unknown, key?: unknown) => string | null;

function manifest(): string {
  return `${JSON.stringify({
    schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.0.0", displayName: "Afterimage Stack",
    intrinsic: "motion.afterimage-stack.v1", rendererAbi: "shellx-motion/gpu-effect-module@1", parameterSchema: "motion.afterimage-stack.parameters@1"
  })}\n`;
}

async function fixture(): Promise<{ root: string; stateRoot: string; source: string }> {
  const base = join(resolve(process.cwd(), "../.."), ".scratch", "effect-module-workbench-tests");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "run-"));
  roots.push(root);
  await chmod(root, 0o700);
  const stateRoot = join(root, "effect-modules");
  await mkdir(stateRoot, { mode: 0o700 });
  const source = join(root, "afterimage.json");
  await writeFile(source, manifest(), { mode: 0o600 });
  return { root, stateRoot, source };
}

function factory(stateRoot: string) {
  return createEffectModuleRegistryAuthority({
    stateRoot,
    readManifestFileForTest: async (path) => {
      const bytes = await readFile(path);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
  });
}

async function bootstrap(server: MotionDebugServerHandle): Promise<string> {
  const response = await globalThis.fetch(new URL("/workbench/bootstrap", server.url), {
    method: "POST", headers: { "x-shellx-motion-workbench-bootstrap": BOOTSTRAP }
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/workbench/effect-modules");
  return cookie!.split(";", 1)[0]!;
}

function request(server: MotionDebugServerHandle, cookie: string | null, path: string, body: unknown = {}, init: { origin?: string; bearer?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.bearer !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (cookie) headers.cookie = cookie;
  if (init.origin !== undefined) headers.origin = init.origin;
  return globalThis.fetch(new URL(path, server.url), { method: "POST", headers, body: JSON.stringify(body) });
}

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("C1 Workbench local-effect authority", () => {
  it("requires bootstrap-derived same-origin operator session in addition to bearer and local-write", async () => {
    const { stateRoot } = await fixture();
    const server = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, grantedTier: "write_local", workbenchBootstrapToken: BOOTSTRAP, effectModulesRoot: stateRoot, effectModuleRegistryFactory: factory, pathPicker: async () => null, context: { scratchRoot: join(stateRoot, "unused-scratch") }, useDefaultTemplateRoots: false });
    try {
      expect((await globalThis.fetch(new URL("/workbench/effect-modules", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      const cookie = await bootstrap(server);
      expect((await request(server, null, "/workbench/effect-modules", {}, { origin: server.url.origin })).status).toBe(403);
      expect((await request(server, cookie, "/workbench/effect-modules", {}, { origin: server.url.origin, bearer: false })).status).toBe(401);
      expect((await request(server, cookie, "/workbench/effect-modules", {}, { origin: "https://attacker.example" })).status).toBe(403);
      expect((await request(server, cookie, "/workbench/effect-modules")).status).toBe(403);
    } finally { await server.close(); }

    const readOnly = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, grantedTier: "read_motion", workbenchBootstrapToken: BOOTSTRAP, effectModulesRoot: stateRoot, effectModuleRegistryFactory: factory, pathPicker: async () => null, context: { scratchRoot: join(stateRoot, "unused-scratch") }, useDefaultTemplateRoots: false });
    try {
      const cookie = await bootstrap(readOnly);
      expect((await request(readOnly, cookie, "/workbench/effect-modules", {}, { origin: readOnly.url.origin })).status).toBe(403);
    } finally { await readOnly.close(); }
  });

  it("keeps picker paths host-only and supports install, one-shot confirm, inspect, and revocation", async () => {
    const { stateRoot, source } = await fixture();
    let selected: string | null = null;
    const pickerCalls: Array<{ purpose: string; kind: string; currentPath: string; extensions: string[] }> = [];
    const server = await startMotionDebugServer({
      port: 0, capabilityToken: TOKEN, grantedTier: "write_local", workbenchBootstrapToken: BOOTSTRAP, effectModulesRoot: stateRoot,
      effectModuleRegistryFactory: factory,
      pathPicker: async (request) => { pickerCalls.push({ purpose: request.purpose, kind: request.kind, currentPath: request.currentPath, extensions: request.extensions }); return selected; }, context: { scratchRoot: join(stateRoot, "unused-scratch") }, useDefaultTemplateRoots: false
    });
    try {
      const cookie = await bootstrap(server), origin = server.url.origin;
      const noControls = await request(server, cookie, "/workbench/effect-modules/install", { path: source }, { origin });
      expect(noControls.status).toBe(400); expect(pickerCalls).toEqual([]);
      expect(await (await request(server, cookie, "/workbench/effect-modules/install", {}, { origin })).json()).toMatchObject({ ok: true, cancelled: true });
      selected = source;
      const prepared = await request(server, cookie, "/workbench/effect-modules/install", {}, { origin });
      const preparedBody = await prepared.json() as { pending: { confirmationId: string } };
      expect(prepared.status).toBe(200);
      expect(pickerCalls.at(-1)).toMatchObject({ purpose: "effect-module-manifest", kind: "file", currentPath: "", extensions: [".json"] });
      const confirmationId = preparedBody.pending.confirmationId;
      const confirmed = await request(server, cookie, "/workbench/effect-modules/confirm", { confirmationId }, { origin });
      expect(confirmed.status).toBe(200);
      expect((await confirmed.json())).toMatchObject({ result: { idempotent: false, entry: { moduleId: "motion.afterimage-stack", version: "1.0.0" } } });
      const replay = await request(server, cookie, "/workbench/effect-modules/confirm", { confirmationId }, { origin });
      expect(replay.status).toBe(400); expect(await replay.json()).toMatchObject({ error: { code: "pending_not_found" } });
      const listed = await request(server, cookie, "/workbench/effect-modules", {}, { origin });
      expect(await listed.json()).toMatchObject({ entries: [expect.objectContaining({ moduleId: "motion.afterimage-stack" })] });
      const inspected = await request(server, cookie, "/workbench/effect-modules/motion.afterimage-stack/1.0.0", {}, { origin });
      expect(await inspected.json()).toMatchObject({ entry: { displayName: "Afterimage Stack" } });
      expect((await request(server, cookie, "/workbench/effect-modules/motion.afterimage-stack/1.0.0/revoke", { force: true }, { origin })).status).toBe(400);
      expect(await (await request(server, cookie, "/workbench/effect-modules/motion.afterimage-stack/1.0.0/revoke", {}, { origin })).json()).toMatchObject({ result: { changed: true } });
    } finally { await server.close(); }
  });

  it("keeps registry management host-internal, absent from Debug/MCP/SDK contracts, and serves a pathless Workbench UI", async () => {
    expect(DEBUG_COMMAND_CONTRACTS.some((contract) => /effect-modules|effect-module|module-registry/.test(contract.command))).toBe(false);
    const rendererManifest = JSON.parse(await readFile(new URL("../../renderer-browser/package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(rendererManifest.exports["./internal/effect-modules"]).toBe("./src/effect-module-registry.ts");
    expect(Object.entries(rendererManifest.publishConfig.exports).filter(([path]) => /effect-module/i.test(path))).toEqual([
      ["./internal/effect-modules", { types: "./dist/effect-module-registry.d.ts", default: "./dist/effect-module-registry.js" }]
    ]);
    const page = await readFile(new URL("../workbench/effect-modules.html", import.meta.url), "utf8");
    const controller = await readFile(new URL("../workbench/effect-modules.js", import.meta.url), "utf8");
    expect(page).toContain("Install from file");
    expect(page).not.toMatch(/<input[^>]+(?:path|file)/i);
    expect(controller).not.toContain("currentPath");
    expect(controller).toContain("/workbench/effect-modules/install");
    expect(controller).toContain("function formatModuleDetailValue(value, key)");
    expect(controller).toContain("valueNode.textContent = formatted");
    expect(controller).not.toContain("valueNode.innerHTML");
  });

  it("renders nested provenance as stable, useful text instead of an object coercion", async () => {
    const format = await liftBrowserFunction<ModuleDetailValueFormatter>(EFFECT_MODULES_BROWSER_JS, "formatModuleDetailValue");
    const provenance = format({
      registry: "host-local",
      installationProvenance: {
        manifest: { displayName: "Afterimage Stack", version: "1.0.0" },
        integrity: { algorithm: "sha256", digest: "f00d" },
        stages: ["selected", "confirmed", "installed"]
      }
    });

    expect(provenance).not.toBeNull();
    expect(provenance).toContain('"installationProvenance":');
    expect(provenance).toContain('"displayName": "Afterimage Stack"');
    expect(provenance).toContain('["selected", "confirmed", "installed"]');
    expect(provenance).not.toContain("[object Object]");
    expect(format({ zebra: "last", alpha: "first" })).toBe('{"alpha": "first", "zebra": "last"}');
    expect(format("Afterimage Stack", "displayName")).toBe("Afterimage Stack");
    expect(format("motion.afterimage-stack", "moduleId")).toBe("motion.afterimage-stack");
  });

  it("keeps exact public renderer/schema identifiers visible without allowing arbitrary slash-bearing strings", async () => {
    const format = await liftBrowserFunction<ModuleDetailValueFormatter>(EFFECT_MODULES_BROWSER_JS, "formatModuleDetailValue");
    const rendererAbi = "shellx-motion/gpu-effect-module@1";

    expect(format(rendererAbi, "rendererAbi")).toBe(rendererAbi);
    expect(format("shellx-motion/effect-module-manifest@1", "schema")).toBe("shellx-motion/effect-module-manifest@1");
    expect(format({ rendererAbi })).toBe(`{"rendererAbi": "${rendererAbi}"}`);
    expect(format(rendererAbi, "untrustedDescription")).toBe("[redacted]");
  });

  it("recursively omits path and secret-bearing details and redacts scalar paths or links", async () => {
    const format = await liftBrowserFunction<ModuleDetailValueFormatter>(EFFECT_MODULES_BROWSER_JS, "formatModuleDetailValue");
    const details = format({
      installationProvenance: {
        manifestPath: "/private/effects/afterimage.json",
        nested: {
          cachePATH: "C:\\private\\cache",
          documentationUrl: "https://attacker.example/module",
          capabilityToken: "not-for-display",
          status: "installed"
        },
        scalarPath: "/private/no-key-leak",
        scalarLink: "https://attacker.example/no-key-leak"
      },
      sessionToken: "not-for-display",
      displayName: "Afterimage Stack"
    });

    expect(details).toContain('"status": "installed"');
    expect(details).toContain('"displayName": "Afterimage Stack"');
    for (const forbidden of ["manifestPath", "cachePATH", "documentationUrl", "capabilityToken", "sessionToken", "/private/effects", "C:\\private", "https://attacker.example", "not-for-display"]) {
      expect(details).not.toContain(forbidden);
    }
    for (const unsafeValue of ["/private/no-key-leak", "C:\\private\\no-key-leak", "\\\\server\\share\\no-key-leak", "./no-key-leak", "../no-key-leak", "https://attacker.example/no-key-leak"]) {
      expect(format(unsafeValue, "displayName")).toBe("[redacted]");
    }
    expect(format("ordinary local text", "displayName")).toBe("ordinary local text");
    expect(format("/private/manifest.json", "manifestPath")).toBeNull();
  });

  it("bounds cyclic, accessor, hostile, and oversized detail input without executing it", async () => {
    const format = await liftBrowserFunction<ModuleDetailValueFormatter>(EFFECT_MODULES_BROWSER_JS, "formatModuleDetailValue");
    const cyclic: Record<string, unknown> = { state: "installed" };
    cyclic.self = cyclic;
    expect(format(cyclic)).toContain("[circular]");

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "mustNotRun", { enumerable: true, get: () => { throw new Error("accessor executed"); } });
    expect(format(accessor)).toContain('"mustNotRun": [accessor omitted]');

    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("ownKeys executed"); } });
    expect(format(hostile)).toBe("[unavailable]");

    const manyEntries = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, "value"]));
    const boundedEntries = format(manyEntries);
    expect(boundedEntries).toContain("[fields omitted]");
    expect(boundedEntries!.length).toBeLessThanOrEqual(1200);
    const boundedString = format("x".repeat(500));
    expect(boundedString).toContain("[truncated]");
    expect(boundedString!.length).toBeLessThanOrEqual(1200);
  });

  it("refuses the manager when the installed host has no private registry configured", async () => {
    const { root } = await fixture();
    const server = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, grantedTier: "write_local", workbenchBootstrapToken: BOOTSTRAP, pathPicker: async () => null, context: { scratchRoot: join(root, "unused-scratch") }, useDefaultTemplateRoots: false });
    try {
      const cookie = await bootstrap(server);
      const response = await request(server, cookie, "/workbench/effect-modules", {}, { origin: server.url.origin });
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "effect_modules_unavailable" } });
    } finally { await server.close(); }
  });

  it("closes the HTTP server even when private registry cleanup fails", async () => {
    const { stateRoot } = await fixture();
    const server = await startMotionDebugServer({
      port: 0, capabilityToken: TOKEN, effectModulesRoot: stateRoot, useDefaultTemplateRoots: false, context: { scratchRoot: join(stateRoot, "unused-scratch") },
      effectModuleRegistryFactory: (root) => ({ ...factory(root), close: async () => { throw new Error("simulated registry close failure"); } })
    });
    await expect(server.close()).rejects.toThrow("shutdown encountered failures");
    expect(server.server.listening).toBe(false);
  });

  it("drains an admitted operator install before closing the registry", async () => {
    const { stateRoot, source } = await fixture();
    const base = factory(stateRoot);
    let markPrepareStarted!: () => void;
    let releasePrepare!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { markPrepareStarted = resolve; });
    const release = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let registryClosed = false;
    const authority: EffectModuleRegistryAuthority = {
      ...base,
      prepareInstallFromManifestFile: async (path) => {
        markPrepareStarted();
        await release;
        return await base.prepareInstallFromManifestFile(path);
      },
      close: async () => {
        registryClosed = true;
        return await base.close();
      }
    };
    const server = await startMotionDebugServer({
      port: 0, capabilityToken: TOKEN, grantedTier: "write_local", workbenchBootstrapToken: BOOTSTRAP,
      effectModulesRoot: stateRoot, effectModuleRegistryFactory: () => authority, pathPicker: async () => source,
      context: { scratchRoot: join(stateRoot, "unused-scratch") }, useDefaultTemplateRoots: false
    });
    let stopped = false;
    try {
      const cookie = await bootstrap(server), origin = server.url.origin;
      const installing = request(server, cookie, "/workbench/effect-modules/install", {}, { origin });
      await prepareStarted;
      const stopping = server.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(registryClosed).toBe(false);
      releasePrepare();
      expect((await installing).status).toBe(200);
      await stopping;
      stopped = true;
      expect(registryClosed).toBe(true);
    } finally {
      if (!stopped) await server.close().catch(() => undefined);
    }
  });
});
