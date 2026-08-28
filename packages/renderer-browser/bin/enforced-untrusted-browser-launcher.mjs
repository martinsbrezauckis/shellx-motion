#!/usr/bin/env node
/**
 * Fixed, repository-owned launcher module for the enforced-untrusted browser host profile.
 *
 * It intentionally accepts no package or Debug/MCP configuration. The parent renderer supplies
 * exactly one bounded JSON object plus a PATH pinned to the trusted Node directory. The PATH makes
 * this conventional shebang resolve only the canonical Node executable whose path and hash the
 * launcher verifies. It deletes the configuration before Bubblewrap clears the entire environment
 * for Chromium. Chromium arguments arrive as this executable's argv and are forwarded verbatim
 * after the launcher has checked the policy-relevant flags and private profile path.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const fail = (message) => {
  process.stderr.write(`ShellX Motion enforced-untrusted browser refusal: ${message}\n`);
  process.exit(125);
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rawConfig = process.env.SHELLX_MOTION_ENFORCED_BROWSER_CONFIG;
delete process.env.SHELLX_MOTION_ENFORCED_BROWSER_CONFIG;
// argv[0] is the verified Node executable and argv[1] is this fixed launcher. No eval/program/page
// argument is accepted.
const browserArgs = process.argv.slice(2);
if (!rawConfig || rawConfig.length > 16_384) fail("missing trusted launch configuration");
let config;
try { config = JSON.parse(rawConfig); } catch { fail("invalid trusted launch configuration"); }
if (!config || typeof config !== "object" || Array.isArray(config)) fail("invalid trusted launch configuration");
const configKeys = [
  "launcherExecutable", "launcherSha256", "interpreterExecutable", "interpreterSha256",
  "bubblewrapExecutable", "bubblewrapSha256",
  "browserExecutable", "browserRoot", "packageRoot"
];
if (Object.keys(config).length !== configKeys.length || configKeys.some((key) => !(key in config))) {
  fail("invalid trusted launch configuration fields");
}
for (const key of configKeys) {
  if (typeof config[key] !== "string" || config[key].includes("\0")) fail(`invalid trusted launch configuration field: ${key}`);
}
for (const key of [
  "launcherExecutable", "interpreterExecutable", "bubblewrapExecutable", "browserExecutable", "browserRoot", "packageRoot"
]) {
  if (!isAbsolute(config[key])) fail(`trusted launch path is not absolute: ${key}`);
}
if (
  !/^[a-f0-9]{64}$/.test(config.launcherSha256)
  || !/^[a-f0-9]{64}$/.test(config.interpreterSha256)
  || !/^[a-f0-9]{64}$/.test(config.bubblewrapSha256)
) {
  fail("trusted launch hash is invalid");
}
const canonical = (value, label) => {
  let resolved;
  try { resolved = realpathSync(value); } catch { fail(`${label} is unavailable`); }
  return resolved;
};
const regularFile = (value, label) => {
  const resolved = canonical(value, label);
  let facts;
  try { facts = lstatSync(resolved); } catch { fail(`${label} is unavailable`); }
  if (!facts.isFile() || facts.isSymbolicLink()) fail(`${label} is not a canonical regular file`);
  return resolved;
};
const directory = (value, label) => {
  const resolved = canonical(value, label);
  let facts;
  try { facts = lstatSync(resolved); } catch { fail(`${label} is unavailable`); }
  if (!facts.isDirectory() || facts.isSymbolicLink()) fail(`${label} is not a canonical directory`);
  return resolved;
};
const launcher = regularFile(process.argv[1] ?? "", "Bubblewrap launcher");
if (launcher !== config.launcherExecutable || sha256(launcher) !== config.launcherSha256) {
  fail("Bubblewrap launcher identity changed since the trusted launch plan");
}
const interpreter = regularFile(process.execPath, "Node interpreter");
if (interpreter !== config.interpreterExecutable || sha256(interpreter) !== config.interpreterSha256) {
  fail("Node interpreter identity changed since the trusted launch plan");
}
const bubblewrap = regularFile(config.bubblewrapExecutable, "Bubblewrap executable");
if (sha256(bubblewrap) !== config.bubblewrapSha256) fail("Bubblewrap identity changed since its capability probe");
const browserExecutable = regularFile(config.browserExecutable, "Chromium executable");
const browserRoot = directory(config.browserRoot, "Chromium runtime root");
if (!(browserExecutable === browserRoot || browserExecutable.startsWith(`${browserRoot}/`))) {
  fail("Chromium executable escapes its trusted runtime root");
}
const packageRoot = directory(config.packageRoot, "Motion package root");
const runtimeRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
const insideAnyRoot = (path, roots) => roots.some((root) => path === root || path.startsWith(`${root}/`));
if (insideAnyRoot(packageRoot, runtimeRoots)) fail("Motion package root overlaps a fixed runtime mount");
if (browserArgs.some((arg) => !arg.startsWith("--"))) fail("Chromium argv may contain flags only");
if (browserArgs.includes("--no-sandbox")) fail("Chromium --no-sandbox is not allowed in enforced-untrusted mode");
const profileArgs = browserArgs.filter((arg) => arg.startsWith("--user-data-dir="));
if (profileArgs.length !== 1) fail("expected exactly one Playwright user-data directory");
const profileInput = profileArgs[0].slice("--user-data-dir=".length);
if (!isAbsolute(profileInput) || profileInput.includes("\0")) fail("Playwright user-data directory is not an absolute safe path");
let profileBefore;
try { profileBefore = lstatSync(profileInput); } catch { fail("Playwright user-data directory is unavailable"); }
if (!profileBefore.isDirectory() || profileBefore.isSymbolicLink()) fail("Playwright user-data directory is not a private directory");
const profile = directory(profileInput, "Playwright user-data directory");
const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
const profileFacts = statSync(profile);
if (currentUid !== undefined && profileFacts.uid !== currentUid) fail("Playwright user-data directory is not owned by this user");
if ((profileFacts.mode & 0o077) !== 0) fail("Playwright user-data directory must not grant group or world access");
if (insideAnyRoot(profile, runtimeRoots)) fail("Playwright user-data directory overlaps a fixed runtime mount");

const args = [
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
  "--clearenv",
  // A namespace alone inherits the host mount tree. Replace it before adding only approved mounts.
  "--tmpfs", "/",
  "--setenv", "HOME", profile,
  "--setenv", "XDG_CACHE_HOME", profile,
  "--setenv", "XDG_CONFIG_HOME", profile,
  "--setenv", "XDG_RUNTIME_DIR", profile,
  "--setenv", "PATH", "/usr/bin:/bin",
  "--setenv", "LANG", "C",
  "--setenv", "LC_ALL", "C",
];
const mountedReadOnlyDestinations = [];
const ensuredDirectories = new Set();
const ensureDirectory = (path) => {
  const chain = [];
  let cursor = path;
  while (cursor !== "/" && !ensuredDirectories.has(cursor)) { chain.push(cursor); cursor = dirname(cursor); }
  for (const entry of chain.reverse()) { args.push("--dir", entry); ensuredDirectories.add(entry); }
};
const mountReadOnly = (source, destination) => {
  ensureDirectory(destination);
  args.push("--ro-bind", source, destination);
  mountedReadOnlyDestinations.push(destination);
};
const coveredByReadOnlyMount = (path) => mountedReadOnlyDestinations.some((destination) => path === destination || path.startsWith(`${destination}/`));
for (const destination of runtimeRoots) {
  if (!existsSync(destination)) continue;
  let source;
  try { source = realpathSync(destination); } catch { continue; }
  if (!lstatSync(source).isDirectory()) continue;
  mountReadOnly(source, destination);
}
ensureDirectory("/tmp");
args.push("--tmpfs", "/tmp");
if (!coveredByReadOnlyMount(browserRoot)) mountReadOnly(browserRoot, browserRoot);
if (!coveredByReadOnlyMount(packageRoot)) mountReadOnly(packageRoot, packageRoot);
ensureDirectory(profile);
args.push("--bind", profile, profile);
ensureDirectory("/proc");
args.push("--proc", "/proc");
ensureDirectory("/dev");
args.push("--dev", "/dev");
args.push("--", browserExecutable, ...browserArgs);

const stdio = browserArgs.includes("--remote-debugging-pipe") ? [0, 1, 2, 3, 4] : [0, 1, 2];
let child;
try { child = spawn(bubblewrap, args, { shell: false, stdio, windowsHide: true }); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
