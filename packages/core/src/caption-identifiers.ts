/**
 * Compatibility-safe raw identifier ceiling shared by named imported cues and generated layers.
 * JavaScript strings count UTF-16 code units here, matching the legacy identifier boundary.
 */
export const DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH = 128;
/** Generated layer ids add `_` plus the legacy four-digit cue ordinal. */
export const CAPTION_LAYER_INDEX_SUFFIX_LENGTH = 5;
/** Raw layer prefixes reserve the generated cue ordinal separately from their own bound. */
export const MAX_CAPTION_LAYER_PREFIX_LENGTH = DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH - CAPTION_LAYER_INDEX_SUFFIX_LENGTH;

export interface CaptionIdentifierNormalizationOptions {
  /** Caller-facing name used in the bounded-input refusal. */
  label?: string;
  /** Raw UTF-16 code-unit ceiling, checked before any normalization work. */
  maxLength?: number;
}

/**
 * Preserve legacy trim, invalid-run collapse, underscore-edge strip, and fallback behaviour
 * without chaining regex passes over caller input. The raw bound is intentionally checked first.
 */
export function normalizeCaptionIdentifier(
  value: string,
  options: CaptionIdentifierNormalizationOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH;
  const label = options.label ?? "Caption identifier";
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH) {
    throw new Error(`${label} maxLength must be an integer from 1 to ${DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH}.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must contain at most ${maxLength} code units.`);
  }

  const trimmed = value.trim();
  const output: string[] = [];
  let firstNonUnderscore = -1;
  let lastNonUnderscore = -1;
  let pendingReplacement = false;

  const append = (character: string) => {
    output.push(character);
    if (character !== "_") {
      if (firstNonUnderscore === -1) firstNonUnderscore = output.length - 1;
      lastNonUnderscore = output.length - 1;
    }
  };

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (!isCaptionIdentifierCharacter(character)) {
      pendingReplacement = true;
      continue;
    }
    if (pendingReplacement) append("_");
    append(character);
    pendingReplacement = false;
  }

  return firstNonUnderscore === -1
    ? "caption"
    : output.slice(firstNonUnderscore, lastNonUnderscore + 1).join("");
}

function isCaptionIdentifierCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d
    || code === 0x5f;
}
