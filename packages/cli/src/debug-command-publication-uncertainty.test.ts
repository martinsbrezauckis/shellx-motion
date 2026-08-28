import { afterEach, describe, expect, it, vi } from "vitest";

const debug = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("@shellx-motion/debug-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/debug-api")>(),
  dispatchDebugCommand: debug.dispatch
}));

import { runCli } from "./main.js";

afterEach(() => debug.dispatch.mockReset());

describe("debug CLI publication uncertainty", () => {
  it("keeps a Debug executor's authenticated possibly-committed evidence in the public CLI alias", async () => {
    debug.dispatch.mockResolvedValue({
      ok: false,
      error: {
        code: "publication_commit_uncertain",
        message: "final observation failed",
        detail: { possiblyCommitted: true, publicPaths: ["/governed/public/output"] }
      },
      result: { possiblyCommitted: true, publicPaths: ["/governed/public/output"] },
      warnings: []
    });

    await expect(runCli(["debug", "state"])).resolves.toMatchObject({
      ok: false,
      command: "debug.state",
      error: { code: "publication_commit_uncertain", detail: { possiblyCommitted: true, publicPaths: ["/governed/public/output"] } },
      result: { possiblyCommitted: true, publicPaths: ["/governed/public/output"] }
    });
  });
});
