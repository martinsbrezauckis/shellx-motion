import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index.js";

const TOKEN = "template-root-transport-test-token-0000000000000000";
const TEMPLATE_ROOT = resolve("../../fixtures/packages");

async function debug(server: Awaited<ReturnType<typeof startMotionDebugServer>>, command: string, args: Record<string, unknown>) {
  const response = await fetch(new URL("/debug", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command, args })
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("server template-root caller boundary", () => {
  it("projects configured templateRoots to catalog/plan only", async () => {
    const server = await startMotionDebugServer({
      port: 0,
      grantedTier: "read_motion",
      capabilityToken: TOKEN,
      useDefaultTemplateRoots: false,
      templateRoots: [TEMPLATE_ROOT]
    });
    try {
      const catalog = await debug(server, "motion.template.catalog", { templateRoot: TEMPLATE_ROOT });
      expect(catalog).toMatchObject({ status: 200, body: { ok: true, result: { ok: true, templateCount: 2 } } });

      const plan = await debug(server, "motion.template.plan", {
        templateRoot: TEMPLATE_ROOT,
        request: "Create a lower third for Cut Generate"
      });
      expect(plan).toMatchObject({ status: 200, body: { ok: true, visibleState: { operation: "template.plan" } } });

      // The same server-owned template roots must not become package-browse roots.
      const browse = await debug(server, "motion.packages.browse", { root: TEMPLATE_ROOT });
      expect(browse).toMatchObject({ status: 403, body: { ok: false, error: { code: "render_path_not_approved" } } });
    } finally {
      await server.close();
    }
  });
});
