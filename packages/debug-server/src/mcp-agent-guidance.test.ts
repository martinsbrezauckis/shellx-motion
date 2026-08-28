/**
 * The guidance surface, exercised the way a blind external agent reaches it: over MCP `tools/call`.
 *
 * These pin three defects found by driving Grok against a live Motion MCP server with no source
 * access. Each was reproduced on the wire before it was fixed, so each is asserted on the wire:
 *
 *  1. The canonical task was not covered by the guidance surface.
 *     `motion.actions.guide("create package with animated layers and render")` returned
 *     package.create + package.validate and nothing else, and
 *     `motion.actions.plan("create original animated package and render mp4")` returned only the
 *     render half. An agent following either stops at an empty scaffold or renders nothing.
 *  2. Refusals suggested an action the receiving agent cannot perform ("Retry with write_local
 *     permission"), which is worse than no suggestion because the agent retries it.
 *  3. `motion.actions.find` answered a reasonable query with a bare `null`.
 *
 * Unit tests over `planAction` would not have caught these the same way: the defect is what the
 * PUBLISHED TOOL returns, and for an agent-first product the tool surface is the product.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { startMotionDebugServer } from "./index";

const servers: Array<{ close: () => Promise<void> }> = [];
const RENDER_PACKAGE_ROOT = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface McpStructured {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; suggestedAction?: string; detail?: Record<string, unknown> };
}

async function mcpServer(grantedTier: "read_motion" | "write_local" = "read_motion") {
  const handle = await startMotionDebugServer({
    host: "127.0.0.1",
    port: 0,
    grantedTier,
    context: { renderPackageRoots: [RENDER_PACKAGE_ROOT] }
  });
  servers.push(handle);
  const rpc = async (method: string, params: unknown = {}): Promise<Record<string, any>> => {
    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.capabilityToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    return await response.json();
  };
  const tool = async (name: string, args: unknown = {}, requestedTier?: string): Promise<McpStructured> => {
    const body = await rpc("tools/call", { name, arguments: { ...(requestedTier ? { requestedTier } : {}), args } });
    return body.result.structuredContent as McpStructured;
  };
  return { rpc, tool };
}

function stepsOf(structured: McpStructured): string[] {
  const steps = (structured.result as { steps?: Array<{ call: string }> }).steps ?? [];
  return steps.map((step) => step.call);
}

describe("the guidance surface a blind agent binds to", () => {
  it("plans the whole authoring path for a create-and-render request, not only the render", async () => {
    const { tool } = await mcpServer();

    // The exact query that failed: it returned motion.render.final -> status -> receipts and
    // skipped authoring entirely, for a request that explicitly says "create".
    const plan = await tool("motion_actions_plan", { request: "create original animated package and render mp4" });
    const calls = stepsOf(plan);

    expect(plan.ok).toBe(true);
    // The falsifier, stated as an invariant rather than a fixed list: a plan for a request that
    // says "create" must contain an authoring step, whatever the pipeline grows into later.
    expect(calls).toContain("motion.package.create");
    expect(calls.some((call) => call.startsWith("motion.timeline."))).toBe(true);
    expect(calls).toContain("motion.render.final");
    // Authoring comes before the render it feeds.
    expect(calls.indexOf("motion.package.create")).toBeLessThan(calls.indexOf("motion.render.final"));
  }, 45_000);

  it("guides the same request through create, layers, animate, preview, render", async () => {
    const { tool } = await mcpServer();

    const guide = await tool("motion_actions_guide", { request: "create package with animated layers and render" });
    const calls = stepsOf(guide);

    expect(calls).toEqual([
      "motion.package.create",
      "motion.package.validate",
      "motion.state",
      "motion.timeline.layer.create",
      "motion.timeline.inspect",
      "motion.timeline.keyframe.upsert",
      "motion.preview.frame",
      "motion.render.final",
      "motion.render.status",
      "motion.receipts.read"
    ]);
    // Each step still carries its argument contract, so the pipeline is callable and not just readable.
    expect(guide.result?.argumentContractsResolved).toBe(calls.length);
    const workflow = guide.result?.workflow as { phases: Array<{ id: string; implied: boolean }> };
    expect(workflow.phases.map((phase) => phase.id)).toEqual(["create", "layers", "animate", "preview", "render"]);
  }, 45_000);

  it("leaves a single-action request on the single-action path", async () => {
    const { tool } = await mcpServer();

    // A narrow request must not be inflated into a ten-step pipeline: the workflow path is for
    // requests that name several phases, and over-triggering it would be its own defect.
    const plan = await tool("motion_actions_plan", { request: "change transition easing and preview it" });

    expect(plan.result?.workflow).toBeUndefined();
    expect(stepsOf(plan)).not.toContain("motion.package.create");
  }, 45_000);

  it("answers an unmatched query with the nearest actions instead of a bare null", async () => {
    const { tool } = await mcpServer();

    // "permission elevation" returned `result: null`. There IS no elevation action — that is the
    // honest answer — but null alone does not say so, and an agent cannot tell it apart from a
    // broken tool.
    const found = await tool("motion_actions_find", { request: "permission elevation" });

    expect(found.ok).toBe(true);
    expect(found.result?.matched).toBe(false);
    expect(found.result?.action).toBeNull();
    expect(String(found.result?.message)).toContain("No Motion action matches");
    expect((found.result?.nearest as unknown[]).length).toBeGreaterThan(0);
    expect(found.result?.suggestedActions).toEqual([
      { id: "panel", command: "motion.actions.panel", args: {} },
      { id: "plan", command: "motion.actions.plan", args: { request: "permission elevation" } }
    ]);
  }, 45_000);

  it("keeps a matched find answer readable at the top level", async () => {
    const { tool } = await mcpServer();

    // Hosts, the CLI and the MCP smoke test all read `result.id`. Gaining a `matched` discriminator
    // must not cost them that.
    const found = await tool("motion_actions_find", { request: "create new empty motion package" });

    expect(found.result?.id).toBe("motion.package.create");
    expect(found.result?.matched).toBe(true);
  }, 45_000);

  it("tells a refused caller what the HOST must change, never to retry with more permission", async () => {
    const { tool } = await mcpServer("read_motion");

    const denied = await tool("motion_render_final", { packageRoot: RENDER_PACKAGE_ROOT });

    expect(denied.error?.code).toBe("permission_denied");
    // The old suggestedAction was "Retry with render_motion permission." — an instruction with no
    // implementation on the receiving side. Retrying is exactly the wrong behaviour to suggest.
    expect(denied.error?.suggestedAction).not.toMatch(/^Retry with/);
    expect(denied.error?.suggestedAction).toContain("cannot raise its own permission tier");
    expect(denied.error?.suggestedAction).toContain("--tier render_motion --trusted-local-tier");
    expect(denied.error?.detail).toMatchObject({
      requiredTier: "render_motion",
      grantedTier: "read_motion",
      selfElevation: "unavailable",
      resolvedBy: "host_operator"
    });
  }, 45_000);

  it("says the same thing when the caller tries to escalate with requestedTier", async () => {
    const { rpc } = await mcpServer("read_motion");

    // The other half of the dead end: an agent told to "retry with write_local" reaches for
    // requestedTier and is refused at -32001, historically with no guidance at all.
    const body = await rpc("tools/call", {
      name: "motion_render_final",
      arguments: { requestedTier: "write_local", args: { packageRoot: RENDER_PACKAGE_ROOT } }
    });

    expect(body.error.code).toBe(-32001);
    expect(body.error.data.suggestedAction).toContain("the host operator must");
    expect(body.error.data.detail).toMatchObject({ selfElevation: "unavailable", grantedTier: "read_motion" });
  }, 45_000);

  it("names the trusted prompt roots when it refuses a cwd", async () => {
    const { tool } = await mcpServer("write_local");

    // Same class: "cwd must be inside a trusted prompt working root" with no list of roots leaves
    // an agent guessing paths until it gives up.
    const denied = await tool("motion_prompt_run", { request: "make a title card", cwd: "/definitely-not-trusted" });

    expect(denied.error?.code).toBe("invalid_args");
    expect(denied.error?.message).toContain("Trusted roots for this session:");
    expect(denied.error?.suggestedAction).toContain("the host operator must");
    expect((denied.error?.detail as { trustedRoots: string[] }).trustedRoots.length).toBeGreaterThan(0);
  }, 45_000);
});
