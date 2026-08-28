/**
 * The MCP argument contract, enforced on the real wire.
 *
 * Every case here goes through the actual HTTP JSON-RPC surface an MCP client binds to — a real
 * server, a real `POST /rpc`, a real `tools/call` — because the defect being pinned was invisible
 * from the inside: `tools/list` published a JSON Schema per tool and `tools/call` never executed it.
 *
 * Two behaviours were observed live before this suite existed, at commit e3f3eb4:
 *
 *   motion_render_final, args {}                          -> "motion.render.final requires packageRoot."
 *   motion_render_final, args { packageRoot: 5, ... }      -> "motion.render.final requires packageRoot."
 *
 * The same sentence for two different mistakes. An agent that sent a number could not learn that it
 * had sent a number, so it re-sent the number. `distinguishes a wrong type from a missing argument`
 * below is the test that fails if that ever comes back; the others cover the rest of the schema
 * (unknown property, enum, and a valid call that must still run).
 */
import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index";

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

type ToolPayload = {
  ok: boolean;
  error?: { code: string; message: string; suggestedAction?: string; detail?: unknown };
};

/**
 * Start a real debug server and return a caller for MCP `tools/call`.
 *
 * @param grantedTier - the server's authenticated grant. Argument validation runs only for calls the
 *   permission gate admits, so a render tool needs render_motion here to reach the shape check.
 */
async function mcpClient(grantedTier: "read_motion" | "render_motion" | "edit_motion" = "read_motion") {
  const handle = await startMotionDebugServer({ host: "127.0.0.1", port: 0, grantedTier });
  servers.push(handle);
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.capabilityToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    return await response.json() as { result?: { structuredContent?: ToolPayload; isError?: boolean }; error?: unknown };
  };
  const callTool = async (name: string, toolArguments: unknown) => {
    const body = await rpc("tools/call", { name, arguments: toolArguments });
    return { payload: body.result?.structuredContent as ToolPayload, isError: body.result?.isError };
  };
  return { rpc, callTool };
}

describe("the argument schema an MCP tool advertises is the one it enforces", () => {
  it("names a missing required argument as missing", async () => {
    const { callTool } = await mcpClient("render_motion");

    const { payload, isError } = await callTool("motion_render_final", { args: {} });

    expect(isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("invalid_args");
    expect(payload.error?.message).toMatch(/required argument packageRoot is missing/);
    expect(payload.error?.suggestedAction).toMatch(/Supply packageRoot/);
    expect(payload.error?.detail).toMatchObject({
      tool: "motion_render_final",
      command: "motion.render.final",
      violations: expect.arrayContaining([
        expect.objectContaining({ argument: "packageRoot", kind: "missing_required" })
      ])
    });
  }, 45_000);

  it("names a wrong-type argument by both the expected and the received type", async () => {
    const { callTool } = await mcpClient("render_motion");

    // The exact call from the regression: numeric paths where the schema declares strings.
    const { payload } = await callTool("motion_render_final", { args: { packageRoot: 5, outputPath: 7 } });

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("invalid_args");
    expect(payload.error?.message).toMatch(/argument packageRoot must be string, received number \(5\)/);
    expect(payload.error?.message).toMatch(/argument outputPath must be string, received number \(7\)/);
    expect(payload.error?.suggestedAction).toMatch(/Send packageRoot as string, not number/);
    expect(payload.error?.detail).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({
          argument: "packageRoot",
          kind: "wrong_type",
          expectedType: "string",
          receivedType: "number",
          receivedValue: 5
        })
      ])
    });
  }, 45_000);

  it("distinguishes a wrong type from a missing argument", async () => {
    // THE regression this file exists for. Before the fix both calls answered
    // "motion.render.final requires packageRoot." — byte-identical — so an agent had no way to tell
    // "you forgot it" from "you sent a number", and looped on the same wrong value.
    const { callTool } = await mcpClient("render_motion");

    const missing = await callTool("motion_render_final", { args: { outputPath: "/tmp/out.mp4" } });
    const wrongType = await callTool("motion_render_final", { args: { packageRoot: 5, outputPath: "/tmp/out.mp4" } });

    expect(missing.payload.error?.message).not.toBe(wrongType.payload.error?.message);
    // Not merely different strings: each must say which mistake was made.
    expect(missing.payload.error?.message).toMatch(/packageRoot is missing/);
    expect(missing.payload.error?.message).not.toMatch(/must be string/);
    expect(wrongType.payload.error?.message).toMatch(/packageRoot must be string, received number/);
    expect(wrongType.payload.error?.message).not.toMatch(/is missing/);
    // And the machine-readable form separates them too, for a client that branches on the code.
    expect(missing.payload.error?.detail).toMatchObject({
      violations: [expect.objectContaining({ argument: "packageRoot", kind: "missing_required" })]
    });
    expect(wrongType.payload.error?.detail).toMatchObject({
      violations: [expect.objectContaining({ argument: "packageRoot", kind: "wrong_type" })]
    });
  }, 45_000);

  it("rejects an undeclared property on a closed schema, naming the property", async () => {
    const { callTool } = await mcpClient();

    // motion.state publishes additionalProperties:false. This exact call used to return ok:true,
    // telling an agent that a misspelled argument had been honoured.
    const { payload } = await callTool("motion_state", { args: { unexpected: "surprise" } });

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("invalid_args");
    expect(payload.error?.message).toMatch(/argument unexpected is not declared by this command/);
    expect(payload.error?.suggestedAction).toMatch(/Remove unexpected/);
    expect(payload.error?.detail).toMatchObject({
      violations: [expect.objectContaining({ argument: "unexpected", kind: "unknown_property" })]
    });
  }, 45_000);

  it("keeps accepting extras where the schema deliberately stays open", async () => {
    // Not every schema is closed: five commands set additionalProperties:true on purpose. Honouring
    // each schema as written is the point — a blanket "reject unknown keys" would break them.
    const { callTool } = await mcpClient("render_motion");

    const { payload } = await callTool("motion_render_final", { args: { packageRoot: 5, somethingExtra: true } });

    const violations = (payload.error?.detail as { violations: Array<{ argument: string }> }).violations;
    expect(violations.map((violation) => violation.argument)).not.toContain("somethingExtra");
  }, 45_000);

  it("rejects a bad enum value by listing every allowed value", async () => {
    const { callTool } = await mcpClient();

    const { payload } = await callTool("motion_job_list", { args: { scope: "everything" } });

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("invalid_args");
    expect(payload.error?.message).toMatch(/argument scope must be "own" or "all", received string \("everything"\)/);
    expect(payload.error?.detail).toMatchObject({
      violations: [expect.objectContaining({
        argument: "scope",
        kind: "bad_enum_value",
        allowedValues: ["own", "all"],
        receivedValue: "everything"
      })]
    });
  }, 45_000);

  it("rejects a below-minimum number by naming the bound", async () => {
    const { callTool } = await mcpClient();

    const { payload } = await callTool("motion_job_list", { args: { limit: 0 } });

    expect(payload.error?.code).toBe("invalid_args");
    expect(payload.error?.message).toMatch(/argument limit must be >= 1, received number \(0\)/);
  }, 45_000);

  it("publishes and refuses malformed or unknown nested document-master controls on the real MCP wire", async () => {
    const { callTool, rpc } = await mcpClient("edit_motion");
    const invalid = await callTool("motion_audio_master_set", {
      args: {
        packageRoot: "/tmp/audio-master-source",
        outDir: "/tmp/audio-master-output",
        master: {
          loudness: {
            integratedLufs: -16,
            toleranceLufs: 1,
            maxTruePeakDbtp: "-1",
            arbitraryFilter: "aformat=unsafe",
          },
        },
      },
    });
    expect(invalid.payload.error?.code).toBe("invalid_args");
    expect(invalid.payload.error?.detail).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ argument: "master.loudness.maxTruePeakDbtp", kind: "wrong_type", expectedType: "number" }),
        expect.objectContaining({ argument: "master.loudness.arbitraryFilter", kind: "unknown_property" }),
      ]),
    });

    const body = await rpc("tools/list", {}) as unknown as { result: { tools: Array<{ name: string; inputSchema: { properties: { args: { properties: Record<string, any> } } } }> } };
    const master = body.result.tools.find((tool) => tool.name === "motion_audio_master_set")?.inputSchema.properties.args.properties.master;
    expect(master).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        volume: { minimum: 0, maximum: 4 },
        loudness: {
          required: ["integratedLufs", "toleranceLufs", "maxTruePeakDbtp"],
          additionalProperties: false,
          properties: { integratedLufs: { minimum: -70, maximum: -5 } },
        },
      },
    });
  }, 45_000);

  it("publishes the closed typed revision-step union and refuses a nested host receipt path", async () => {
    const { callTool, rpc } = await mcpClient("edit_motion");
    const invalid = await callTool("motion_revision_transaction", {
      args: {
        packageRoot: "/tmp/revision-source",
        outDir: "/tmp/revision-output",
        base: {
          packageId: "pkg_revision",
          motionId: "motion_revision",
          manifestSha256: "a".repeat(64),
          motionSha256: "b".repeat(64),
        },
        steps: [{
          command: "motion.timeline.layer.text.set",
          layerId: "title",
          text: "Atomic title",
          receiptsRoot: "/tmp/forbidden-host-receipts",
        }],
      },
    });
    expect(invalid.payload.error?.code).toBe("invalid_args");
    expect(invalid.payload.error?.detail).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ argument: "steps[0].receiptsRoot", kind: "unknown_property" }),
      ]),
    });

    const body = await rpc("tools/list", {}) as unknown as { result: { tools: Array<{ name: string; inputSchema: { properties: { args: { properties: Record<string, any> } } } }> } };
    const steps = body.result.tools.find((tool) => tool.name === "motion_revision_transaction")?.inputSchema.properties.args.properties.steps;
    expect(steps).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: { oneOf: expect.any(Array) },
    });
    expect(steps.items.oneOf).toHaveLength(10);
    expect(steps.items.oneOf.find((entry: any) => entry.properties.command?.enum?.[0] === "motion.timeline.layer.text.set"))
      .toMatchObject({ additionalProperties: false, required: ["command", "layerId", "text"] });
  }, 45_000);

  it("publishes a read-only closed revision-plan schema without output or receipt paths", async () => {
    const { callTool, rpc } = await mcpClient("read_motion");
    const invalid = await callTool("motion_revision_transaction_plan", {
      args: {
        packageRoot: "/tmp/revision-source",
        outDir: "/tmp/revision-output",
        base: {
          packageId: "pkg_revision",
          motionId: "motion_revision",
          manifestSha256: "a".repeat(64),
          motionSha256: "b".repeat(64),
        },
        steps: [{ command: "motion.timeline.layer.text.set", layerId: "title", text: "Planned title" }],
      },
    });
    expect(invalid.payload.error?.code).toBe("invalid_args");
    expect(invalid.payload.error?.detail).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ argument: "outDir", kind: "unknown_property" }),
      ]),
    });

    const body = await rpc("tools/list", {}) as unknown as { result: { tools: Array<{ name: string; inputSchema: { properties: { args: { additionalProperties: boolean; required: string[]; properties: Record<string, any> } } } }> } };
    const args = body.result.tools.find((tool) => tool.name === "motion_revision_transaction_plan")?.inputSchema.properties.args;
    expect(args).toMatchObject({
      additionalProperties: false,
      required: ["packageRoot", "base", "steps"],
      properties: {
        packageRoot: { type: "string", maxLength: 4096 },
        steps: { type: "array", minItems: 1, maxItems: 32, items: { oneOf: expect.any(Array) } },
      },
    });
    expect(args?.properties).not.toHaveProperty("outDir");
    expect(args?.properties).not.toHaveProperty("receiptsRoot");
  }, 45_000);

  it("still runs a valid call", async () => {
    const { callTool } = await mcpClient();

    const { payload, isError } = await callTool("motion_state", { args: {} });

    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    expect(payload.error).toBeUndefined();
  }, 45_000);

  it("accepts a published argument synonym for a required argument", async () => {
    // Several required arguments are satisfied by a declared alias — motion.template.plan publishes
    // `prompt` as "Alias for request" and the handler really reads
    // `stringArg(args, "request") ?? stringArg(args, "prompt")`. A validator that only knew the
    // canonical name would reject a call the dispatcher accepts, so both spellings must land in the
    // same place: past the schema, into the command.
    const { callTool } = await mcpClient();

    const viaAlias = await callTool("motion_template_plan", { args: { prompt: "lower third for a launch video" } });
    const viaCanonical = await callTool("motion_template_plan", { args: { request: "lower third for a launch video" } });

    // Both get the command's own answer (it wants a template root next), not a schema rejection.
    expect(viaAlias.payload.error?.message).toBe(viaCanonical.payload.error?.message);
    expect(viaAlias.payload.error?.message).not.toMatch(/required argument request is missing/);
    expect(viaAlias.payload.error?.message).not.toMatch(/not declared by this command/);
  }, 45_000);

  it("refuses the tool before the schema when the tier cannot run it at all", async () => {
    // Ordering guard: no argument fix helps an under-privileged caller, so permission still wins.
    const { callTool } = await mcpClient("read_motion");

    const { payload } = await callTool("motion_render_final", { args: { packageRoot: 5, outputPath: 7 } });

    expect(payload.error?.code).toBe("permission_denied");
  }, 45_000);

  it("catches the command's arguments being sent one level too high", async () => {
    // The most common MCP call-shape mistake: `arguments: { packageRoot }` instead of
    // `arguments: { args: { packageRoot } }`. It used to run with an empty argument set, which then
    // reported an unrelated missing argument and sent the agent hunting in the wrong place.
    const { callTool } = await mcpClient();

    const { payload } = await callTool("motion_state", { packageRoot: "/tmp/does-not-matter" });

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("invalid_args");
    expect(payload.error?.message).toMatch(/arguments\.packageRoot is not part of the call envelope/);
    expect(payload.error?.suggestedAction).toMatch(/Move packageRoot inside arguments\.args/);
  }, 45_000);

  it("publishes exactly the envelope keys it accepts", async () => {
    // The rule that made the argument schemas enforceable in the first place: what the listing
    // advertises and what the server accepts are one set. `tier` is accepted, so it is published.
    const { rpc } = await mcpClient();

    const body = await rpc("tools/list", {}) as unknown as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean } }> } };
    const tool = body.result.tools.find((entry) => entry.name === "motion_state");

    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["args", "requestedTier", "tier"]);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
  }, 45_000);
});
