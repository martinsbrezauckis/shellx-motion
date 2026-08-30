/**
 * report-redaction.ts — what may appear in a tool report a machine did not write.
 *
 * ROLE
 * ----
 * Every string in a `MotionToolReport` other than Motion's own prose comes from somewhere Motion
 * does not control: a version banner printed by a third-party binary, or a spawn error naming a
 * path on the operator's disk. The report is then returned by `motion.platform.requirements` to any
 * caller holding the LOWEST permission tier (`read_motion`), printed verbatim by
 * `shellx-motion doctor`, and rendered by every embedding host. Two things therefore have to be
 * true of those strings before they leave, and both were only half-true:
 *
 *   LEAK. `motionToolIdentity` reduces the resolved executable to a basename precisely because an
 *   absolute path names the user's home directory, their username and their install layout —
 *   and then `detail` published that same path verbatim, two fields later, out of the raw spawn
 *   error. A reduction one neighbouring field undoes is decoration.
 *
 *   SPOOF. The version line was bounded and secret-redacted but not control-stripped, so a banner
 *   containing `ESC[8m` renders the REST of the doctor report invisible in a terminal, and a bare
 *   `\r` overwrites the line already drawn. Content a report displays can rewrite what the report
 *   appears to say.
 *
 * Extracted from `platform-requirements.ts` so this answer has one home: that module owns the
 * readiness MODEL, and a redaction rule that lives inside it gets re-derived by the next field
 * someone adds.
 *
 * DEPENDENCIES / CALLERS
 * ----------------------
 * Nothing. Sole caller: `platform-requirements.ts`.
 */
import { sanitizeUntrustedDiagnostic, stripDiagnosticControls, takeUtf8Prefix } from "@shellx-motion/core";

/**
 * Maximum characters kept from a tool's version line.
 *
 * FFmpeg's first line is `ffmpeg version <build> Copyright (c) …` — the build string is the part
 * that distinguishes two installs, and it sits at the front. A cap keeps a pathological or
 * vendor-padded banner from becoming an unbounded field on every receipt.
 */
export const MOTION_TOOL_VERSION_MAX_CHARS = 160;
const MOTION_TOOL_VERSION_RAW_MAX_BYTES = 512;
const MOTION_TOOL_DETAIL_RAW_MAX_BYTES = 4 * 1024;

/**
 * Characters that must never survive into a printed report.
 *
 * Every string in a tool report is banner text from a program Motion did not write, and both the
 * CLI report and every host that renders these fields print it. `ESC` is the one that matters:
 * `ESC[8m` turns a terminal's output invisible and hides whatever the report says NEXT, so a
 * hostile or merely eccentric `--version` line could conceal the very rows a user is reading the
 * report to see. A bare `\r` is the cheap version of the same trick — it returns the cursor and
 * overwrites the line already drawn. C1 and the bidi/format controls (RLO and friends) are the
 * same class: they change what a reader sees without changing what the string contains.
 *
 * Stripped rather than escaped, because none of them carry meaning in a version banner.
 */
/** Cap on the raw probe error kept in `detail`. Bounded for the same reason a version line is. */
const MOTION_TOOL_DETAIL_MAX_CHARS = 400;

export function stripReportControlCharacters(value: string): string {
  return stripDiagnosticControls(takeUtf8Prefix(value, MOTION_TOOL_DETAIL_RAW_MAX_BYTES).value);
}

export function boundedVersion(version: string | undefined): string | undefined {
  const raw = takeUtf8Prefix(version ?? "", MOTION_TOOL_VERSION_RAW_MAX_BYTES);
  const lineEnd = firstReportLineEnd(raw.value);
  const line = raw.value.slice(0, lineEnd);
  const redacted = sanitizeUntrustedDiagnostic(line, {
    rawMaxBytes: MOTION_TOOL_VERSION_RAW_MAX_BYTES,
    publicMaxBytes: MOTION_TOOL_VERSION_MAX_CHARS,
    sourceTruncated: raw.truncated && lineEnd === raw.value.length
  }).trim();
  return redacted || undefined;
}

/**
 * Reduce a raw probe error to something safe to put in a shared report.
 *
 * `detail` carried the spawn error verbatim, which meant it re-published the absolute path —
 * home directory, username and all — that {@link motionToolIdentity} had just deliberately reduced
 * to a basename two fields earlier. The report is returned by `motion.platform.requirements` to any
 * agent holding the lowest permission tier and printed by `doctor --json`, so the two fields have
 * to redact to the same standard or the reduction is decorative.
 *
 * @param detail Raw stderr/error text from the probe.
 * @returns The same message with absolute paths replaced by `<path>`, control characters removed
 *   and length bounded. Undefined when nothing survives.
 */
export function redactedDetail(detail: string): string | undefined {
  const cleaned = sanitizeUntrustedDiagnostic(detail, {
    rawMaxBytes: MOTION_TOOL_DETAIL_RAW_MAX_BYTES,
    publicMaxBytes: MOTION_TOOL_DETAIL_MAX_CHARS,
    collapseWhitespace: true
  });
  return cleaned || undefined;
}

function firstReportLineEnd(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return index;
  }
  return value.length;
}
