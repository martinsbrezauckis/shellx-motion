import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMotionSdk } from "./client";
import { renderCachePlanRequestError } from "./render-cache-plan-client";
import { createLocalMotionSdk } from "./local";
import type { MotionSdkOperation, MotionSdkTransportRequest } from "./types";

const tempRoots: string[] = [];
const input = { packageRoot: "/pkg", outputPath: "/out/frame.png", preset: "png-frame" };
const output = {
  schema: "shellx-motion/render-cache-plan@1" as const,
  observedAt: "2026-08-09T00:00:00.000Z",
  authorization: "none" as const,
  identity: { digest: "a".repeat(64), inputCategories: ["package_bytes", "resolved_render_plan"] as const },
  decision: { kind: "miss" as const, reason: "entry_absent" },
  checked: ["static_admission", "output_root", "identity_inputs", "entry_presence"],
  missOnlyChecks: [
    "output_root_materialization", "exclusive_fill_lock", "producer_and_tool_readiness", "script_provenance_resolution",
    "quality_execution", "receipt_artifact_descriptor_publication", "post_render_input_recheck",
  ],
  warnings: [],
};

afterEach(async () => await Promise.all(tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("SDK renderCachePlan", () => {
  it("uses the typed render_motion operation and rejects cache selectors before transport", async () => {
    let calls = 0;
    const sdk = createMotionSdk({
      async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
        calls += 1;
        expect(request.operation).toBe("renderCachePlan");
        return envelope(request, output) as never;
      },
    });

    const planned = await sdk.renderCachePlan(input);
    const unsafe = await sdk.renderCachePlan({ ...input, cacheRoot: "/cache" } as never);

    expect(planned).toMatchObject({ ok: true, output: { decision: { kind: "miss", reason: "entry_absent" }, authorization: "none" } });
    expect(unsafe).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toBe(1);
  });

  it("refuses GPU cache planning because its post-render identity is evidence only", async () => {
    let calls = 0;
    const sdk = createMotionSdk({
      async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
        calls += 1;
        return envelope(request, output) as never;
      },
    });

    const result = await sdk.renderCachePlan({ ...input, frameLane: "gpu" } as never);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("post-render identity is evidence only") },
    });
    expect(calls).toBe(0);
  });

  it("rejects leaked paths, invalid decision mappings, and accessor request fields", async () => {
    const leaked = await createMotionSdk({ async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
      return envelope(request, { ...output, sourcePath: "/private/out" }) as never;
    } }).renderCachePlan(input);
    const invalidDecision = await createMotionSdk({ async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
      return envelope(request, { ...output, decision: { kind: "miss", reason: "fill_busy" } }) as never;
    } }).renderCachePlan(input);
    let getterRead = false;
    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, "preset", { enumerable: true, get() { getterRead = true; return "png-frame"; } });

    expect(leaked).toMatchObject({ ok: false, error: { code: "invalid_transport_response" } });
    expect(invalidDecision).toMatchObject({ ok: false, error: { code: "invalid_transport_response" } });
    expect(renderCachePlanRequestError(accessor)).toContain("unsupported field");
    expect(getterRead).toBe(false);
  });

  it("keeps the local bridge non-mutating for an unmaterialized output root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-render-cache-plan-"));
    tempRoots.push(parent);
    const outputPath = join(parent, "not-created", "frame.png");

    const result = await createLocalMotionSdk().renderCachePlan({
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame",
    });

    expect(result).toMatchObject({ ok: true, output: { decision: { kind: "miss", reason: "output_root_unmaterialized" }, authorization: "none" } });
    await expect(pathExists(join(parent, "not-created"))).resolves.toBe(false);
  });
});

function envelope(request: MotionSdkTransportRequest, response: Record<string, unknown>) {
  return { schema: request.schema, operation: request.operation, requestId: request.requestId, cacheKey: request.cacheKey, ok: true, output: response };
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}
