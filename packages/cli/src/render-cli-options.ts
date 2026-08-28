import type { CliResult } from "./main";

/**
 * `fps` belongs to a Motion package's authored timeline, not to a render request.
 *
 * The CLI dispatch applies this before its observable host-job wrapper, so rejection leaves no
 * pending job record and reaches neither package nor output work. Other commands retain their
 * own `--fps` contracts (for example, `package-create`).
 */
export function renderFpsArgumentRefusal(argv: string[]): CliResult | undefined {
  if (!argv.some((value) => value === "--fps" || value.startsWith("--fps="))) return undefined;
  return {
    ok: false,
    command: "render",
    error: {
      code: "invalid_args",
      message: "render does not accept --fps; it always uses the package's declared fps."
    }
  };
}
