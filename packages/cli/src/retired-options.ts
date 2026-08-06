/**
 * packages/cli/src/retired-options.ts — refuse options that have been removed, by name.
 *
 * ROLE
 * ----
 * `--fake` and `--adapter fake` used to construct stubbed agent/prompt runtimes inside the shipping
 * CLI. `prompt run "…" --fake` returned `{"ok":true,…,"receipts":["agent-…","prompt-…"]}` — bytes a
 * consumer cannot distinguish from a real subscription-agent run — while no agent executed, and
 * neither `--help` nor the public docs mentioned the mode. The runtimes
 * are gone; scripted ones now arrive through `RunCliOptions.promptRuntime` / `.agentRuntime`, which
 * only an embedder writing code can supply.
 *
 * WHY REFUSE RATHER THAN IGNORE
 * -----------------------------
 * Deleting the parsing alone would leave `--fake` as an unrecognised token. The CLI has no global
 * unknown-option rejection, and `--fake` is no longer in `VALUELESS_FLAGS`, so positional scanning
 * would treat the following token as its value — `--fake --tier edit_motion` would silently drop the
 * tier. Worse in principle: a script that still passes `--fake` would get a *real* agent run while
 * believing the run was simulated. That is the same class of mistaken trust the finding is about,
 * pointing the other way. A named refusal ends both.
 *
 * DEPENDENCIES: the `CliResult` shape from `./main` (type-only, so no runtime cycle).
 *
 * PRIMARY CALLER: `runCli` in `packages/cli/src/main.ts`, before any command dispatch, so every
 * surface — `prompt run`, `agent health`, `debug prompt-run`, `debug agent-health` — is covered by
 * one check rather than one per call site.
 */
import type { CliResult } from "./main";

/** A removed option, and the predicate that recognises it in argv. */
interface RetiredOption {
  /** How the option is spelled in the refusal message. */
  option: string;
  /** True when this argv still carries the removed option. */
  present: (argv: string[]) => boolean;
}

const RETIRED_OPTIONS: RetiredOption[] = [
  { option: "--fake", present: (argv) => argv.includes("--fake") },
  {
    option: "--adapter fake",
    present: (argv) => {
      const index = argv.indexOf("--adapter");
      return index >= 0 && argv[index + 1] === "fake";
    }
  }
];

/**
 * Refuse a retired simulation option instead of quietly ignoring it.
 *
 * @param argv normalised argv, command first
 * @returns a refusal `CliResult` when a retired option is present, otherwise `undefined` so the
 *   caller proceeds with normal dispatch
 */
export function retiredSimulationRefusal(argv: string[]): CliResult | undefined {
  const retired = RETIRED_OPTIONS.find((candidate) => candidate.present(argv));
  if (!retired) return undefined;
  return {
    ok: false,
    command: argv[0] ?? "shellx-motion",
    error: {
      code: "retired_option",
      message: `${retired.option} was removed: ShellX Motion has no simulated agent or prompt runtime. A result that carries an agent receipt came from an agent that ran.`,
      suggestedAction: "Use a real local CLI agent (check `shellx-motion agent health`). When embedding Motion, inject a runtime through RunCliOptions.promptRuntime or RunCliOptions.agentRuntime."
    },
    warnings: []
  };
}
