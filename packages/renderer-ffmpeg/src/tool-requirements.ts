/**
 * Telling a user that an external tool is missing, and how to get it.
 *
 * Role: Motion shells out to programs it does not ship — FFmpeg and FFprobe for the encode and the
 * readback, and a real Chrome/Chromium for the DEFAULT frame lane. When one is absent the
 * underlying failure is `spawn ffmpeg ENOENT` (or "No Chrome/Chromium executable found") — messages
 * that mean nothing to someone who has just installed Motion and does not know these are separate
 * prerequisites at all. ShellX Cut hit exactly this: new users concluded "nothing works" when the
 * only problem was a missing binary.
 *
 * So the diagnosis is separated from the raw error here, and every surface that can report such a
 * failure uses it: the CLI's `doctor` command, the render error path, and the
 * `motion.platform.requirements` debug command an agent can call.
 *
 * This module owns the per-tool WORDS — what a tool is needed for, what is lost without it, where
 * to get it. `platform-requirements.ts` owns the readiness MODEL — which operations need which
 * tools and by which route. Keeping them apart is what stops either file from becoming the place
 * every new tool's prose and every new operation's logic both land.
 *
 * The install commands are deliberately concrete per platform. "Install FFmpeg" is a better message
 * than ENOENT and still leaves the user to search; a command they can paste is the actual fix.
 *
 * Dependencies: `@shellx-motion/core` for the tool vocabulary, plus node:process — so this stays
 * usable from a failure path that must not itself fail. Primary callers: `checkFfmpeg` in index.ts,
 * the CLI doctor command, and the platform-requirements debug command.
 */
import type { MotionToolName } from "@shellx-motion/core";

export interface MotionToolInstallOption {
  /** Package manager or channel, e.g. "winget", "homebrew", "apt". */
  via: string;
  /** A command the user can paste verbatim. */
  command: string;
}

export interface MotionToolRequirement {
  tool: "ffmpeg" | "ffprobe";
  /** True when the tool was found and answered a version probe. */
  present: boolean;
  /** Version line, when present. */
  version?: string;
  /** The path or bare command Motion tried. */
  resolvedFrom: string;
  /** What Motion cannot do without it. */
  requiredFor: string;
  /** Plain-language statement of the problem, when absent. */
  problem?: string;
  installOptions: MotionToolInstallOption[];
  /** Where to download it directly, for a user without a package manager. */
  downloadUrl: string;
  /** How to point Motion at a copy that is already installed somewhere non-standard. */
  overrideEnvVar: string;
}

const DOWNLOAD_URL = "https://ffmpeg.org/download.html";
const CHROMIUM_DOWNLOAD_URL = "https://www.google.com/chrome/";

/** Where to get each tool by hand, for a user with no package manager. */
const TOOL_DOWNLOAD_URL: Record<MotionToolName, string> = {
  ffmpeg: DOWNLOAD_URL,
  ffprobe: DOWNLOAD_URL,
  chromium: CHROMIUM_DOWNLOAD_URL
};

/** The env var that pins an explicit executable for each tool. */
export const MOTION_TOOL_OVERRIDE_ENV_VAR: Record<MotionToolName, string> = {
  ffmpeg: "SHELLX_MOTION_FFMPEG",
  ffprobe: "SHELLX_MOTION_FFPROBE",
  chromium: "SHELLX_MOTION_BROWSER"
};

/**
 * The published prose form of "what does this tool buy me". Emitted alongside the machine-readable
 * `requiredForOperations`; neither is derived from the other's text.
 *
 * Each sentence names what is LOST and what still works, because a user reading a red line needs to
 * know whether to stop or to carry on with a different command. Chromium's sentence names the flag
 * outright: it is the only one of the three whose absence has a same-machine workaround.
 */
export const MOTION_TOOL_REQUIRED_FOR_TEXT: Record<MotionToolName, string> = {
  ffmpeg: "Encoding final video (`--lane ffmpeg`). Preview frames and the native lane work without it.",
  ffprobe: "Reading back encoded media for quality checks and media evidence. Encoding works without it.",
  chromium: "Rasterizing frames for the DEFAULT frame lane (`render --frame-lane browser`) and for"
    + " `preview --lane browser`. `render --frame-lane native` and the default native preview work without it."
};

/** Sentence naming what is lost when a tool is absent, and what still works. */
export const MOTION_TOOL_ABSENT_PROBLEM: Record<MotionToolName, string> = {
  ffmpeg: "FFmpeg is not installed, or is not on this machine's PATH. Motion needs it to encode video."
    + " Preview frames, the native lane and all authoring still work without it.",
  ffprobe: "FFprobe is not installed, or is not on this machine's PATH. Motion needs it to read back"
    + " what it encoded (container, streams, durations), so renders still produce media but"
    + " quality checks and media evidence cannot run.",
  // Motion depends on `playwright-core`, which — unlike `playwright` — downloads no browser, so a
  // clean install of Motion genuinely has none. Saying so is the difference between a user who runs
  // one install command and a user who files a bug against the renderer.
  chromium: "No Chrome/Chromium was found. Motion does not ship one: the default frame lane"
    + " rasterizes in a real browser, so `render` fails without it. Authoring, validation, the"
    + " default native preview and `render --frame-lane native` all still work."
};

/** Sentence for a tool that exists but did not answer, where "install it" is the wrong advice. */
export const MOTION_TOOL_BROKEN_PROBLEM: Record<MotionToolName, string> = {
  ffmpeg: "FFmpeg was found but did not answer a version probe. This is a broken or blocked install,"
    + " not a missing one — installing it again is unlikely to help.",
  ffprobe: "FFprobe was found but did not answer a version probe. This is a broken or blocked install,"
    + " not a missing one — installing it again is unlikely to help.",
  // The common shape on a minimal Linux container: the binary is present but its shared libraries
  // are not, so it exits before printing a version. Existence on disk alone would have called this
  // machine ready and let the render discover it instead.
  chromium: "A Chrome/Chromium executable was found but did not answer a version probe. This is a"
    + " broken or blocked install — often missing system libraries — not an absent browser, so"
    + " installing another copy is unlikely to help. `npx playwright-core install-deps chromium`"
    + " installs the libraries a downloaded Chromium needs."
};

/** Where to get one tool by hand. */
export function motionToolDownloadUrl(tool: MotionToolName): string {
  return TOOL_DOWNLOAD_URL[tool];
}

/**
 * Install commands for one tool on the platform Motion is running on.
 *
 * FFmpeg distributions ship FFprobe in the same package, so those two share guidance; Chromium is
 * its own product and gets its own. Per-tool rather than per-package because the whole point of the
 * doctor report is that a user pastes the line next to the tool that is actually red.
 */
export function motionToolInstallOptions(
  tool: MotionToolName,
  platform: NodeJS.Platform = process.platform
): MotionToolInstallOption[] {
  return tool === "chromium" ? chromiumInstallOptions(platform) : ffmpegInstallOptions(platform);
}

/**
 * How to get a Chrome/Chromium that Motion will actually find.
 *
 * `playwright-core install` leads on every platform, and not out of convenience: it is already a
 * dependency of this tree, it needs no elevation, and it downloads into the cache directory the
 * resolver in `@shellx-motion/core` searches SECOND — so the fix is guaranteed to be picked up. A
 * system package manager can put Chromium somewhere the well-known-paths list does not name, which
 * is why those options come after, and why `SHELLX_MOTION_BROWSER` exists at all.
 */
export function chromiumInstallOptions(platform: NodeJS.Platform = process.platform): MotionToolInstallOption[] {
  const playwright: MotionToolInstallOption = { via: "playwright (bundled)", command: "npx playwright-core install chromium" };
  if (platform === "win32") {
    return [
      playwright,
      { via: "winget", command: "winget install --id Google.Chrome -e" },
      { via: "chocolatey", command: "choco install googlechrome" }
    ];
  }
  if (platform === "darwin") {
    return [
      playwright,
      { via: "homebrew", command: "brew install --cask google-chrome" }
    ];
  }
  return [
    playwright,
    { via: "apt (Debian/Ubuntu)", command: "sudo apt install chromium-browser" },
    { via: "dnf (Fedora)", command: "sudo dnf install chromium" },
    { via: "pacman (Arch)", command: "sudo pacman -S chromium" }
  ];
}

/**
 * Install commands for the platform Motion is running on.
 *
 * Several are offered per platform because the one a user has is not knowable — a Windows user may
 * have winget or Chocolatey and neither is safe to assume.
 */
export function ffmpegInstallOptions(platform: NodeJS.Platform = process.platform): MotionToolInstallOption[] {
  if (platform === "win32") {
    return [
      { via: "winget", command: "winget install --id Gyan.FFmpeg -e" },
      { via: "chocolatey", command: "choco install ffmpeg" },
      { via: "scoop", command: "scoop install ffmpeg" }
    ];
  }
  if (platform === "darwin") {
    return [
      { via: "homebrew", command: "brew install ffmpeg" },
      { via: "macports", command: "sudo port install ffmpeg" }
    ];
  }
  return [
    { via: "apt (Debian/Ubuntu)", command: "sudo apt install ffmpeg" },
    { via: "dnf (Fedora)", command: "sudo dnf install ffmpeg" },
    { via: "pacman (Arch)", command: "sudo pacman -S ffmpeg" }
  ];
}

/**
 * A program that WAS found and started, but could not finish loading.
 *
 * This has to be tested BEFORE the absent test, and that ordering is the whole point. The canonical
 * shape of a downloaded Chromium on a minimal Linux container is
 *
 *     ./chrome: error while loading shared libraries: libnss3.so: cannot open shared object file:
 *     No such file or directory
 *
 * which contains "No such file or directory" and so matched {@link ffmpegLooksAbsent}'s
 * `/no such file/i`. The tool was then reported `missing`, and the user was told to install a
 * browser they already had — while the `broken` prose sitting right next to it in
 * {@link MOTION_TOOL_BROKEN_PROBLEM} named this exact case and offered the command that fixes it
 * (`npx playwright-core install-deps chromium`). The message existed; the classifier never reached
 * it.
 *
 * The patterns are loader diagnostics, not guesses: glibc's `ld.so` prints the first two and
 * `symbol lookup error`; macOS `dyld` prints the last two. None of them can be produced by a
 * program that does not exist, which is what makes them safe to test first.
 */
export function ffmpegLooksLikeBrokenLoad(rawError: string): boolean {
  return /error while loading shared libraries|cannot open shared object file|symbol lookup error|dyld(?:\[\d+\])?:|library not loaded|symbol not found/i
    .test(rawError);
}

/**
 * Whether a raw failure means the program is not installed at all.
 *
 * The distinction is load-bearing rather than cosmetic: `missing` sends the user to an installer,
 * `broken` tells them installing again will not help. A dynamic-loader failure is the second, and
 * {@link ffmpegLooksLikeBrokenLoad} takes precedence for it.
 */
export function ffmpegLooksAbsent(rawError: string): boolean {
  if (ffmpegLooksLikeBrokenLoad(rawError)) return false;
  return /ENOENT|command not found|not recognized|no such file/i.test(rawError);
}

export function ffmpegMissingMessage(rawError: string, executable: string): string {
  return `FFmpeg is not installed, or is not on this machine's PATH. Motion needs it to encode video (it was looking for "${executable}").`;
}

/** One line naming the fix, for the `suggestedAction` field every Motion error carries. */
export function ffmpegSuggestedAction(platform: NodeJS.Platform = process.platform): string {
  const first = ffmpegInstallOptions(platform)[0];
  return `Install FFmpeg (${first.via}: ${first.command}), or set SHELLX_MOTION_FFMPEG to an existing ffmpeg binary. Run \`shellx-motion doctor\` to re-check. Downloads: ${DOWNLOAD_URL}`;
}

/** Structured requirement detail for a UI that wants to render an install button. */
export function ffmpegRequirement(input: {
  present: boolean;
  version?: string;
  resolvedFrom: string;
  rawError?: string;
  platform?: NodeJS.Platform;
}): MotionToolRequirement {
  const platform = input.platform ?? process.platform;
  return {
    tool: "ffmpeg",
    present: input.present,
    ...(input.version ? { version: input.version } : {}),
    resolvedFrom: input.resolvedFrom,
    requiredFor: "Encoding final video (`--lane ffmpeg`). Preview frames and the native lane work without it.",
    ...(input.present ? {} : { problem: ffmpegMissingMessage(input.rawError ?? "", input.resolvedFrom) }),
    installOptions: ffmpegInstallOptions(platform),
    downloadUrl: DOWNLOAD_URL,
    overrideEnvVar: "SHELLX_MOTION_FFMPEG"
  };
}
