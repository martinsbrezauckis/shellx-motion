/** Fixed, host-configured MCP resources. No URI selects a package or receipt path. */
import { canonicalJson } from "@shellx-motion/core";
import type { MotionDebugResult } from "@shellx-motion/debug-api";

export const MOTION_AGENT_SNAPSHOT_RESOURCE_URI = "motion://shellx-motion/agent/snapshot";

export interface MotionAgentSnapshotResourceSource {
  packageRoot?: string;
  receiptsRoot?: string;
}

export function mcpResourceCapabilities(source: MotionAgentSnapshotResourceSource | undefined): Record<string, unknown> {
  return source ? { resources: { listChanged: false } } : {};
}

export function mcpResourceMethods(source: MotionAgentSnapshotResourceSource | undefined): string[] {
  return source ? ["resources/list", "resources/read"] : [];
}

export function mcpResourceList(source: MotionAgentSnapshotResourceSource): Record<string, unknown> {
  return {
    resources: [{
      uri: MOTION_AGENT_SNAPSHOT_RESOURCE_URI,
      name: "ShellX Motion agent snapshot",
      description: "Compact read-only ShellX Motion context. Uses only host-configured roots.",
      mimeType: "application/json"
    }]
  };
}

export async function readMcpResource(
  params: unknown,
  source: MotionAgentSnapshotResourceSource,
  readSnapshot: (input: { packageRoot?: string; receiptsRoot?: string }) => Promise<MotionDebugResult>
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string }> {
  if (!isExactReadParams(params)) return { ok: false, message: "resources/read requires the fixed Motion agent snapshot URI." };
  const snapshot = await readSnapshot(source);
  if (!snapshot.ok) return { ok: false, message: "Motion agent snapshot is unavailable from this host configuration." };
  return {
    ok: true,
    result: {
      contents: [{
        uri: MOTION_AGENT_SNAPSHOT_RESOURCE_URI,
        mimeType: "application/json",
        text: canonicalJson(snapshot.result)
      }]
    }
  };
}

function isExactReadParams(value: unknown): value is { uri: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  let uri: unknown;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "uri" && key !== "_meta")) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Resource selection must be data-only; do not invoke a caller-owned getter while checking it.
    if (!descriptor || !("value" in descriptor)) return false;
    if (key === "uri") uri = descriptor.value;
  }
  // MCP request metadata is transport metadata, not a resource selector. It is accepted and
  // ignored so modern clients can send their standard `_meta` block without creating a URI query
  // surface or a caller-selected path.
  return uri === MOTION_AGENT_SNAPSHOT_RESOURCE_URI;
}
