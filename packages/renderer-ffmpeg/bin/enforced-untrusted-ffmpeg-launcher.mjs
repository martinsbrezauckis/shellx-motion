#!/usr/bin/env node
/**
 * Fixed, repository-owned executable for the internal enforced-untrusted FFmpeg/FFprobe runner.
 *
 * The trusted host supplies one bounded JSON config through an environment variable, which is
 * deleted here and cannot reach the parser past Bubblewrap --clearenv. A hash-pinned Node
 * executable starts this fixed launcher as its first script argument; the remaining argv starts
 * with a pinned FFmpeg/FFprobe executable followed verbatim by already-built parser argv. This
 * launcher has no shell, eval, package configuration, or final-output path input. Hash checks
 * attest trusted-host identity at this plan/launch boundary; they cannot protect a compromised
 * host or concurrent same-privilege file replacement.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const CONFIG_ENV = "SHELLX_MOTION_ENFORCED_FFMPEG_CONFIG";
const MAX_CONFIG_BYTES = 16_384;
const MAX_PARSER_ARGV = 1_025;
const MAX_PARSER_ARGV_BYTES = 65_536;
// Libraries plus the exact measured libblas alternatives directory only. Pinned FFmpeg/FFprobe
// directories are mounted separately; broad host configuration (/etc), application trees, and
// administrative binaries never enter the parser namespace by default.
const RUNTIME_ROOTS = ["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/etc/alternatives"];

const fail = (message) => {
  process.stderr.write(`ShellX Motion enforced-untrusted parser refusal: ${message}\n`);
  process.exit(125);
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rawConfig = process.env[CONFIG_ENV];
delete process.env[CONFIG_ENV];
const parserArgv = process.argv.slice(2);
if (!rawConfig || Buffer.byteLength(rawConfig, "utf8") > MAX_CONFIG_BYTES) fail("missing trusted launch configuration");
let config;
try { config = JSON.parse(rawConfig); } catch { fail("invalid trusted launch configuration"); }
if (!config || typeof config !== "object" || Array.isArray(config)) fail("invalid trusted launch configuration");
const configKeys = [
  "nodeExecutable", "nodeSha256",
  "launcherExecutable", "launcherSha256", "bubblewrapExecutable", "bubblewrapSha256",
  "ffmpegExecutable", "ffmpegSha256", "ffprobeExecutable", "ffprobeSha256", "packageRoot", "inputRoots", "stagingRoot"
];
if (Object.keys(config).length !== configKeys.length || configKeys.some((key) => !(key in config))) {
  fail("invalid trusted launch configuration fields");
}
for (const key of ["nodeExecutable", "nodeSha256", "launcherExecutable", "launcherSha256", "bubblewrapExecutable", "bubblewrapSha256", "ffmpegExecutable", "ffmpegSha256", "ffprobeExecutable", "ffprobeSha256", "packageRoot", "stagingRoot"]) {
  if (typeof config[key] !== "string" || config[key].includes("\0")) fail(`invalid trusted launch configuration field: ${key}`);
}
if (!Array.isArray(config.inputRoots) || config.inputRoots.length > 24 || config.inputRoots.some((value) => typeof value !== "string" || value.includes("\0"))) {
  fail("invalid trusted parser input roots");
}
for (const key of ["nodeExecutable", "launcherExecutable", "bubblewrapExecutable", "ffmpegExecutable", "ffprobeExecutable", "packageRoot", "stagingRoot"]) {
  if (!isAbsolute(config[key])) fail(`trusted launch path is not absolute: ${key}`);
}
if (config.inputRoots.some((value) => !isAbsolute(value))) fail("trusted parser input root is not absolute");
if (![config.nodeSha256, config.launcherSha256, config.bubblewrapSha256, config.ffmpegSha256, config.ffprobeSha256].every((value) => /^[a-f0-9]{64}$/.test(value))) {
  fail("trusted launch hash is invalid");
}
if (parserArgv.length < 1 || parserArgv.length > MAX_PARSER_ARGV || Buffer.byteLength(parserArgv.join("\0"), "utf8") > MAX_PARSER_ARGV_BYTES || parserArgv.some((arg) => arg.includes("\0"))) {
  fail("parser argv is invalid");
}

const canonical = (value, label) => {
  let resolved;
  try { resolved = realpathSync(value); } catch { fail(`${label} is unavailable`); }
  return resolved;
};
const regularFile = (value, label) => {
  let direct;
  try { direct = lstatSync(value); } catch { fail(`${label} is unavailable`); }
  if (direct.isSymbolicLink()) fail(`${label} is symlinked`);
  const resolved = canonical(value, label);
  let facts;
  try { facts = lstatSync(resolved); } catch { fail(`${label} is unavailable`); }
  if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o111) === 0) fail(`${label} is not a canonical executable file`);
  return resolved;
};
const directory = (value, label) => {
  let direct;
  try { direct = lstatSync(value); } catch { fail(`${label} is unavailable`); }
  if (direct.isSymbolicLink()) fail(`${label} is symlinked`);
  const resolved = canonical(value, label);
  let facts;
  try { facts = lstatSync(resolved); } catch { fail(`${label} is unavailable`); }
  if (!facts.isDirectory() || facts.isSymbolicLink()) fail(`${label} is not a canonical directory`);
  return resolved;
};
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const insideAny = (value, roots) => roots.some((root) => value === root || value.startsWith(`${root}/`));

const node = regularFile(process.execPath, "Node executable");
if (node !== config.nodeExecutable || sha256(node) !== config.nodeSha256) {
  fail("Node executable identity changed since the trusted launch plan");
}
const launcher = regularFile(process.argv[1] ?? "", "FFmpeg Bubblewrap launcher");
if (launcher !== config.launcherExecutable || sha256(launcher) !== config.launcherSha256) {
  fail("FFmpeg Bubblewrap launcher identity changed since the trusted launch plan");
}
const bubblewrap = regularFile(config.bubblewrapExecutable, "Bubblewrap executable");
if (sha256(bubblewrap) !== config.bubblewrapSha256) fail("Bubblewrap identity changed since its capability probe");
const ffmpeg = regularFile(config.ffmpegExecutable, "FFmpeg executable");
const ffprobe = regularFile(config.ffprobeExecutable, "FFprobe executable");
if (sha256(ffmpeg) !== config.ffmpegSha256 || sha256(ffprobe) !== config.ffprobeSha256) {
  fail("FFmpeg or FFprobe identity changed since the trusted launch plan");
}
const [requestedTool, ...toolArgs] = parserArgv;
const tool = requestedTool === ffmpeg ? ffmpeg : requestedTool === ffprobe ? ffprobe : undefined;
if (!tool) fail("parser executable is outside the pinned FFmpeg/FFprobe identities");
const packageRoot = directory(config.packageRoot, "Motion package root");
const inputRoots = [...new Set(config.inputRoots.map((value) => directory(value, "parser input root")))];
const stagingRoot = directory(config.stagingRoot, "job-owned staging root");
const stagingFacts = statSync(stagingRoot);
const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if ((currentUid !== undefined && stagingFacts.uid !== currentUid) || (stagingFacts.mode & 0o022) !== 0) {
  fail("job-owned staging root ownership or permissions changed since the trusted launch plan");
}
if (stagingRoot === "/" || stagingRoot === "/tmp" || ["/dev", "/proc", "/sys"].some((root) => stagingRoot === root || stagingRoot.startsWith(`${root}/`))) {
  fail("job-owned staging root replaces a namespace pseudo-filesystem or the private /tmp mount");
}
const toolRoots = [...new Set([dirname(ffmpeg), dirname(ffprobe)])];
const readOnlyRoots = [...new Set([...RUNTIME_ROOTS, packageRoot, ...inputRoots, ...toolRoots])];
if ([packageRoot, ...inputRoots].some((root) => insideAny(root, RUNTIME_ROOTS))) {
  fail("package or parser input root overlaps a fixed runtime mount");
}
if ([packageRoot, ...inputRoots].some((root) => toolRoots.some((toolRoot) => overlaps(root, toolRoot)))) {
  fail("package or parser input root overlaps a pinned FFmpeg/FFprobe tool root");
}
if (readOnlyRoots.some((root) => overlaps(stagingRoot, root))) {
  fail("job-owned staging root overlaps a read-only package, input, runtime, or tool root");
}

const args = [
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
  "--clearenv",
  // A namespace otherwise inherits the host mount tree. Start with a private empty root.
  "--tmpfs", "/",
  // This is namespace-local /tmp, not the host HOME directory.
  "--setenv", "HOME", "/tmp",
  "--setenv", "XDG_CACHE_HOME", "/tmp",
  "--setenv", "XDG_CONFIG_HOME", "/tmp",
  "--setenv", "XDG_RUNTIME_DIR", "/tmp",
  "--setenv", "LANG", "C",
  "--setenv", "LC_ALL", "C"
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
// Establish private /tmp before binding any explicit root below it. A later tmpfs mount would
// otherwise hide a safe host-approved input or staging directory whose canonical path is under /tmp.
ensureDirectory("/tmp");
args.push("--tmpfs", "/tmp");
for (const destination of RUNTIME_ROOTS) {
  if (!existsSync(destination)) continue;
  let source;
  try { source = realpathSync(destination); } catch { continue; }
  if (!lstatSync(source).isDirectory()) continue;
  mountReadOnly(source, destination);
}
for (const root of [...toolRoots, packageRoot, ...inputRoots]) {
  if (!coveredByReadOnlyMount(root)) mountReadOnly(root, root);
}
ensureDirectory(stagingRoot);
args.push("--bind", stagingRoot, stagingRoot);
ensureDirectory("/proc");
args.push("--proc", "/proc");
ensureDirectory("/dev");
args.push("--dev", "/dev");
args.push("--", tool, ...toolArgs);

let child;
try {
  child = spawn(bubblewrap, args, { shell: false, stdio: [0, 1, 2], windowsHide: true });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
