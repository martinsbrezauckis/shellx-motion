import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage, type AgentScriptProvenanceAuthority, type ReceiptActor } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createApprovedAgentScriptProvenanceAuthority } from "@shellx-motion/renderer-browser";
import { dispatchDebugCommand, establishServerObservedMcpSession } from "../index.js";
import { dispatchAgentScriptAuthoringCommand } from "./authoring-agent-script.js";

const roots: string[] = [];

async function fixtureRoot(): Promise<{ root: string; sourceRoot: string; replacementRoot: string; outputRoot: string; stateRoot: string }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-agent-script-authoring-"));
  roots.push(root);
  const sourceRoot = join(root, "inputs", "source");
  const replacementRoot = join(root, "inputs", "replacement");
  const outputRoot = join(root, "outputs");
  const stateRoot = join(root, "host-state");
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  await writeJson(join(sourceRoot, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "agent-script-data-only",
    name: "Data only source",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  });
  await writeJson(join(sourceRoot, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "agent-script-data-only-motion",
    name: "Data only source",
    durationMs: 1000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{
      id: "background",
      type: "shape",
      shape: "rectangle",
      startMs: 0,
      durationMs: 1000,
      width: 320,
      height: 180,
      fill: "#111111"
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  });
  await cp(sourceRoot, replacementRoot, { recursive: true });
  await writeJson(join(replacementRoot, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "agent-script-data-only",
    name: "Replacement data only source",
    motion: "replacement-motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  });
  await writeJson(join(replacementRoot, "replacement-motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "agent-script-data-only-motion",
    name: "Replacement data only source",
    durationMs: 1000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{
      id: "replacement-background",
      type: "shape",
      shape: "rectangle",
      startMs: 0,
      durationMs: 1000,
      width: 320,
      height: 180,
      fill: "#222222"
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "replacement-test" }
  });
  return { root, sourceRoot, replacementRoot, outputRoot, stateRoot };
}

function args(packageRoot: string, outDir: string): Record<string, unknown> {
  return {
    packageRoot,
    outDir,
    html: "<main id=\"entry\"></main><script>document.body.dataset.local = 'true';</script>",
    layer: { id: "entry", type: "html", startMs: 0, durationMs: 1000 }
  };
}

function actor(transport: ReceiptActor["transport"], sessionId = "server-1:session-1"): ReceiptActor {
  return { kind: "agent", label: `${transport} client`, transport, sessionId, grantedTier: "write_local" };
}

async function inTrustedRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

describe("approved-agent-entry Debug authoring", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it.each([
    { authoringInputRoots: [], authoringOutputRoots: ["output"] },
    { authoringInputRoots: ["input"], authoringOutputRoots: [] }
  ])("fails closed when a configured authoring root list is empty", async (configuredRoots) => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: fixture.stateRoot });
    const result = await dispatchDebugCommand("motion.package.script.author", args(fixture.sourceRoot, join(fixture.outputRoot, "unapproved")), {
      tier: "write_local",
      actor: actor("mcp"),
      observedMcpAgentSession: establishServerObservedMcpSession(),
      agentScriptAuthority: authority,
      authoringInputRoots: configuredRoots.authoringInputRoots.map((root) => root === "input" ? join(fixture.root, "inputs") : root),
      authoringOutputRoots: configuredRoots.authoringOutputRoots.map((root) => root === "output" ? fixture.outputRoot : root)
    });

    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(await readdir(fixture.outputRoot)).toEqual([]);
    expect(await readdir(fixture.stateRoot)).toEqual([]);
  });

  it("does not let actor labels or a structurally forged session self-declare into authoring", async () => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: fixture.stateRoot });
    const context = {
      tier: "write_local" as const,
      agentScriptAuthority: authority,
      authoringInputRoots: [join(fixture.root, "inputs")],
      authoringOutputRoots: [fixture.outputRoot]
    };

    for (const transport of ["http", "ws", "sdk", "cli"] as const) {
      const result = await dispatchDebugCommand("motion.package.script.author", args(fixture.sourceRoot, join(fixture.outputRoot, transport)), {
        ...context,
        actor: actor(transport)
      });
      expect(result).toMatchObject({ ok: false, error: { code: "approved_agent_entry_refused" } });
    }
    const missingSession = await dispatchDebugCommand("motion.package.script.author", args(fixture.sourceRoot, join(fixture.outputRoot, "missing-session")), {
      ...context,
      actor: actor("mcp", "")
    });
    expect(missingSession).toMatchObject({ ok: false, error: { code: "approved_agent_entry_refused" } });
    const forgedSession = await dispatchDebugCommand("motion.package.script.author", args(fixture.sourceRoot, join(fixture.outputRoot, "forged-session")), {
      ...context,
      actor: actor("mcp"),
      observedMcpAgentSession: {} as never
    });
    expect(forgedSession).toMatchObject({ ok: false, error: { code: "approved_agent_entry_refused" } });
  });

  it("keeps the authoring request closed and rejects secondary executable loading constructs", async () => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: fixture.stateRoot });
    const context = {
      tier: "write_local" as const,
      actor: actor("mcp"),
      agentScriptAuthority: authority,
      authoringInputRoots: [join(fixture.root, "inputs")],
      authoringOutputRoots: [fixture.outputRoot]
    };
    const invalidInputs: Record<string, unknown>[] = [
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "outer")), packageDir: join(fixture.outputRoot, "ignored") },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "layer")), layer: { id: "entry", type: "html", startMs: 0, durationMs: 1000, transform: { x: 2 } } },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "script")), html: "<script>document.createElement('script').src = 'extra.js'</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "frame")), html: "<iframe src=\"secondary.html\"></iframe>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "frame-ns")), html: "<script>document.createElementNS('http://www.w3.org/1999/xhtml', 'iframe')</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "composition")), html: "<section data-composition-src=\"secondary.html\"></section>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "worker")), html: "<script>new Worker('worker.js')</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "import")), html: "<script>import('./next.js')</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "import-scripts")), html: "<script>importScripts('worker.js')</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "module")), html: "<script type=module>export {}</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "inert")), html: "<script type=application/json>{\"code\":\"secondary\"}</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "event")), html: "<button onclick=\"globalThis.sideEffect = true\">run</button>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "javascript-url")), html: "<a href=\"javascript:globalThis.sideEffect = true\">run</a>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "constructor")), html: "<script>[].filter.constructor('globalThis.sideEffect = true')()</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "timer")), html: "<script>setTimeout('globalThis.sideEffect = true')</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "computed-tag")), html: "<script>document.createElement('scr' + 'ipt')</script>" },
      { ...args(fixture.sourceRoot, join(fixture.outputRoot, "wasm")), html: "<script>new WebAssembly.Module(new Uint8Array())</script>" }
    ];
    for (const input of invalidInputs) {
      await expect(dispatchDebugCommand("motion.package.script.author", input, context)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_args" }
      });
    }
    // Argument/admission refusal happens before package staging or authority use, not after a
    // partial output or an evidence claim has been made.
    expect(await readdir(fixture.outputRoot)).toEqual([]);
    expect(await readdir(fixture.stateRoot)).toEqual([]);
  });

  it("refuses a stylesheet-fed computed eval before it can mint provenance, write a receipt, or create output", async () => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: fixture.stateRoot });
    const outDir = join(fixture.outputRoot, "computed-eval");
    const result = await dispatchDebugCommand("motion.package.script.author", {
      ...args(fixture.sourceRoot, outDir),
      html: `<link rel="stylesheet" href="payload.css"><script>
        const payload = getComputedStyle(document.documentElement).getPropertyValue("--payload");
        globalThis["ev" + "al"](payload);
      </script>`
    }, {
      tier: "write_local",
      actor: actor("mcp"),
      agentScriptAuthority: authority,
      authoringInputRoots: [join(fixture.root, "inputs")],
      authoringOutputRoots: [fixture.outputRoot]
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.stateRoot)).toEqual([]);
  });

  it("keeps pre-existing active scripts refused after staged admission", async () => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: fixture.stateRoot });
    const sourceMotion = JSON.parse(await readFile(join(fixture.sourceRoot, "motion.json"), "utf8")) as { layers: unknown[] };
    sourceMotion.layers.push({
      id: "existing-script",
      type: "html",
      startMs: 0,
      durationMs: 1000,
      source: "scripts/existing.html",
      allowedOrigins: []
    });
    await mkdir(join(fixture.sourceRoot, "scripts"), { recursive: true });
    await writeFile(join(fixture.sourceRoot, "scripts", "existing.html"), "<main>existing</main>", "utf8");
    await writeJson(join(fixture.sourceRoot, "motion.json"), sourceMotion);

    const outDir = join(fixture.outputRoot, "pre-existing-script");
    const result = await inTrustedRoot(fixture.root, async () => await dispatchDebugCommand("motion.package.script.author", args(fixture.sourceRoot, outDir), {
      tier: "write_local",
      actor: actor("mcp"),
      observedMcpAgentSession: establishServerObservedMcpSession(),
      agentScriptAuthority: authority,
      authoringInputRoots: [join(fixture.root, "inputs")],
      authoringOutputRoots: [fixture.outputRoot]
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "approved_agent_entry_refused" } });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.stateRoot)).toEqual([]);
  });

  it("refuses a same-ID source A-to-B replacement before output, attestation, or receipt", async () => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: fixture.stateRoot });
    const outDir = join(fixture.outputRoot, "swapped");
    let mintCalls = 0;
    let receiptWrites = 0;
    const trackedAuthority: AgentScriptProvenanceAuthority = {
      resolverVersion: authority.resolverVersion,
      mint: async (input) => { mintCalls += 1; return await authority.mint(input); },
      resolve: async (pkg) => await authority.resolve(pkg),
      revoke: async (attestationId) => await authority.revoke(attestationId),
      writeReceipt: async (receipt) => { receiptWrites += 1; return await authority.writeReceipt(receipt); }
    };
    let swapped = false;
    const result = await inTrustedRoot(fixture.root, async () => await dispatchAgentScriptAuthoringCommand("motion.package.script.author", args(fixture.sourceRoot, outDir), {
      tier: "write_local",
      actor: actor("mcp"),
      observedMcpAgentSession: establishServerObservedMcpSession(),
      agentScriptAuthority: trackedAuthority,
      authoringInputRoots: [join(fixture.root, "inputs")],
      authoringOutputRoots: [fixture.outputRoot],
      packageLoader: async (root) => {
        const loaded = await loadMotionPackage(root);
        if (!swapped) {
          swapped = true;
          await rename(fixture.sourceRoot, join(fixture.root, "source-a"));
          await rename(fixture.replacementRoot, fixture.sourceRoot);
        }
        return loaded;
      }
    }));

    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: "source_changed" } });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.outputRoot)).toEqual([]);
    expect(mintCalls).toBe(0);
    expect(receiptWrites).toBe(0);
    expect(await readdir(fixture.stateRoot)).toEqual([]);
  });

  it("requires server-established observed MCP plus write_local, then mints authority-owned evidence and host receipt", async () => {
    const fixture = await fixtureRoot();
    const authority = createApprovedAgentScriptProvenanceAuthority({
      stateRoot: fixture.stateRoot,
      now: () => new Date("2026-08-09T00:00:00.000Z")
    });
    const outDir = join(fixture.outputRoot, "approved");
    const result = await inTrustedRoot(fixture.root, async () => await dispatchDebugCommand("motion.package.script.author", args(fixture.sourceRoot, outDir), {
      tier: "write_local",
      actor: actor("mcp"),
      observedMcpAgentSession: establishServerObservedMcpSession(),
      agentScriptAuthority: authority,
      authoringInputRoots: [join(fixture.root, "inputs")],
      authoringOutputRoots: [fixture.outputRoot]
    }));

    expect(result).toMatchObject({
      ok: true,
      receiptId: expect.stringMatching(/^approved-agent-entry-/),
      visibleState: { operation: "package.script.author", activeMode: "trusted-local-agent-authored" },
      result: {
        packageRoot: outDir,
        sourcePath: "scripts/agent/entry.html",
        scriptExecution: {
          requestedMode: "trusted-local-agent-authored",
          activeMode: "trusted-local-agent-authored",
          resolverVersion: 1
        },
        receipt: {
          output: {
            scriptExecution: {
              requestedMode: "trusted-local-agent-authored",
              activeMode: "trusted-local-agent-authored",
              resolverVersion: 1
            },
            provenance: { property: "approved-agent-entry provenance" }
          }
        }
      }
    });
    if (!result.ok) return;
    const detail = result.result as { scriptExecution: { attestationId: string } };
    expect(result.result).not.toHaveProperty("hostReceiptPath");
    expect(result.result).not.toHaveProperty("attestation");
    expect(JSON.stringify(result)).not.toContain(fixture.stateRoot);
    expect(JSON.stringify(result)).not.toContain("packageRootIdentity");
    expect(JSON.stringify(result.result)).not.toContain("\"dev\"");
    expect(JSON.stringify(result.result)).not.toContain("\"ino\"");

    await inTrustedRoot(fixture.root, async () => {
      const resolved = await authority.resolve(await loadMotionPackage(outDir));
      try {
        expect(resolved.evidence.attestationId).toBe(detail.scriptExecution.attestationId);
        expect(resolved.evidence.sources).toEqual([expect.objectContaining({ path: "scripts/agent/entry.html" })]);
      } finally {
        await resolved.release();
      }
    });
    const admittedHtml = await readFile(join(outDir, "scripts", "agent", "entry.html"), "utf8");
    expect(admittedHtml).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(admittedHtml).toContain("script-src 'sha256-");
    expect(admittedHtml).toContain("connect-src 'none'");
    expect(admittedHtml).toContain("require-trusted-types-for 'script'");
    expect(admittedHtml).not.toContain("unsafe-eval");
    const inlineHash = createHash("sha256").update("document.body.dataset.local = 'true';", "utf8").digest("base64");
    expect(admittedHtml).toContain(`'sha256-${inlineHash}'`);
    expect(admittedHtml).toContain("document.body.dataset.local = 'true';");
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
