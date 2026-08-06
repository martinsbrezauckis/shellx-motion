/**
 * Coverage for `shellx-motion job`, and specifically for who is allowed to see whose work.
 *
 * Cross-caller visibility is one capability
 * with TWO transports, and it was enforced on only one of them. `motion.job` over the debug API
 * refused `scope: "all"` unless the host granted it, while the CLI honoured `--scope all` for anyone
 * who typed it. An agent embedded in one host could therefore enumerate every other host's job ids,
 * operations and receipt paths simply by shelling out — the boundary job-lease.ts documents,
 * bypassed by choosing a different transport.
 */
import { describe, expect, it } from "vitest";
import { jobCommand } from "./job-command";

/** A view that would happily answer, so a refusal can only come from the command's own gate. */
const permissiveView = {
  list: async () => [],
  get: async () => ({ ok: false as const, code: "job_unknown" as const })
};

describe("shellx-motion job --scope all", () => {
  it("refuses cross-caller scope when the host granted nothing", async () => {
    const result = await jobCommand(["list", "--scope", "all"], { jobView: permissiveView as never, env: {} });
    expect(result.ok).toBe(false);
    expect((result as unknown as { error: { code: string } }).error.code).toBe("permission_denied");
  });

  it("refuses on job get as well, not only on list", async () => {
    const result = await jobCommand(["get", "someone-elses-job", "--scope", "all"], { jobView: permissiveView as never, env: {} });
    expect(result.ok).toBe(false);
    expect((result as unknown as { error: { code: string } }).error.code).toBe("permission_denied");
  });

  it("allows it once the host set the grant", async () => {
    const result = await jobCommand(["list", "--scope", "all"], {
      jobView: permissiveView as never,
      env: { SHELLX_MOTION_JOB_CROSS_CALLER_SCOPE: "1" }
    });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("all");
  });

  it("leaves the default own-scope path working without any grant", async () => {
    const result = await jobCommand(["list"], { jobView: permissiveView as never, env: {} });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("own");
  });
});
