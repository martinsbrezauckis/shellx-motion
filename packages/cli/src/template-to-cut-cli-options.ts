/**
 * Closed P2A Template-to-Cut CLI surface.
 *
 * This runs before the connector host-job wrapper: rejected content options must not leave an
 * observable job record. `--job-id` and `--caller-id` are the two host-observability exceptions.
 */
const ALLOWED_TEMPLATE_TO_CUT_OPTIONS = new Set([
  "--out", "--cut-import-mode", "--set", "--start-ms", "--duration-ms", "--track", "--job-id", "--caller-id"
]);

export type TemplateToCutCliArgumentRefusal = Record<string, unknown> & {
  ok: false;
  command: "connector.template-to-cut";
  error: { code: "invalid_args"; message: string };
};

export function templateToCutArgumentRefusal(argv: string[]): TemplateToCutCliArgumentRefusal | undefined {
  if (argv[0] !== "template-to-cut") return undefined;
  const unsupported = argv.slice(2).find((value) => value.startsWith("--") && !ALLOWED_TEMPLATE_TO_CUT_OPTIONS.has(value));
  if (unsupported) return refusal(`connector template-to-cut P2A does not accept ${unsupported}; it is Linux Browser-to-FFmpeg rendered_media only.`);
  const modeIndex = argv.indexOf("--cut-import-mode");
  if (modeIndex >= 0 && (!argv[modeIndex + 1] || argv[modeIndex + 1].startsWith("--"))) return refusal("--cut-import-mode requires rendered_media.");
  const cutImportMode = optionValue(argv, "--cut-import-mode");
  return cutImportMode === undefined || cutImportMode === "rendered_media"
    ? undefined
    : refusal("connector template-to-cut accepts only --cut-import-mode rendered_media in P2A.");
}

function optionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function refusal(message: string): TemplateToCutCliArgumentRefusal {
  return { ok: false, command: "connector.template-to-cut", error: { code: "invalid_args", message } };
}
