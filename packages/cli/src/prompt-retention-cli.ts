import type { PromptRawRetentionPurpose, PromptRetentionInput } from "@shellx-motion/prompt";

export function promptRetentionFromCli(
  argv: string[]
): { ok: true; value: PromptRetentionInput } | { ok: false; error: { code: string; message: string } } {
  const retainRawRequest = argv.includes("--retain-raw-prompt");
  const deleteAfter = optionValue(argv, "--raw-prompt-delete-after");
  const purpose = optionValue(argv, "--raw-prompt-purpose");
  if (!retainRawRequest) {
    if (deleteAfter || purpose) {
      return {
        ok: false,
        error: {
          code: "invalid_prompt_retention",
          message: "--raw-prompt-delete-after and --raw-prompt-purpose require --retain-raw-prompt."
        }
      };
    }
    return { ok: true, value: { mode: "summary_only" } };
  }
  if (!deleteAfter) {
    return { ok: false, error: { code: "invalid_prompt_retention", message: "--retain-raw-prompt requires --raw-prompt-delete-after." } };
  }
  if (!isPromptRawRetentionPurpose(purpose)) {
    return {
      ok: false,
      error: {
        code: "invalid_prompt_retention",
        message: "--retain-raw-prompt requires --raw-prompt-purpose debugging or user_requested_replay."
      }
    };
  }
  return { ok: true, value: { mode: "raw_request", deleteAfter, purpose } };
}

function optionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isPromptRawRetentionPurpose(value: unknown): value is PromptRawRetentionPurpose {
  return value === "debugging" || value === "user_requested_replay";
}
