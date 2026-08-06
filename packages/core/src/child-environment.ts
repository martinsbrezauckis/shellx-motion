/**
 * Build the environment a child process is allowed to see.
 *
 * Role: Motion spawns FFmpeg, FFprobe, Chromium, `cargo`, and agent CLIs. A child process must not
 * inherit `SHELLX_MOTION_DEBUG_TOKEN` — the Debug API's documented bearer credential. Any child
 * being trojaned or supply-chain-compromised could
 * reads `/proc/self/environ` and obtains authenticated control of the Debug API at the operator's
 * granted tier. The worst case is the agent lane, which merges `process.env` into a third-party LLM
 * CLI that *by design* executes model-authored commands.
 *
 * The rule here is DENY BY DEFAULT for anything that looks like a credential, rather than an
 * allowlist of permitted variable names. An allowlist is safer in principle and was rejected on
 * evidence: Chromium alone reads dozens of environment variables across platforms (display, session
 * bus, sandbox, locale, proxy, font config), FFmpeg honours several more, and a missing one fails at
 * render time on another machine. A name-shaped denylist cannot leak a secret it has not been
 * taught about — but it also cannot break a render, and the minimum safety requirement is
 * exactly this: "at minimum strip `SHELLX_MOTION_DEBUG_TOKEN` and any `*_TOKEN` / `*_SECRET` /
 * `*_KEY` before every spawn."
 *
 * Callers that genuinely need a variable a pattern would strip pass it explicitly through `extra`,
 * which is applied AFTER redaction — so handing a child a credential becomes a deliberate, greppable
 * act at the call site instead of the silent default.
 *
 * Dependencies: none. Primary callers: the FFmpeg/FFprobe lanes, the browser lane, the agent runtime,
 * the connectors' `cargo` invocation, and the job governor.
 */

/**
 * Variable-name shapes that never reach a child unless a caller names them explicitly.
 *
 * Matched case-insensitively against the whole name. Deliberately broad: a false positive costs a
 * caller one explicit `extra` entry, a false negative hands a live credential to a subprocess.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)TOKEN($|_)/i,
  /(^|_)SECRET($|_)/i,
  /(^|_)PASSWORD($|_)/i,
  /(^|_)PASSWD($|_)/i,
  /(^|_)API_?KEY($|_)/i,
  /(^|_)ACCESS_?KEY($|_)/i,
  /(^|_)PRIVATE_?KEY($|_)/i,
  /(^|_)CREDENTIALS?($|_)/i,
  /(^|_)AUTH($|_)/i,
  /(^|_)SESSION($|_)/i,
  /(^|_)COOKIE($|_)/i,
  /(^|_)BEARER($|_)/i,
  /(^|_)PAT($|_)/i,
  // Bare `*_KEY` last, so the more specific forms above read first. Catches `OPENAI_KEY`,
  // `ANTHROPIC_KEY` and the long tail of vendor spellings without enumerating vendors.
  /_KEY$/i,
  /^KEY$/i
];

/** Names stripped regardless of shape, because they are known credentials that do not match above. */
const ALWAYS_STRIP: ReadonlySet<string> = new Set([
  "SHELLX_MOTION_DEBUG_TOKEN",
  "npm_config__auth",
  "npm_config__authToken",
  "NODE_AUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
]);

/**
 * Whether a variable name looks like a credential and must not reach a child by default.
 *
 * Exported so a test can enumerate the rule, and so a caller can explain a deliberate exception.
 *
 * @param name An environment variable name.
 * @returns True when the name is withheld from child processes by default.
 */
export function isSecretEnvName(name: string): boolean {
  if (ALWAYS_STRIP.has(name)) return true;
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * The parent environment with credential-shaped variables removed, plus any explicit additions.
 *
 * @param options.extra Variables to set on the child AFTER redaction. A value here is passed through
 *        verbatim even if its name looks like a secret: that is the deliberate-exception path.
 * @param options.source Environment to redact. Defaults to `process.env`; injectable for tests.
 * @returns A new environment object. The input is never mutated.
 */
export function childEnvironment(options: {
  extra?: Record<string, string | undefined>;
  source?: NodeJS.ProcessEnv;
} = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvName(name)) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) continue;
    environment[name] = value;
  }
  return environment;
}
