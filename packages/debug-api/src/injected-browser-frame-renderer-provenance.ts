/** Internal wrapper that prevents an injected Debug renderer seam from becoming script authority. */
import {
  AgentScriptProvenanceRefusal,
  activeScriptLayers,
  type AgentScriptProvenanceAuthority,
} from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "./domains/integration-browser-workflow.js";

/**
 * Data-only packages retain the existing seam exactly. An active package is resolved to the
 * opaque authority's snapshot; resolver evidence replaces every renderer-provided script claim.
 * This module is internal to Debug API and is not a Debug/MCP/SDK/CLI selector.
 */
export function provenanceBoundInjectedBrowserFrameRenderer(
  renderer: BrowserFrameRenderer,
  authority: AgentScriptProvenanceAuthority | undefined
): BrowserFrameRenderer {
  return async (pkg, options) => {
    if (activeScriptLayers(pkg.motion).length === 0) return await renderer(pkg, options);
    if (!authority) {
      throw new AgentScriptProvenanceRefusal(
        "Active package scripts require a host-injected approved-agent-entry provenance authority."
      );
    }
    const resolved = await authority.resolve(pkg);
    try {
      const result = await renderer(resolved.package, options);
      return {
        ...result,
        output: {
          ...ownPlainDataRecord(result.output),
          scriptExecution: resolved.evidence
        },
        receipt: {
          ...result.receipt,
          output: {
            ...ownPlainDataRecord(result.receipt.output),
            scriptExecution: resolved.evidence
          }
        }
      } as typeof result;
    } finally {
      await resolved.release();
    }
  };
}

function ownPlainDataRecord(value: unknown): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return {};
    }
    return value as Record<string, unknown>;
  } catch {
    // A hostile proxy/getter is not renderer evidence; retain only resolver-owned evidence.
    return {};
  }
}
