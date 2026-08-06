export function isSupportedMotionColorString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isSupportedHexColorString(trimmed)) return true;
  if (/^(?:transparent|currentColor)$/i.test(trimmed)) return true;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[-0-9.%\s,/]+\s*\)$/i.test(trimmed)) return true;
  return SUPPORTED_NAMED_COLORS.has(trimmed.toLowerCase());
}

export function isSupportedHexColorString(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

/**
 * Every colour name Motion's renderers resolve.
 *
 * Exported, and deliberately not private, because a refusal has to be able to NAME them: CSS has
 * 148 named colours and Motion resolves 22 of them, so "midnightblue" is a reasonable guess that
 * this engine cannot draw. A message that says "unsupported colour" without the list leaves the
 * caller guessing which of the two vocabularies it is being held to.
 */
export const SUPPORTED_MOTION_COLOR_NAMES: readonly string[] = Object.freeze([
  "black",
  "white",
  "red",
  "green",
  "blue",
  "navy",
  "yellow",
  "cyan",
  "aqua",
  "magenta",
  "fuchsia",
  "gray",
  "grey",
  "silver",
  "maroon",
  "purple",
  "olive",
  "lime",
  "teal",
  "orange",
  "pink",
  "brown"
]);

const SUPPORTED_NAMED_COLORS = new Set(SUPPORTED_MOTION_COLOR_NAMES);

/**
 * The colour forms this engine accepts, as one sentence a refusal can end with.
 *
 * Built from the same list the check uses, so the advice cannot drift from the rule.
 */
export function supportedMotionColorAdvice(): string {
  return "hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba()/hsl()/hsla(), transparent, currentColor, "
    + `or one of these names: ${SUPPORTED_MOTION_COLOR_NAMES.join(", ")}`;
}
