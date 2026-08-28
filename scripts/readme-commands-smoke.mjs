#!/usr/bin/env node
/**
 * scripts/readme-commands-smoke.mjs — a command the README documents must actually work here.
 *
 * ROLE
 * ----
 * Public command examples must not tell readers to run a binary that does not
 * exist. `packages/cli/package.json` publishes exactly one `bin`, `shellx-motion`, yet the skill,
 * the public docs and the CLI's own runtime output said `motion doctor`, `motion render`,
 * `motion job get`. Worse, the README's freshly written "verify the install" step used
 * `shellx-motion doctor`, which is right for an installed build and wrong for the source checkout
 * the same README tells you to build: inside this workspace nothing puts `shellx-motion` on `PATH`,
 * and `packages/cli/dist/main.js` does not run either because the workspace `exports` resolve back
 * to TypeScript source by design (see `scripts/verify-install.mjs`).
 *
 * Three different truths, and prose alone kept telling the wrong one. This gate removes the option:
 * the README's commands are extracted literally and executed against this checkout.
 *
 * WHAT IT CHECKS
 * --------------
 *   commands   every command in a ```bash fence in README.md either RUNS with exit code 0, is on an
 *              explicit not-executed list and is proved to NAME something real, or is an exact
 *              platform-inapplicable command from an explicitly labelled README block. A command
 *              the policy does not recognise fails the gate rather than being skipped quietly.
 *   spelling   no `motion <cli-verb>` shell spelling in README.md, `skill/**` or `docs/public/**`.
 *              Matches only where it reads as a command — line start, after a backtick, or after a
 *              `$ ` prompt — so ordinary prose ("motion blur", "a motion job") is untouched, and
 *              dotted Debug API / MCP ids (`motion.render.final`) are never touched at all.
 *
 * WHY FENCES ONLY, FOR THE RUN CHECK
 * ----------------------------------
 * The README documents BOTH invocation forms, so the installed form `shellx-motion <command>` has
 * to appear in it. The contract that keeps that honest is: fenced commands are the ones you can
 * paste into this checkout, and the installed form is stated in prose and tables instead. Anything
 * pasted into a fence must therefore work here — which is exactly what the regression asked for.
 *
 * THIS GATE RUNS UNTRUSTED TEXT
 * ------------------------------------------
 * The README is editable by any pull request, including one from a fork, and `docs:check` runs this
 * gate on every `push` AND every `pull_request` (`.github/workflows/verify.yml`). previously
 * the fence line was validated by PREFIX and then handed whole to a shell, so
 * `pnpm run typecheck && curl … | sh` in a README fence was arbitrary code execution on the runner.
 * Two rules close that, and both must hold for a command to be executed at all:
 *
 *   1. The line must parse into an argv of inert tokens — see `scripts/readme-command-tokenize.mjs`
 *      for the policy and for why refusing shell composition costs the documentation nothing.
 *   2. The PROGRAM is never taken from the README. Only `pnpm`, running a script this repository
 *      declares, is ever executed; a fence naming any other program is resolved (proved to exist)
 *      and deliberately not run.
 *
 * DEPENDENCIES: node built-ins only. No build step, no network. Executes only read-only CLI
 * commands (`doctor`, `validate`, `actions …`) which write nothing outside their own process.
 * CALLERS: `pnpm run docs:commands`, and `pnpm run docs:check` -> `pnpm test`.
 *
 * USAGE
 *   node scripts/readme-commands-smoke.mjs            # extract, resolve, run
 *   node scripts/readme-commands-smoke.mjs --list      # print the plan without running anything
 * Exit code: 0 when every documented command holds, 1 with the offending command otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeRefusal, tokenizeCommand } from "./readme-command-tokenize.mjs";
import { platformInapplicableReason } from "./readme-command-platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const LIST_ONLY = process.argv.includes("--list");
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * Commands that are documented but must not be executed by a gate, each with the reason and with
 * what proves them instead. Keyed by the exact command string as it appears in the README, so
 * editing the documented command forces a deliberate decision here rather than silently opting out.
 *
 * @type {Map<string, string>}
 */
const NOT_EXECUTED = new Map([
  ["pnpm install", "pnpm builtin; running it would rewrite node_modules underneath the caller"],
  ["pnpm build", "full workspace build, minutes; exercised by `pnpm run build:verify`"],
  ["pnpm test", "full public test contract; exercised directly by CI and public-export qualification"],
  ["pnpm start", "starts the long-lived human Workbench; its plan and installed bin are exercised by `pnpm run build:verify`"],
  [
    "pnpm --filter @shellx-motion/debug-server run serve -- --tier render_motion --trusted-local-tier",
    "starts a long-lived loopback server; exercised by `pnpm run debug-server:smoke`"
  ]
]);

/** CLI verbs that make `motion <verb>` read as a shell command rather than as prose. */
const CLI_VERBS = [
  "integration-capabilities", "validate", "inspect", "actions", "debug", "template", "agent",
  "prompt", "preview", "capture-browser", "package-create", "doctor", "job", "render",
  "html-snippet-import", "render-batch", "quality-check", "connector", "plan-import",
  "export-presets", "review-html-bundle", "html-snippet-export", "otio-export", "otio-import",
  "package-archive", "package-extract", "help"
];

/** Files the spelling check reads: everything an outside reader or agent is handed. */
const SPELLING_ROOTS = ["README.md", "skill", join("docs", "public")];

const failures = [];
const notes = [];

/**
 * Every command inside a ```bash fence of a markdown file, in document order.
 *
 * Comment-only lines and blank lines are dropped; trailing `\` continuations are joined so a
 * wrapped command is one command. Fences in any other language are ignored.
 *
 * @param {string} markdown
 * @returns {{ command: string, line: number }[]}
 */
export function extractFencedCommands(markdown) {
  const lines = markdown.split("\n");
  const commands = [];
  let inBash = false;
  let pending = "";
  let pendingLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const fence = /^```(\w*)/.exec(raw);
    if (fence) {
      inBash = !inBash && fence[1] === "bash";
      pending = "";
      continue;
    }
    if (!inBash) continue;
    const text = raw.trim();
    if (text === "" || text.startsWith("#")) continue;
    if (pending === "") pendingLine = i + 1;
    if (text.endsWith("\\")) {
      pending += `${text.slice(0, -1).trim()} `;
      continue;
    }
    commands.push({ command: `${pending}${text}`.replace(/\s+/g, " ").trim(), line: pendingLine });
    pending = "";
  }
  return commands;
}

/** Read a package.json, or `null` when it is absent. */
function readManifest(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The workspace package directory whose manifest declares `name`, or `null`. */
function findWorkspacePackage(name) {
  const packagesDir = join(ROOT, "packages");
  if (!existsSync(packagesDir)) return null;
  for (const entry of readdirSync(packagesDir)) {
    const dir = join(packagesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = readManifest(join(dir, "package.json"));
    if (manifest?.name === name) return { dir, manifest };
  }
  return null;
}

/**
 * Decide what a documented command is, prove the thing it names exists, and say whether — and as
 * exactly which argv — the gate may execute it.
 *
 * The command is TOKENISED FIRST. A line that does not parse into inert tokens is a
 * gate failure, not a line to be escaped: see `scripts/readme-command-tokenize.mjs`. Every shape
 * below is then matched on the resulting argv rather than by a regex over the raw line, so nothing
 * after the script name can be smuggled past a prefix match.
 *
 * Recognised shapes, in order:
 *   1. exact platform-inapplicable command          — only for the current host platform.
 *   2. `pnpm --filter <pkg> run <script> [-- args]` — the workspace package must declare `<script>`.
 *   3. `pnpm [run] <script> [args]`                 — the root manifest must declare `<script>`.
 *   4. `pnpm <builtin>`                             — only when listed in NOT_EXECUTED; `pnpm` must
 *                                                     be on `PATH`.
 *   5. anything else                                — a bare program, which must resolve on `PATH`.
 *      This is the shape that catches `shellx-motion doctor` and `motion doctor` in a source tree.
 *      It resolves but never executes: `exec` is null, because the program a README names is chosen
 *      by whoever edited the README.
 *
 * @param {string} command
 * @returns {{ ok: true, kind: string, detail: string, exec: { file: string, args: string[] } | null }
 *          | { ok: false, detail: string }}
 *          `exec` is the argv this gate is allowed to run, or null when the command resolves but is
 *          proved rather than executed.
 */
export function resolveCommand(command) {
  const tokens = tokenizeCommand(command);
  if (!tokens.ok) return { ok: false, detail: describeRefusal(command, tokens) };
  const argv = tokens.argv;

  const inapplicableReason = platformInapplicableReason(command);
  if (inapplicableReason !== null) {
    return {
      ok: true,
      kind: "platform-inapplicable",
      detail: inapplicableReason,
      exec: null
    };
  }

  if (argv[0] === "pnpm" && argv[1] === "--filter" && argv[3] === "run" && argv.length >= 5) {
    const packageName = argv[2];
    const script = argv[4];
    const found = findWorkspacePackage(packageName);
    if (!found) return { ok: false, detail: `no workspace package named ${packageName}` };
    if (!found.manifest.scripts?.[script]) {
      return { ok: false, detail: `${packageName} declares no "${script}" script` };
    }
    return {
      ok: true,
      kind: "workspace-script",
      detail: `${packageName} -> "${script}": ${found.manifest.scripts[script]}`,
      exec: { file: "pnpm", args: argv.slice(1) }
    };
  }

  if (argv[0] === "pnpm" && argv.length >= 2) {
    const script = argv[1] === "run" ? argv[2] : argv[1];
    const manifest = readManifest(join(ROOT, "package.json"));
    if (script !== undefined && manifest?.scripts?.[script]) {
      return {
        ok: true,
        kind: "root-script",
        detail: `root "${script}": ${manifest.scripts[script]}`,
        exec: { file: "pnpm", args: argv.slice(1) }
      };
    }
    if (NOT_EXECUTED.has(command)) {
      if (!programOnPath("pnpm")) return { ok: false, detail: "pnpm is not on PATH" };
      return { ok: true, kind: "pnpm-builtin", detail: `pnpm builtin "${script}"`, exec: null };
    }
    return { ok: false, detail: `the root package.json declares no "${script}" script` };
  }

  const program = argv[0];
  if (!programOnPath(program)) {
    return { ok: false, detail: `"${program}" is not on PATH in a source checkout` };
  }
  return { ok: true, kind: "path-program", detail: `"${program}" resolves on PATH`, exec: null };
}

/**
 * Whether `program` resolves as an executable on `PATH`.
 *
 * Asks the shell rather than walking PATH, so shell functions, aliases and version-manager shims
 * resolve exactly as they would for a reader pasting the command. The probe string is built from a
 * program name already read out of the README, never from caller input.
 *
 * THE PROBE IS PLATFORM-SPECIFIC, and it has to be. `command -v` is a POSIX shell builtin that does
 * not exist in cmd.exe, so on Windows this reported EVERY program as missing — the gate failed with
 * "pnpm is not on PATH" on a machine where pnpm was demonstrably running the gate. Caught on the
 * Windows rig ; the same shape as the path-separator bug found in job-status-lint the same
 * night, and it would have failed for any Windows contributor running `pnpm test`.
 *
 * `where` is the cmd.exe equivalent and exits non-zero when nothing matches, which is the same
 * contract `command -v` provides.
 *
 * THE NAME IS PASSED AS A POSITIONAL PARAMETER, NEVER INTERPOLATED. Building
 * `command -v ${JSON.stringify(program)}` and run it with `shell: true`. JSON quoting is not shell
 * quoting: inside the double quotes a POSIX shell still expands `$(…)`, so a README fence whose
 * first word was `x"$(id)"` executed `id` here. `sh -c '… "$1"' sh <program>` hands the value to
 * the shell as data, where no
 * quoting question can arise. The tokeniser already refuses such a program name; this makes the
 * probe safe on its own terms rather than by trusting its caller.
 */
function programOnPath(program) {
  const probe = process.platform === "win32"
    ? spawnSync("where", [program], { stdio: "pipe" })
    : spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", program], { stdio: "pipe" });
  return probe.status === 0;
}

/**
 * Run one documented command from the repository root.
 *
 * NO SHELL ON POSIX, WHICH IS WHERE CI RUNS: the argv comes from `resolveCommand`, whose `file` is
 * always the literal string "pnpm" and whose args are the tokens the README line parsed into, so
 * there is no string for a shell to re-interpret.
 *
 * WINDOWS KEEPS A SHELL, AND HAS TO. `pnpm` on Windows is `pnpm.CMD`, and since the fix for
 * CVE-2024-27980 Node refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL). The string
 * handed to cmd.exe there is the original fence line, which by that point `tokenizeCommand` has
 * proved contains no character cmd.exe acts on — no `%`, `^`, `!`, `&`, `|`, `<`, `>`, `(`, `)` and
 * no backtick or `$`. The shell is therefore given a line it cannot do anything with except run it.
 *
 * @param {string} command The fence line as written, used only on the Windows shell path.
 * @param {{ file: string, args: string[] }} exec The argv this command resolved to.
 * @returns {{ ok: boolean, detail: string }}
 */
function runCommand(command, exec) {
  const options = {
    cwd: ROOT,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    env: { ...process.env, CI: "1" }
  };
  const result = process.platform === "win32"
    ? spawnSync(command, { ...options, shell: true })
    : spawnSync(exec.file, exec.args, { ...options, shell: false });
  if (result.error) return { ok: false, detail: `${result.error.message}` };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split("\n").slice(-4).join(" | ");
    const stdout = (result.stdout ?? "").trim().split("\n").slice(-2).join(" | ");
    return { ok: false, detail: `exit ${result.status}: ${stderr || stdout || "(no output)"}` };
  }
  const tail = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "(no stdout)";
  return { ok: true, detail: tail.length > 120 ? `${tail.slice(0, 117)}…` : tail };
}

/** Every markdown file under a spelling root. */
function spellingFiles() {
  const files = [];
  for (const root of SPELLING_ROOTS) {
    const path = join(ROOT, root);
    if (!existsSync(path)) continue;
    if (statSync(path).isFile()) {
      files.push(path);
      continue;
    }
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const child = join(dir, entry);
        if (statSync(child).isDirectory()) walk(child);
        else if (child.endsWith(".md")) files.push(child);
      }
    };
    walk(path);
  }
  return files;
}

/**
 * Report every place `motion <verb>` is written where it reads as a shell command.
 *
 * Deliberately narrow: only at a line start, after a backtick, or after a `$ ` prompt. Prose such
 * as "motion blur" or "one motion job per render" is not a command and is left alone, and a dotted
 * id (`motion.render.final`) can never match because a `.` follows `motion`.
 *
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
export function findBareMotionCommands(text) {
  const pattern = new RegExp(String.raw`(?:^|\x60|\$ )motion +(?:${CLI_VERBS.join("|")})(?![-\w.])`, "gm");
  const hits = [];
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split("\n").length;
    hits.push({ line, text: match[0].replace(/^[\x60$] ?/, "") });
  }
  return hits;
}

// ---- commands ---------------------------------------------------------------------------------

const commands = extractFencedCommands(readFileSync(README, "utf8"));
const seen = new Set();
console.log(`readme-commands-smoke: ${commands.length} command(s) in bash fences of README.md\n`);

for (const { command, line } of commands) {
  if (seen.has(command)) {
    console.log(`  [SKIP] README.md:${line} ${command}\n         already checked above`);
    continue;
  }
  seen.add(command);
  const resolved = resolveCommand(command);
  if (!resolved.ok) {
    failures.push(`README.md:${line}  ${command}\n      ${resolved.detail}`);
    console.log(`  [FAIL] README.md:${line} ${command}\n         ${resolved.detail}`);
    continue;
  }
  if (resolved.kind === "platform-inapplicable") {
    console.log(`  [INAPPLICABLE] README.md:${line} ${command}\n         ${resolved.detail}`);
    notes.push(command);
    continue;
  }
  const reason = NOT_EXECUTED.get(command);
  if (reason) {
    console.log(`  [RESOLVED] README.md:${line} ${command}\n         ${resolved.detail}\n         not executed: ${reason}`);
    notes.push(command);
    continue;
  }
  if (resolved.exec === null) {
    // Resolved, deliberately not executed: the program is one the README names rather than one this
    // repository declares; the README must not choose an arbitrary executable for this gate.
    console.log(`  [RESOLVED] README.md:${line} ${command}\n         ${resolved.detail}\n` +
      "         not executed: only `pnpm` running a script this repository declares is run here");
    notes.push(command);
    continue;
  }
  if (LIST_ONLY) {
    console.log(`  [PLAN] README.md:${line} ${command}\n         ${resolved.detail}`);
    continue;
  }
  const run = runCommand(command, resolved.exec);
  console.log(`  [${run.ok ? "PASS" : "FAIL"}] README.md:${line} ${command}\n         ${run.detail}`);
  if (!run.ok) failures.push(`README.md:${line}  ${command}\n      ${run.detail}`);
}

// ---- spelling ---------------------------------------------------------------------------------

console.log("\nreadme-commands-smoke: `motion <verb>` shell spelling");
let spellingHits = 0;
for (const file of spellingFiles()) {
  for (const hit of findBareMotionCommands(readFileSync(file, "utf8"))) {
    spellingHits += 1;
    const where = `${relative(ROOT, file)}:${hit.line}`;
    failures.push(`${where}  "${hit.text}" — the published bin is \`shellx-motion\`; there is no \`motion\` binary`);
    console.log(`  [FAIL] ${where} "${hit.text}"`);
  }
}
if (spellingHits === 0) console.log("  [PASS] no `motion <verb>` shell spelling in README.md, skill/**, docs/public/**");

// ---- verdict ----------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nreadme-commands-smoke: FAIL — ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nA documented command must work in this checkout. In the source tree the CLI is\n" +
      "`pnpm --filter @shellx-motion/cli run cli -- <command>`; `shellx-motion <command>` is the\n" +
      "installed form and belongs in prose, not in a runnable fence."
  );
  process.exit(1);
}
console.log(`\nreadme-commands-smoke: PASS — every documented command resolves${LIST_ONLY ? "" : " and runs"}.`);
