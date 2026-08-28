/**
 * Test-only prompt runtimes for `@shellx-motion/prompt`.
 *
 * ROLE
 * ----
 * `createFakePromptRuntime` used to live in `src/index.ts` and was therefore an export of the
 * published `@shellx-motion/prompt` package, and the thing `--fake` on the CLI constructed. A
 * That violated the tool-provenance invariant: `prompt run … --fake` returned
 * `{"ok":true,…,"receipts":["agent-…","prompt-…"]}` — bytes indistinguishable from a real agent
 * run — without any agent executing, and neither `--help` nor the public docs mentioned the mode.
 * Manufactured evidence that wears production's trust shape is worse than an undocumented feature:
 * a host or an agent can present it as proof of work.
 *
 * The fix is placement, not deletion. Tests still need a runtime that does not shell out to a real
 * subscription CLI, so the constructor moved here: `*.test-support.ts` is this repo's non-shipping
 * source convention (`scripts/source-modules.mjs`), which means `scripts/build.mjs` never emits it,
 * `scripts/packed-files-gate.mjs` fails if it ever appears in a tarball, and
 * `scripts/shipping-imports-gate.mjs` fails if a shipping module imports it. A fake is now reachable
 * only by code that imports test scaffolding on purpose.
 *
 * The workspace `exports` map adds a `./test-support` subpath so sibling packages' suites can reach
 * it; `publishConfig.exports` deliberately does not carry that subpath, so the published package
 * exposes `.` alone.
 *
 * DEPENDENCIES: `@shellx-motion/agent-runtime` (the real runtime, driven by a scripted runner) and
 * the package's own public types.
 *
 * PRIMARY CALLERS: `packages/prompt/src/index.test.ts`, `packages/debug-api/src/index.test.ts`,
 * `packages/cli/src/main.test-support.ts`, and `scripts/prompt-smoke.ts` (a dev script, outside
 * every package's `src/`).
 */
import { createHash } from "node:crypto";
import { buildAgentRuntime, type AgentAdapter } from "@shellx-motion/agent-runtime";
import type { MotionPromptRuntime } from "./index";

/**
 * A prompt runtime whose agent CLI is a scripted stub rather than a subscription binary.
 *
 * The adapter is a normal `AgentAdapter`, so everything above it — planning, receipts, retention,
 * authoring-job assembly — runs exactly as it does in production; only the process at the bottom is
 * replaced. That is what makes it useful for tests and exactly what made it dangerous as a shipped
 * export: the output is real production output computed over a stubbed transcript.
 *
 * @returns a runtime whose `runPrompt` defaults `agentId` to `"fake"`.
 */
export function createFakePromptRuntime(): MotionPromptRuntime {
  const adapter: AgentAdapter = {
    id: "fake",
    label: "Fake Prompt Agent",
    transport: "local-cli",
    billing: "cli-subscription",
    // The stub consumes only the explicit stdin prompt and exposes no filesystem tools.
    // Keep tests behind the same fail-closed context declaration required in production.
    promptContextMode: "prompt-only",
    probeCommand: () => ({ executable: "shellx-motion-fake-agent", args: ["--version"], shell: false }),
    promptCommand: (input) => ({
      executable: "shellx-motion-fake-agent",
      args: ["run", "--json"],
      cwd: input.cwd,
      stdin: input.prompt,
      shell: false
    })
  };

  const runtime = buildAgentRuntime({
    adapters: [adapter],
    runner: async (command) => {
      if (command.args.includes("--version")) {
        return { exitCode: 0, stdout: "shellx-motion-fake-agent 0.0.0", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          accepted: true,
          source: "fake-agent",
          promptSha256: createHash("sha256").update(command.stdin ?? "", "utf8").digest("hex")
        }),
        stderr: ""
      };
    }
  });

  return {
    runPrompt: (input) => runtime.runPrompt({ ...input, agentId: input.agentId ?? "fake" })
  };
}
