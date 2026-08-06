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

/**
 * Maximum characters kept from a tool's version line.
 *
 * FFmpeg's first line is `ffmpeg version <build> Copyright (c) …` — the build string is the part
 * that distinguishes two installs, and it sits at the front. A cap keeps a pathological or
 * vendor-padded banner from becoming an unbounded field on every receipt.
 */
export const MOTION_TOOL_VERSION_MAX_CHARS = 160;

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
const REPORT_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Whole ANSI escape sequences — CSI (`ESC[...m`), OSC (`ESC]...BEL`) and the two-character forms.
 *
 * Removing the ESC alone already disarms the sequence: what remains is inert printable text. This
 * runs FIRST anyway so the residue does not remain either, because `Chromium 141.0[8m` in a report
 * is a puzzle for whoever reads it. The ordering only matters in one direction — the blanket
 * REPORT_CONTROL_CHARACTERS pass afterwards is what makes any sequence shape this pattern does not
 * anticipate harmless regardless.
 */
const ANSI_ESCAPE_SEQUENCE = /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** Line terminators, including the two Unicode ones a `\r?\n` split silently keeps. */
const ANY_LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * Absolute filesystem paths, POSIX or Windows.
 *
 * Same shape `redactProbeReason` in `index.ts` already uses for the same reason: a path names the
 * user's home directory, their username and their install layout, and it is not diagnostically
 * useful in a field a host may display or forward.
 */
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?[\\/][^\s"']+/g;

/** Cap on the raw probe error kept in `detail`. Bounded for the same reason a version line is. */
const MOTION_TOOL_DETAIL_MAX_CHARS = 400;

export function stripReportControlCharacters(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, "").replace(REPORT_CONTROL_CHARACTERS, "");
}

export function boundedVersion(version: string | undefined): string | undefined {
  // Split on EVERY line terminator before stripping, so `\r\n` still ends the line and a lone `\r`
  // cannot be pulled onto it by the strip.
  const line = stripReportControlCharacters(version?.split(ANY_LINE_BREAK, 1)[0] ?? "").trim();
  if (!line) return undefined;
  const redacted = line.replace(/\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=(\S+)/g, (match) => `${match.split("=")[0]}=[redacted]`);
  return redacted.length > MOTION_TOOL_VERSION_MAX_CHARS
    ? `${redacted.slice(0, MOTION_TOOL_VERSION_MAX_CHARS - 1)}…`
    : redacted;
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
  const cleaned = stripReportControlCharacters(detail).replace(ABSOLUTE_PATH, "<path>").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > MOTION_TOOL_DETAIL_MAX_CHARS
    ? `${cleaned.slice(0, MOTION_TOOL_DETAIL_MAX_CHARS - 1)}…`
    : cleaned;
}

