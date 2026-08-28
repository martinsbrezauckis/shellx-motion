/**
 * tool-environment.test-support.ts — make a suite, not the machine, decide which executables the
 * readiness probe resolves.
 *
 * ROLE
 * ----
 * Every readiness suite in this repository fakes the same seam: it injects an `FfmpegRunner` so no
 * real FFmpeg, FFprobe or browser is spawned, and answers per tool ("this machine has FFmpeg and no
 * browser"). But the runner is handed an EXECUTABLE PATH, not a tool name, and that path is chosen
 * by the real resolver reading the real machine — `SHELLX_MOTION_*`, then Playwright's cache, then
 * the well-known system installs. So each suite had to guess which tool a path belonged to, and all
 * three of them guessed with the same copied regex:
 *
 *     /^(chrome|chromium|google chrome)/i.test(basename)
 *
 * `/usr/bin/google-chrome` — the FIRST entry of `SYSTEM_BROWSER_CANDIDATES`, the path GitHub's
 * runner image carries, and the value Motion's own CI pins into `SHELLX_MOTION_BROWSER` — matches
 * none of those alternatives, because the last one is spelled with a space. The browser probe
 * therefore fell through to each suite's "not installed" default, and nine tests across three
 * packages failed on CI while passing on every workstation whose browser happened to be a
 * Playwright cache entry named `chrome`. The tests were right about the code; they were wrong about
 * the machine.
 *
 * WHAT THIS FIXES
 * ---------------
 * Guessing is the defect, not the regex. A suite that stubs a machine must also decide what that
 * machine HAS, so this pins all three tools to paths the suite itself created, through the product's
 * own documented override variables — the same escape hatch an operator with an unusual install
 * uses. Resolution then has one possible answer on every machine and every OS, the fake runner
 * matches the exact path it pinned instead of recognising a name, and an unexpected executable is a
 * loud error rather than a silent "that tool is missing".
 *
 * It also closes the reverse hole: a workstation with a STALE `SHELLX_MOTION_BROWSER` used to fail
 * these suites for a reason none of them was about, because an unusable pin short-circuits the probe
 * to `broken` before the injected runner is ever called.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * Nothing here fakes the probe's RESULT. Which tool is ready, missing or broken remains the suite's
 * business, expressed through its runner; this only fixes what the probe is looking at.
 *
 * DEPENDENCIES: `node:fs` / `node:os` / `node:path` and this package's browser override constant.
 *
 * PRIMARY CALLERS: `packages/renderer-ffmpeg/src/platform-requirements.test.ts`,
 * `packages/cli/src/doctor-command.test.ts`,
 * `packages/debug-server/src/workbench-readiness-contract.test.ts`. Reached through the workspace
 * `exports` subpath `@shellx-motion/core/test-support`, which `publishConfig.exports` deliberately
 * omits, so the published package still exposes `.` alone.
 */
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { MOTION_BROWSER_OVERRIDE_ENV_VAR } from "./browser-executable";
import type { MotionToolName } from "./receipts";

/** Every tool the platform probe resolves, in the order the probe reports them. */
export const MOTION_PINNABLE_TOOLS: readonly MotionToolName[] = ["ffmpeg", "ffprobe", "chromium"];

/**
 * The override variable that names each tool explicitly.
 *
 * The same three names `MOTION_TOOL_OVERRIDE_ENV_VAR` publishes in every readiness report — repeated
 * here rather than imported because `@shellx-motion/core` sits below `@shellx-motion/renderer-ffmpeg`
 * and must not import upwards. A rename that misses this copy is caught: the pin stops taking
 * effect, and the suites below fail on their first probe instead of quietly answering about the
 * machine again.
 */
const MOTION_TOOL_PIN_ENV_VAR: Record<MotionToolName, string> = {
  ffmpeg: "SHELLX_MOTION_FFMPEG",
  ffprobe: "SHELLX_MOTION_FFPROBE",
  chromium: MOTION_BROWSER_OVERRIDE_ENV_VAR
};

/** A suite's controlled tool environment, and the way back out of it. */
export interface MotionToolPins {
  /** The absolute path pinned for each tool: exactly what a probe resolves and a runner is handed. */
  readonly executable: Readonly<Record<MotionToolName, string>>;
  /**
   * Which tool an executable the runner was handed belongs to.
   *
   * @param executable The `command.executable` a fake `FfmpegRunner` received.
   * @returns The pinned tool, or null when the probe resolved something this suite did not pin —
   *   which means the pin is not in force and the answers that follow would describe the host.
   */
  toolFor(executable: string): MotionToolName | null;
  /** Restore the previous environment and remove the stub files. Idempotent. */
  release(): void;
}

/**
 * Pin FFmpeg, FFprobe and the browser to files this suite owns, for the duration of the suite.
 *
 * The files are created because the browser pin is validated before use: `SHELLX_MOTION_BROWSER`
 * naming a path with no file at it is an unusable pin, which reports `broken` WITHOUT calling the
 * runner. They are ordinary empty files, not executables — nothing spawns them, because the point of
 * pinning is that a fake runner answers instead.
 *
 * @param label Included in the temporary directory name so a leaked directory names its suite.
 * @returns The pinned paths, the executable->tool mapping a fake runner needs, and `release()`.
 *   Call `release()` from `afterAll`: the environment is process-wide.
 */
export function pinMotionToolExecutables(label: string): MotionToolPins {
  const directory = mkdtempSync(join(tmpdir(), `${label}-tools-`));
  const previous = new Map<string, string | undefined>();
  const executable = {} as Record<MotionToolName, string>;
  const byExecutable = new Map<string, MotionToolName>();

  for (const tool of MOTION_PINNABLE_TOOLS) {
    const path = join(directory, tool);
    writeFileSync(path, `stub for ${tool}: pinned by a test suite, never executed\n`);
    executable[tool] = path;
    byExecutable.set(path, tool);
    const variable = MOTION_TOOL_PIN_ENV_VAR[tool];
    previous.set(variable, process.env[variable]);
    process.env[variable] = path;
  }

  let released = false;
  return {
    executable,
    toolFor: (candidate) => byExecutable.get(candidate) ?? null,
    release: () => {
      if (released) return;
      released = true;
      for (const [variable, value] of previous) {
        if (value === undefined) delete process.env[variable];
        else process.env[variable] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Whether this test process can exercise a real atomic copy-on-write route rooted below `path`.
 *
 * Output admission verifies every existing POSIX ancestor before it creates a staging directory.
 * Tests that merely assume a managed sandbox has an unrelated owner accidentally convert a
 * host-specific fact into an assertion. This predicate mirrors that authority baseline so tests
 * can retain positive COW proof where it is available and separately construct an unsafe topology
 * when they need to prove refusal.
 */
export function hasAtomicCOWAuthority(path = process.cwd()): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  let current = resolve(path);
  for (;;) {
    let facts: ReturnType<typeof lstatSync>;
    try {
      facts = lstatSync(current);
    } catch {
      return false;
    }
    if (!facts.isDirectory() || facts.isSymbolicLink()) return false;
    if (facts.uid !== uid && facts.uid !== 0) return false;
    const mode = Number(facts.mode);
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) return false;
    if (current === parse(current).root) return true;
    current = dirname(current);
  }
}
