/**
 * Antigravity (`agy`) local-CLI agent adapter.
 *
 * Role: declares the third-party Antigravity CLI as a Motion `local-cli` /
 * `cli-subscription` agent, in the same declarative shape as the Codex,
 * Claude Code, and Grok adapters in `./index.ts`.
 *
 * Dependencies: type-only import from `./index.ts` (erased at build time, so
 * there is no runtime import cycle even though `index.ts` imports the adapter
 * factory from this module).
 *
 * Primary callers: `createCliAgentAdapters()` in `./index.ts`, which is what
 * `buildAgentRuntime()` and therefore `shellx-motion agent health` /
 * `shellx-motion prompt run` consume.
 *
 * ---------------------------------------------------------------------------
 * Why this adapter is not just "grok with a different executable"
 * ---------------------------------------------------------------------------
 * Codex, Claude Code, and Grok are STDIN transports: the prompt is written to
 * the child's stdin and the argv is a fixed, prompt-independent flag list.
 * `agy` has no stdin prompt channel in non-interactive mode. The prompt is the
 * VALUE of the `--print` flag, so it travels in argv, and argv ORDER is part of
 * the contract (see the `--print`-last invariant below). `AgentCommand.stdin`
 * is optional precisely so an argv-carried prompt like this one is expressible;
 * this adapter leaves `stdin` unset.
 *
 * Verified against `agy` 1.1.8 and 1.1.9 during cross-host verification (the CLI self-updated
 * mid-session; both behaved identically for every flag used here). Facts that
 * are version-sensitive are called out inline so a future session re-checks
 * them with `agy --help` instead of trusting this comment.
 */

import type { AgentAdapter, AgentCommand, AgentPromptInput } from "./index";

/** Executable name. ShellX Cut registers the same binary as ("antigravity", "agy", "--version"). */
export const ANTIGRAVITY_EXECUTABLE = "agy";

/**
 * The non-interactive prompt flag. Its VALUE is the prompt, and nothing may
 * follow that value in argv — see `assertAntigravityPrintLast`.
 */
export const ANTIGRAVITY_PRINT_FLAG = "--print";

/**
 * Error code surfaced when `agy` exits 0 but writes nothing to stdout.
 *
 * Antigravity issue #76: `agy --print` has been reported to silently drop
 * stdout under a non-TTY pipe. A logged-out session can also surface this way,
 * because `agy` has no machine-readable auth-status command. Either way there
 * is NO response to report, and the log file carries no response text, so it
 * cannot be recovered. Motion returns this honest error instead of a success
 * envelope — a success envelope must correspond to real evidence.
 */
export const ANTIGRAVITY_EMPTY_OUTPUT_CODE = "agent_empty_output";

export const ANTIGRAVITY_EMPTY_OUTPUT_MESSAGE =
  "agy exited 0 without writing any stdout, so there is no agent response to report. "
  + "This is the known Antigravity CLI issue #76 (stdout dropped under a non-TTY pipe) "
  + "or a silent Antigravity auth failure. The --log-file sink carries diagnostics only, "
  + "never response text, so the response cannot be recovered.";

/**
 * Thrown when an argv would place anything after the `--print` prompt value.
 * Construction-time failure is deliberate: a corrupted prompt is silent and
 * would otherwise only show up as a confusing model response.
 */
export class AntigravityPrintOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityPrintOrderError";
  }
}

/**
 * Enforce the `--print`-last invariant.
 *
 * Why the invariant exists: ShellX Cut recorded the "antigravity.rs lesson" —
 * a flag placed after `--print` was swallowed into the prompt value. On `agy`
 * 1.1.8 that exact swallow no longer reproduces (a trailing UNKNOWN flag now
 * hard-errors with "flags provided but not defined", and a trailing bare
 * positional is dropped rather than appended — both verified). The
 * invariant is still enforced here because it is version-independent and free:
 * every observed behaviour of a trailing argument is either useless (dropped),
 * fatal (exit 2), or prompt-corrupting (the older swallow). Refusing to build
 * such an argv at all removes the entire class.
 *
 * @param args Full argv (excluding the executable).
 * @throws AntigravityPrintOrderError when `--print` is missing, repeated, or is
 *   not immediately followed by exactly one final element (its prompt value).
 */
export function assertAntigravityPrintLast(args: readonly string[]): void {
  const occurrences = args.filter((arg) => arg === ANTIGRAVITY_PRINT_FLAG).length;
  if (occurrences === 0) {
    throw new AntigravityPrintOrderError(
      `Antigravity argv must contain ${ANTIGRAVITY_PRINT_FLAG}; the prompt is that flag's value.`
    );
  }
  if (occurrences > 1) {
    throw new AntigravityPrintOrderError(
      `Antigravity argv must contain exactly one ${ANTIGRAVITY_PRINT_FLAG}; found ${occurrences}.`
    );
  }
  const flagIndex = args.indexOf(ANTIGRAVITY_PRINT_FLAG);
  if (flagIndex !== args.length - 2) {
    throw new AntigravityPrintOrderError(
      `${ANTIGRAVITY_PRINT_FLAG} must be the final flag and its prompt value the final argument; `
      + `found ${args.length - flagIndex - 2} argument(s) after the prompt.`
    );
  }
}

/**
 * Build the Antigravity prompt argv.
 *
 * Flag choices, each load-bearing:
 * - `--sandbox`             terminal-restricted execution. Motion deliberately
 *                           does NOT pass `--dangerously-skip-permissions`:
 *                           mutation authority in Motion comes from the caller's
 *                           `MotionPermissionTier`, not from an agent CLI's
 *                           auto-approve flag.
 * - `--mode plan`           provider-enforced proposal-only execution. The
 *                           sandbox limits terminal access; plan mode prevents
 *                           the provider from treating prompt text as authority
 *                           to mutate outside Motion's typed dispatcher.
 * - `--output-format json`  transport-level JSON envelope
 *                           (`{conversation_id, status, response, usage, ...}`),
 *                           which is the same rung the Codex (`exec --json`),
 *                           Claude Code (`--output-format json`), and Grok
 *                           (`--json`) adapters sit on. NOTE: this flag exists on
 *                           `agy` 1.1.8/1.1.9; it did NOT exist on the 1.0.x line that
 *                           ShellX Cut's Python judge adapter was written
 *                           against, which is why that adapter parses free text.
 *                           Re-verify with `agy --help` if the pinned version
 *                           ever moves backwards.
 * - `--add-dir <cwd>`       puts the working package directory in the agent's
 *                           workspace scope, so its file tools can read it.
 *                           Emitted only when a cwd is supplied.
 * - `--print <prompt>`      always last; see `assertAntigravityPrintLast`.
 *
 * `--log-file` is deliberately NOT passed, after being tried and reverted.
 * ShellX Cut passes it because `agy`'s noisy glog diagnostics can reach stdout
 * and corrupt the response channel. That did not reproduce here: with
 * `--output-format json` on 1.1.8/1.1.9, stdout carried only the envelope and
 * stderr was empty. The cost of passing it is permanent and paid on every run —
 * the flag value is an absolute path, and `motion.agent.panel` serialises this
 * argv by calling `promptCommand({ prompt: "" })` with no cwd, which would
 * publish the SERVER's working directory into a contract surface and into every
 * agent receipt. The cost of omitting it is a clean honest failure: stray glog
 * text on stdout fails the JSON parse and surfaces as `agent_invalid_output`,
 * never as a fabricated result. If a future `agy` regresses and pollutes
 * stdout, reinstate it with a path that does NOT vary by host.
 *
 * Keeping the argv free of ambient state also keeps this function pure, like
 * the other three adapters — the same (prompt, cwd) always yields the same argv.
 *
 * There is no `--system-prompt` flag on `agy`, so system rules must ride inside
 * the prompt value. Motion already composes a single prompt string upstream
 * (`createAgentPrompt` in `@shellx-motion/prompt`), so no extra folding is done
 * here — adding a second system preamble would duplicate it.
 *
 * `--model` is intentionally omitted so the Antigravity account default (which
 * is the vision-capable model) is used. `AgentPromptInput` carries no model
 * selector, so plumbing one would be unused surface.
 *
 * @param input Prompt text plus optional working directory.
 * @returns A frozen-argv `AgentCommand`. The argv is frozen so that an
 *   accidental `args.push(...)` in a future edit throws a TypeError under ESM
 *   strict mode instead of silently appending after the prompt value.
 */
export function antigravityCliCommand(input: AgentPromptInput): AgentCommand {
  const leading = [
    "--sandbox",
    "--mode",
    "plan",
    "--output-format",
    "json",
    ...(input.cwd ? ["--add-dir", input.cwd] : [])
  ];
  // The prompt value is appended here and nowhere else; the assertion below is
  // the guard that keeps that true if this list is ever extended.
  const args = [...leading, ANTIGRAVITY_PRINT_FLAG, input.prompt];
  assertAntigravityPrintLast(args);
  return {
    executable: ANTIGRAVITY_EXECUTABLE,
    args: Object.freeze(args) as string[],
    cwd: input.cwd,
    redactedArgIndexes: [args.length - 1],
    shell: false
  };
}

/** Probe argv. `agy --version` prints a bare semver line (e.g. `1.1.8`) and exits 0. */
export function antigravityProbeCommand(): AgentCommand {
  return { executable: ANTIGRAVITY_EXECUTABLE, args: ["--version"], shell: false };
}

/** The Antigravity adapter as registered in `createCliAgentAdapters()`. */
export function antigravityAdapter(): AgentAdapter {
  return {
    id: "antigravity",
    label: "Antigravity CLI",
    transport: "local-cli",
    billing: "cli-subscription",
    probeCommand: antigravityProbeCommand,
    promptCommand: antigravityCliCommand,
    setup: {
      installHint: "Install the Antigravity CLI and ensure agy is on PATH (the binary is agy, not antigravity).",
      authHint:
        "Sign in to Antigravity locally before running Motion prompts. agy exposes no auth-status command, "
        + "so a logged-out session surfaces at prompt time as a failed run or empty stdout, never as a fake result.",
      quotaHint: "Check Antigravity CLI subscription limits or retry after the provider limit resets."
    },
    // Issue #76 / silent-auth-failure handling. Declared per-adapter so the
    // existing adapters keep their current generic behaviour unchanged.
    emptyOutputDiagnosis: () => ({
      code: ANTIGRAVITY_EMPTY_OUTPUT_CODE,
      message: ANTIGRAVITY_EMPTY_OUTPUT_MESSAGE
    })
  };
}
