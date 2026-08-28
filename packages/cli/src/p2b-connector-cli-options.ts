/**
 * Closed P2B connector-delivery CLI admission.
 *
 * P2B is deliberately smaller than the legacy connector surface: it is one
 * Linux, no-clobber Browser-to-FFmpeg MP4 handoff.  Keep this check before the
 * host-job wrapper so a rejected request never creates a polling artifact.
 */
import { relative, resolve, sep } from "node:path";

const P2B_COMMANDS = new Set(["canvas-to-cut", "script-to-cut", "source-to-cut"]);

const BASE_OPTIONS = new Set(["--out", "--cut-import-mode", "--job-id", "--caller-id"]);
const SCRIPT_OPTIONS = new Set([...BASE_OPTIONS, "--start-ms", "--duration-ms", "--track"]);
const SOURCE_OPTIONS = new Set([
  ...BASE_OPTIONS,
  "--max-frames", "--maxFrames", "--frame-duration-ms", "--frameDurationMs", "--width", "--height", "--fps"
]);

export type P2bConnectorCliArgumentRefusal = Record<string, unknown> & {
  ok: false;
  command: "connector.canvas-to-cut" | "connector.script-to-cut" | "connector.source-to-cut";
  error: { code: "invalid_args" | "platform_inapplicable"; message: string };
};

/** Return a typed refusal only for P2B routes; other connector routes retain their contracts. */
export function p2bConnectorArgumentRefusal(argv: string[]): P2bConnectorCliArgumentRefusal | undefined {
  const subcommand = argv[0];
  if (!P2B_COMMANDS.has(subcommand ?? "")) return undefined;
  const command = `connector.${subcommand}` as P2bConnectorCliArgumentRefusal["command"];
  if (process.platform !== "linux") {
    return refusal(command, "platform_inapplicable", `connector ${subcommand} P2B is Linux-only Browser-to-FFmpeg rendered_media delivery.`);
  }
  if (!argv[1] || argv[1]!.startsWith("--")) return refusal(command, "invalid_args", `connector ${subcommand} requires an input path.`);
  if (!hasValue(argv, "--out")) return refusal(command, "invalid_args", "connector P2B requires an absent or empty --out directory.");


  const allowed = subcommand === "script-to-cut"
    ? SCRIPT_OPTIONS
    : subcommand === "source-to-cut"
      ? SOURCE_OPTIONS
      : BASE_OPTIONS;
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) return refusal(command, "invalid_args", `connector ${subcommand} P2B does not accept unexpected positional argument ${flag}.`);
    if (!allowed.has(flag)) {
      return refusal(command, "invalid_args", `connector ${subcommand} P2B does not accept ${flag}; it is Linux Browser-to-FFmpeg H.264 rendered_media delivery with an absent or empty --out.`);
    }
    if (count(argv, flag) !== 1) return refusal(command, "invalid_args", `connector ${subcommand} P2B accepts ${flag} at most once.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return refusal(command, "invalid_args", `${flag} requires a value.`);
    index += 1;
  }
  const inputPath = resolve(argv[1]!);
  const outDir = resolve(optionValue(argv, "--out")!);
  if (isInside(outDir, inputPath)) return refusal(command, "invalid_args", "connector P2B input must be outside its absent or empty --out delivery root.");
  const mode = optionValue(argv, "--cut-import-mode");
  if (mode !== undefined && mode !== "rendered_media") {
    return refusal(command, "invalid_args", `connector ${subcommand} P2B accepts only --cut-import-mode rendered_media.`);
  }
  if (argv.includes("--cut-import-mode") && mode === undefined) {
    return refusal(command, "invalid_args", "--cut-import-mode requires rendered_media.");
  }

  if (subcommand === "script-to-cut") {
    const start = numericOption(argv, "--start-ms");
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) return refusal(command, "invalid_args", "--start-ms must be a non-negative safe integer.");
    const duration = numericOption(argv, "--duration-ms");
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0)) return refusal(command, "invalid_args", "--duration-ms must be a positive safe integer.");
    if (argv.includes("--track") && !optionValue(argv, "--track")?.trim()) return refusal(command, "invalid_args", "--track must be a non-empty string.");
  }
  if (subcommand === "source-to-cut") {
    for (const aliases of [["--max-frames", "--maxFrames"], ["--frame-duration-ms", "--frameDurationMs"]] as const) {
      if (aliases.every((flag) => argv.includes(flag))) {
        return refusal(command, "invalid_args", `connector source-to-cut P2B accepts only one spelling of ${aliases.join(" or ")}.`);
      }
    }
    for (const flag of ["--max-frames", "--maxFrames", "--frame-duration-ms", "--frameDurationMs", "--width", "--height", "--fps"]) {
      const value = numericOption(argv, flag);
      if (argv.includes(flag) && (value === undefined || !Number.isSafeInteger(value) || value <= 0)) return refusal(command, "invalid_args", `${flag} must be a positive safe integer.`);
    }
  }
  return undefined;
}

/** P2B input paths are evidence, never public error text; legacy connector errors stay unchanged. */
export function redactP2bConnectorInputError(error: unknown, inputPath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return [...new Set([inputPath, resolve(inputPath)])].sort((left, right) => right.length - left.length).reduce(
    (text, path) => text.replaceAll(path, "[P2B input]"),
    message
  );
}

function hasValue(argv: string[], flag: string): boolean {
  const value = optionValue(argv, flag);
  return Boolean(value && !value.startsWith("--"));
}

function optionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function numericOption(argv: string[], flag: string): number | undefined {
  const value = optionValue(argv, flag);
  return value === undefined ? undefined : Number(value);
}

function count(argv: string[], flag: string): number {
  return argv.filter((value) => value === flag).length;
}

function isInside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !relation.includes(`${sep}..${sep}`));
}

function refusal(
  command: P2bConnectorCliArgumentRefusal["command"],
  code: P2bConnectorCliArgumentRefusal["error"]["code"],
  message: string
): P2bConnectorCliArgumentRefusal {
  return { ok: false, command, error: { code, message } };
}
