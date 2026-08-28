import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => ({ contexts: [] as Array<Record<string, unknown>> }));
vi.mock("@shellx-motion/debug-api", async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchCallerSteeredCommand: async (_command: unknown, _args: unknown, context: Record<string, unknown>) => {
    dispatch.contexts.push(context);
    return { ok: true as const, result: { ok: true }, warnings: [] };
  }
}));

import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

const TOKEN = "effect-module-preview-context-token-0000000000000000000";
const roots: string[] = [];
const servers: MotionDebugServerHandle[] = [];

afterEach(async () => {
  dispatch.contexts.splice(0);
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function dispatchRead(server: MotionDebugServerHandle): Promise<void> {
  const response = await globalThis.fetch(new URL("/debug", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "motion.actions.find", args: { request: "inspect motion" } })
  });
  expect(response.status).toBe(200);
}

describe("C2 effect-module preview context projection", () => {
  it("mints one opaque registry projection for central Debug dispatch and omits it without a registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-effect-module-preview-context-"));
    await chmod(root, 0o700);
    roots.push(root);
    const modulesRoot = join(root, "effect-modules");
    await mkdir(modulesRoot, { mode: 0o700 });
    const scratchRoot = join(root, "scratch");
    const withRegistry = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, effectModulesRoot: modulesRoot, context: { scratchRoot }, useDefaultTemplateRoots: false });
    servers.push(withRegistry);
    await dispatchRead(withRegistry);

    const projected = dispatch.contexts.at(-1)?.gpuEffectModuleUseAuthority;
    expect(projected).toBeDefined();
    expect(projected).not.toHaveProperty("list");
    expect(projected).not.toHaveProperty("inspect");
    expect(projected).not.toHaveProperty("revoke");
    expect(projected).not.toHaveProperty("close");
    expect(projected).not.toHaveProperty("stateRoot");
    expect(JSON.stringify(projected)).not.toContain(modulesRoot);

    const withoutRegistry = await startMotionDebugServer({ port: 0, capabilityToken: TOKEN, context: { scratchRoot }, useDefaultTemplateRoots: false });
    servers.push(withoutRegistry);
    await dispatchRead(withoutRegistry);
    expect(dispatch.contexts.at(-1)).not.toHaveProperty("gpuEffectModuleUseAuthority");
  });
});
