import type { CliResult } from "./main.js";

/** The shell CLI deliberately has no host provenance authority or authority selector. */
export function activeScriptCliRefusal(command: string): CliResult {
  return {
    ok: false,
    command,
    error: {
      code: "script_provenance_unresolved",
      message: `${command} cannot execute active web, html, or canvas layers because the shell CLI has no host-injected approved-agent-entry provenance authority.`
    }
  };
}
