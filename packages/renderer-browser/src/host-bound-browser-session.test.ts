import { describe, expect, it, vi } from "vitest";
import { APPROVED_AGENT_SCRIPT_MODE, type AgentScriptProvenanceAuthority } from "@shellx-motion/core";
import {
  assertEnforcedBrowserDataOnly,
  bindHostBrowserSessionFactory,
  browserFrameRendererForSessionFactory
} from "./host-bound-browser-session";

describe("host-bound browser sessions", () => {
  it("binds only the host authority without replacing internal option identity", async () => {
    const authority = { resolverVersion: 1 } as AgentScriptProvenanceAuthority;
    const session = { renderFrame: vi.fn(), close: vi.fn() } as never;
    const create = vi.fn(async () => session);
    const factory = bindHostBrowserSessionFactory(create, authority);
    const options = {};

    await expect(factory({} as never, options)).resolves.toBe(session);
    expect(create).toHaveBeenCalledWith({}, options);
    expect(options).toHaveProperty("agentScriptAuthority", authority);
  });

  it("reuses one session for one frame call and always closes it", async () => {
    const result = { ok: true } as never;
    const session = { renderFrame: vi.fn(async () => result), close: vi.fn(async () => undefined) };
    const renderer = browserFrameRendererForSessionFactory(async () => session as never);

    await expect(renderer({} as never, { atMs: 0, outDir: "/tmp" })).resolves.toBe(result);
    expect(session.renderFrame).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("refuses own and inherited legacy publication fields before opening the host session", async () => {
    const sessionFactory = vi.fn(async () => ({ renderFrame: vi.fn(), close: vi.fn() }) as never);
    const renderer = browserFrameRendererForSessionFactory(sessionFactory);
    const forgedPublication = { stagingPath: "/private/forged.png" };
    const own = { atMs: 0, outDir: "/public", privateOutputPublication: forgedPublication };
    const inherited = Object.assign(
      Object.create({ privateArtifactPublication: forgedPublication }),
      { atMs: 0, outDir: "/public" }
    );

    await expect(renderer({} as never, own as never)).rejects.toThrow("renderer-minted capability");
    await expect(renderer({} as never, inherited as never)).rejects.toThrow("renderer-minted capability");
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("keeps enforced-untrusted execution data-only", () => {
    expect(() => assertEnforcedBrowserDataOnly({ activeMode: APPROVED_AGENT_SCRIPT_MODE } as never)).toThrow(
      "Enforced-untrusted browser execution remains data-only"
    );
    expect(() => assertEnforcedBrowserDataOnly({ activeMode: "data-only" } as never)).not.toThrow();
  });
});
