/**
 * One server, three transports, one argument contract.
 *
 * `rpc.discover` advertises `motion.debug.dispatch` beside `tools/call`, and `POST /debug` is the
 * plain HTTP door onto the same dispatcher. An agent picks whichever its host wired up. So the
 * question this suite answers is not "does validation work" — `mcp-args-validation.test.ts` covers
 * that — but "does the answer depend on which door you came through", which is the failure an agent
 * cannot debug because it looks like the engine being inconsistent.
 *
 * Two live differentials at the commit this suite was written against, same server, same arguments:
 *
 *   motion.export.plan { packageRoot, out: "/tmp/x.mp4" }
 *     motion.debug.dispatch -> ok: true            (the handler honours `out` as outputPath)
 *     tools/call            -> "argument out is not declared by this tool"
 *
 *   motion.state { unexpected: 1, packageRoot: 5 }
 *     motion.debug.dispatch -> ok: true            (nothing validated it at all)
 *     tools/call            -> invalid_args with per-argument violations
 *
 * The first direction is the worse one: a schema that omits an argument its handler reads turns
 * `additionalProperties: false` into a refusal of working calls. `scripts/debug-arg-coverage.ts`
 * derives the read set from the handlers and fails the build on any omission; this suite is the
 * end-to-end half of that proof, over the real wire.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface DebugPayload {
  ok?: boolean;
  error?: { code?: string; message?: string; detail?: { violations?: Array<Record<string, unknown>> } };
}

/** How a call ended, reduced to the only thing the three transports must agree on. */
interface Verdict {
  /** True when the ARGUMENT SHAPE was refused before the command ran. */
  shapeRejected: boolean;
  code: string | null;
  message: string;
  violations: Array<Record<string, unknown>>;
}

function verdictOf(payload: DebugPayload | undefined): Verdict {
  const violations = payload?.error?.detail?.violations ?? [];
  return {
    // A shape rejection is `invalid_args` carrying per-argument violations. A handler's own
    // `invalid_args` (a path that does not exist, a receipt that is missing) carries none, and must
    // not be confused with one — that difference is the whole point of the enum half of the fix.
    shapeRejected: payload?.error?.code === "invalid_args" && violations.length > 0,
    code: payload?.error?.code ?? null,
    message: payload?.error?.message ?? "",
    violations
  };
}

/** A real server plus one caller per transport, all authenticated the same way. */
async function transports(grantedTier: "read_motion" | "push_remote" = "push_remote") {
  const handle = await startMotionDebugServer({ host: "127.0.0.1", port: 0, grantedTier });
  servers.push(handle);
  const headers = { "content-type": "application/json", authorization: `Bearer ${handle.capabilityToken}` };

  const rpc = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    return await response.json() as Record<string, unknown>;
  };

  return {
    /** MCP `tools/call` — what an external agent binds to. */
    mcp: async (command: string, args: unknown): Promise<Verdict> => {
      const body = await rpc("tools/call", { name: command.replace(/\./g, "_"), arguments: { args } });
      const result = (body.result ?? {}) as { structuredContent?: DebugPayload };
      return verdictOf(result.structuredContent);
    },
    /** JSON-RPC `motion.debug.dispatch` — advertised beside tools/call by rpc.discover. */
    jsonRpc: async (command: string, args: unknown): Promise<Verdict> => {
      const body = await rpc("motion.debug.dispatch", { command, args });
      return verdictOf(body.result as DebugPayload | undefined);
    },
    /** `POST /debug` — the bare HTTP door onto the same dispatcher. */
    http: async (command: string, args: unknown): Promise<Verdict> => {
      const response = await fetch(new URL("/debug", handle.url), {
        method: "POST", headers, body: JSON.stringify({ command, args })
      });
      return verdictOf(await response.json() as DebugPayload);
    },
    /** The live tool listing, so assertions read what the client was actually shown. */
    toolsList: async (): Promise<Array<Record<string, unknown>>> => {
      const body = await rpc("tools/list", {});
      return ((body.result ?? {}) as { tools?: Array<Record<string, unknown>> }).tools ?? [];
    }
  };
}

/**
 * Calls whose arguments the handlers genuinely read, each one refused by `tools/call` before the
 * schemas were corrected. Every entry is an alias or filter taken from the handler source, not an
 * invention — see `scripts/debug-arg-coverage.ts` for the derivation.
 */
const HANDLER_HONOURED_CALLS: Array<{ command: string; args: Record<string, unknown> }> = [
  { command: "motion.export.plan", args: { packageRoot: "fixtures/packages/lower-third", out: "/tmp/motion-parity.mp4" } },
  { command: "motion.export.plan", args: { packageRoot: "fixtures/packages/lower-third", manifestPath: "/tmp/motion-parity.json" } },
  { command: "motion.template.catalog", args: { templateRoot: "fixtures/packages", renderCost: "low" } },
  { command: "motion.template.catalog", args: { templateRoot: "fixtures/packages", targetWidth: 1920, targetHeight: 1080, designFamily: "broadcast" } },
  { command: "motion.prompt.cancel", args: { receiptsRoot: ".scratch/parity-receipts", id: "receipt-abc" } },
  { command: "motion.package.extract", args: { inPath: "/tmp/motion-parity.zip", outDir: "/tmp/motion-parity-out" } },
  { command: "motion.keying.remove", args: { packageRoot: "fixtures/packages/lower-third", packageDir: "/tmp/motion-parity-keying", layerId: "lower-third" } },
  // All transports must pass the same valid closed nested master record to the mutator.
  // The package may still reject the copy destination on its own terms; this pins only that the
  // advertised document-master contract itself does not differ by transport.
  { command: "motion.audio.master.set", args: { packageRoot: "fixtures/packages/lower-third", outDir: "/tmp/motion-parity-audio-master", master: { volume: 0.8, loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1 } } } },
  { command: "motion.agent.revision.plan", args: { packageId: "pkg-parity", contactSheetFile: "/tmp/motion-parity-sheet.json" } },
  { command: "motion.timeline.keyframes.panel", args: { packageRoot: "fixtures/packages/lower-third", layer: "lower-third" } },
  { command: "motion.source.to_scripted_video", args: { source: "/tmp/motion-parity.md", outDir: "/tmp/motion-parity-script" } }
];

describe("every transport enforces the same argument contract", () => {
  it("accepts a handler-honoured argument on all three transports", async () => {
    const { mcp, jsonRpc, http } = await transports();

    for (const call of HANDLER_HONOURED_CALLS) {
      const [viaMcp, viaJsonRpc, viaHttp] = await Promise.all([
        mcp(call.command, call.args), jsonRpc(call.command, call.args), http(call.command, call.args)
      ]);
      const shapes = { mcp: viaMcp.shapeRejected, jsonRpc: viaJsonRpc.shapeRejected, http: viaHttp.shapeRejected };
      // The commands may still fail on their own terms — a missing archive, a receipt that is not
      // there. What must never happen is the ARGUMENTS being refused: the handler reads them.
      expect({ command: call.command, args: Object.keys(call.args), ...shapes, why: viaMcp.message })
        .toMatchObject({ mcp: false, jsonRpc: false, http: false });
    }
  }, 60000);

  it("rejects an undeclared argument on all three transports, not only on MCP", async () => {
    const { mcp, jsonRpc, http } = await transports("read_motion");

    const args = { unexpected: 1, packageRoot: 5 };
    const [viaMcp, viaJsonRpc, viaHttp] = await Promise.all([
      mcp("motion.state", args), jsonRpc("motion.state", args), http("motion.state", args)
    ]);

    for (const [transport, verdict] of Object.entries({ viaMcp, viaJsonRpc, viaHttp })) {
      expect({ transport, shapeRejected: verdict.shapeRejected }).toEqual({ transport, shapeRejected: true });
      // Both mistakes are named, and the wrong TYPE is distinguished from a missing argument.
      expect(verdict.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ argument: "unexpected", kind: "unknown_property" }),
        expect.objectContaining({ argument: "packageRoot", kind: "wrong_type", receivedType: "number" })
      ]));
    }
  }, 45_000);

  it("publishes the B2/B3 identity-only commands and keeps malformed, extra, and authority-free calls transport-identical", async () => {
    const { mcp, jsonRpc, http, toolsList } = await transports();
    const identity = { id: `checkpoint_storyboard_${"a".repeat(32)}`, sha256: "a".repeat(64), revision: 1 };
    for (const command of ["motion.timeline.checkpoint-storyboard.behavior.resolve", "motion.timeline.checkpoint-storyboard.behavior.detach", "motion.timeline.checkpoint-storyboard.relation.resolve", "motion.timeline.checkpoint-storyboard.relation.detach"]) {
      const malformed = { identity: { ...identity, revision: 0 } };
      const extra = { identity, outputPackageRoot: "/forbidden" };
      const valid = { identity };
      const [malformedMcp, malformedRpc, malformedHttp, extraMcp, extraRpc, extraHttp, validMcp, validRpc, validHttp] = await Promise.all([
        mcp(command, malformed), jsonRpc(command, malformed), http(command, malformed),
        mcp(command, extra), jsonRpc(command, extra), http(command, extra),
        mcp(command, valid), jsonRpc(command, valid), http(command, valid),
      ]);
      for (const verdict of [malformedMcp, malformedRpc, malformedHttp]) expect(verdict.shapeRejected).toBe(true);
      for (const verdict of [extraMcp, extraRpc, extraHttp]) expect(verdict.violations).toEqual(expect.arrayContaining([expect.objectContaining({ argument: "outputPackageRoot", kind: "unknown_property" })]));
      for (const verdict of [validMcp, validRpc, validHttp]) expect(verdict).toMatchObject({ shapeRejected: false, code: "capability_unavailable" });
      const tool = (await toolsList()).find((entry) => entry.name === command.replace(/\./g, "_"));
      expect((tool?.inputSchema as { properties?: { args?: { additionalProperties?: boolean; required?: string[] } } })?.properties?.args).toMatchObject({ additionalProperties: false, required: ["identity"] });
    }
  }, 45_000);

  it("enforces an enumRef value set, not just advertises it", async () => {
    const { mcp, jsonRpc, http, toolsList } = await transports();

    // `preset` carries `enumRef`, so its values reach the client only after resolution. While
    // resolution happened at publish time ONLY, the validator read the unresolved contract, saw no
    // enum, and let every value through to the handler — a different error class with no violations.
    const args = { packageRoot: "fixtures/packages/lower-third", preset: "not-a-real-preset" };
    const [viaMcp, viaJsonRpc, viaHttp] = await Promise.all([
      mcp("motion.export.plan", args), jsonRpc("motion.export.plan", args), http("motion.export.plan", args)
    ]);

    for (const [transport, verdict] of Object.entries({ viaMcp, viaJsonRpc, viaHttp })) {
      expect({ transport, shapeRejected: verdict.shapeRejected }).toEqual({ transport, shapeRejected: true });
      expect(verdict.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ argument: "preset", kind: "bad_enum_value" })
      ]));
    }

    // The refused list is EXACTLY the list the live tool listing showed the client.
    const tool = (await toolsList()).find((entry) => entry.name === "motion_export_plan");
    const published = (tool?.inputSchema as { properties?: { args?: { properties?: Record<string, { enum?: string[] }> } } })
      ?.properties?.args?.properties?.preset?.enum;
    const enforced = viaMcp.violations.find((violation) => violation.argument === "preset")?.allowedValues;
    expect(enforced).toEqual(published);
  }, 45_000);

  it("publishes and enforces B1c's exact opaque handle grammar on every transport", async () => {
    const { mcp, jsonRpc, http, toolsList } = await transports();
    const command = "motion.timeline.checkpoint-storyboard.creative-review.bind";
    const args = {
      identity: { id: `checkpoint_storyboard_${"a".repeat(32)}`, sha256: "a".repeat(64), revision: 1 },
      preview: {
        previewHandle: `checkpoint_storyboard_preview_${"b".repeat(32)}`,
        receiptHandle: `checkpoint_storyboard_preview_receipt_${"c".repeat(32)}`,
      },
      creativeReviewHandle: `checkpoint_storyboard_creative_review_handle_${"D".repeat(32)}`,
    };
    const [viaMcp, viaJsonRpc, viaHttp] = await Promise.all([
      mcp(command, args), jsonRpc(command, args), http(command, args)
    ]);
    for (const verdict of [viaMcp, viaJsonRpc, viaHttp]) {
      expect(verdict.shapeRejected).toBe(true);
      expect(verdict.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ argument: "creativeReviewHandle", kind: "bad_pattern", pattern: "^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$" }),
      ]));
    }
    const tool = (await toolsList()).find((entry) => entry.name === command.replace(/\./g, "_"));
    const published = (tool?.inputSchema as { properties?: { args?: { properties?: Record<string, Record<string, unknown>> } } })
      ?.properties?.args?.properties?.creativeReviewHandle;
    expect(published).toMatchObject({ minLength: 77, maxLength: 77, pattern: "^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$" });
  }, 45_000);

  it("publishes no unresolved enumRef on any tool, so every advertised value set is enforceable", async () => {
    const { toolsList } = await transports("read_motion");

    // An `enumRef` that survived onto the wire is a non-standard keyword carrying no values: the
    // client cannot discover the set and the validator cannot check it. Asserted over the LIVE
    // listing rather than the source, because publishing is where the resolution has to have
    // happened. 34 properties across ~30 commands were in that state.
    const unresolved: string[] = [];
    let advertisedEnums = 0;
    for (const tool of await toolsList()) {
      const properties = (tool.inputSchema as { properties?: { args?: { properties?: Record<string, Record<string, unknown>> } } })
        ?.properties?.args?.properties ?? {};
      for (const [name, property] of Object.entries(properties)) {
        if (property.enumRef !== undefined) unresolved.push(`${String(tool.name)}.${name}`);
        if (Array.isArray(property.enum)) advertisedEnums += 1;
      }
    }
    expect(unresolved).toEqual([]);
    expect(advertisedEnums).toBeGreaterThan(30);
  }, 45_000);

  it("documents the extra-argument rule the server actually applies", async () => {
    const { mcp } = await transports("read_motion");
    const reference = await readFile(join(REPO_ROOT, "docs", "public", "DEBUG_API_COMMANDS.md"), "utf8");

    // The generated reference is the primary contract surface for an agent, and it said
    // "Any other argument is ignored." for the ~158 commands that reject extras. `pnpm docs:check`
    // passed throughout, because generator and document agreed with each other and not with the
    // code. This asserts the document against the SERVER, which is the comparison that was missing.
    const section = reference.slice(reference.indexOf("### `motion.state`"));
    const closed = section.slice(0, section.indexOf("\n### "));
    expect(closed).toContain("Any other argument is **rejected**");
    expect(closed).not.toContain("Any other argument is ignored");

    const verdict = await mcp("motion.state", { definitelyNotAnArgument: true });
    expect(verdict.shapeRejected).toBe(true);
  }, 45_000);
});
