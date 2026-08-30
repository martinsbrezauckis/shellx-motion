import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { workbenchChildEnvironment } from "./workbench-child-environment.js";
import { resolveWorkbenchSystemExecutable } from "./workbench-system-executable.js";

const execFileAsync = promisify(execFile);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const PRODUCER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface MotionUserAccessPaths {
  root: string;
  tokenFile: string;
  /** Private, per-server-start MCP bridge discovery record; never a durable bearer capability. */
  mcpBridgeDiscoveryFile: string;
  /** Private durable HMAC key for authenticating public render-reuse producer proofs. */
  renderReuseProducerKeyFile: string;
  /**
   * Where receipts land when nobody said otherwise. Its existence is what makes the Debug API's
   * caller-supplied `receiptsRoot` fence enforceable rather than fail-closed-on-everything: a fence
   * needs a trusted side, and before this the shipped server configured no receipt root at all, so a
   * caller's root was not merely preferred over the host's -- it was the only one there was.
   */
  receiptsRoot: string;
  /** Host-only private registry root for locally installed C1 effect modules. */
  effectModulesRoot: string;
}

export function motionUserAccessPaths(root = join(homedir(), ".shellx-motion")): MotionUserAccessPaths {
  return {
    root,
    tokenFile: join(root, "access.token"),
    mcpBridgeDiscoveryFile: join(root, "mcp-bridge.discovery.json"),
    renderReuseProducerKeyFile: join(root, "render-reuse-producer.key"),
    receiptsRoot: join(root, "receipts"),
    effectModulesRoot: join(root, "effect-modules")
  };
}

/**
 * Create the default receipt store, 0700 like everything else under the access root, and return it.
 *
 * Separate from {@link readOrCreatePersistentCapabilityFile} because receipts are needed on every
 * start, including the ephemeral-token path where no persistent access file is ever written.
 */
export async function ensureMotionReceiptsRoot(
  paths: MotionUserAccessPaths = motionUserAccessPaths()
): Promise<string> {
  await securePrivateDirectory(paths.root);
  await securePrivateDirectory(paths.receiptsRoot);
  return paths.receiptsRoot;
}

/** Create and return the private C1 effect-module registry root chosen by the installed host. */
export async function ensureMotionEffectModulesRoot(
  paths: MotionUserAccessPaths = motionUserAccessPaths()
): Promise<string> {
  await securePrivateDirectory(paths.root);
  await securePrivateDirectory(paths.effectModulesRoot);
  return paths.effectModulesRoot;
}

/** Read or create the installed host's private durable render-reuse producer key. */
export async function readOrCreateRenderReuseProducerKey(
  paths: MotionUserAccessPaths = motionUserAccessPaths()
): Promise<Buffer> {
  await securePrivateDirectory(paths.root);
  const existing = await readProducerKeyIfPresent(paths.renderReuseProducerKeyFile);
  if (existing) return existing;
  const key = randomBytes(32);
  try {
    await writeFile(paths.renderReuseProducerKeyFile, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const raced = await readProducerKeyIfPresent(paths.renderReuseProducerKeyFile);
    if (!raced) throw new Error("Motion render-reuse producer-key creation raced but no valid key became available.");
    return raced;
  }
  await securePrivateFile(paths.renderReuseProducerKeyFile);
  return key;
}

export async function readOrCreatePersistentCapabilityFile(
  paths: MotionUserAccessPaths = motionUserAccessPaths()
): Promise<{ token: string; tokenFile: string; created: boolean }> {
  await securePrivateDirectory(paths.root);
  const existing = await readCapabilityIfPresent(paths.tokenFile);
  if (existing) return { token: existing, tokenFile: paths.tokenFile, created: false };

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const raced = await readCapabilityIfPresent(paths.tokenFile);
    if (!raced) throw new Error("Motion access-key creation raced but no valid key became available.");
    return { token: raced, tokenFile: paths.tokenFile, created: false };
  }
  await securePrivateFile(paths.tokenFile);
  return { token, tokenFile: paths.tokenFile, created: true };
}

export interface MotionMcpBridgeDiscovery {
  port: number;
  /** Random for one bound debug-server instance; valid only for that listener. */
  credential: string;
}

/**
 * Publish the bridge credential only after its listener is bound.  Unlike the retired port-only
 * record, a stale record cannot authorize a bridge to disclose the durable access capability.
 */
export async function writeMotionMcpBridgeDiscovery(
  paths: MotionUserAccessPaths,
  discovery: MotionMcpBridgeDiscovery
): Promise<void> {
  assertMcpBridgeDiscovery(discovery);
  await securePrivateDirectory(paths.root);
  try {
    const existing = await lstat(paths.mcpBridgeDiscoveryFile);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Motion MCP bridge discovery state must be a private regular file, not a link or directory.");
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await writeFile(paths.mcpBridgeDiscoveryFile, `${JSON.stringify(discovery)}\n`, { encoding: "utf8", mode: 0o600 });
  await securePrivateFile(paths.mcpBridgeDiscoveryFile);
}

/** A stopped older server must never remove a newer listener's discovery record. */
export async function clearMotionMcpBridgeDiscovery(
  paths: MotionUserAccessPaths,
  expected: MotionMcpBridgeDiscovery
): Promise<void> {
  let raw: string;
  try {
    const metadata = await lstat(paths.mcpBridgeDiscoveryFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return;
    raw = await readFile(paths.mcpBridgeDiscoveryFile, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  let current: MotionMcpBridgeDiscovery;
  try {
    current = parseMcpBridgeDiscovery(raw);
  } catch {
    // A malformed/replaced record is not ours to delete. The bridge treats it as unavailable.
    return;
  }
  if (current.port === expected.port && secureTokenEqual(current.credential, expected.credential)) {
    await rm(paths.mcpBridgeDiscoveryFile, { force: true });
  }
}

export async function writeEphemeralCapabilityFile(capabilityToken: string): Promise<{ tokenRoot: string; tokenFile: string }> {
  assertCapabilityToken(capabilityToken);
  const tokenRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-"));
  const tokenFile = join(tokenRoot, "capability-token");
  try {
    await securePrivateDirectory(tokenRoot);
    await writeFile(tokenFile, `${capabilityToken}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await securePrivateFile(tokenFile);
    return { tokenRoot, tokenFile };
  } catch (error) {
    await rm(tokenRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Write the one-use Workbench bootstrap value into a private local HTML handoff.
 *
 * The OS opener receives only this non-secret `file:` URL. Once it has loaded, the document moves
 * the browser to the regular Workbench URL with the bootstrap fragment, whose existing page code
 * consumes and clears it before the authenticated network exchange. The server removes this root
 * after that one successful exchange (and the CLI removes it on opener failure or shutdown).
 */
export async function writeWorkbenchBootstrapHandoff(
  serverUrl: URL,
  bootstrapToken: string
): Promise<{ handoffRoot: string; handoffFile: string; handoffUrl: string }> {
  assertCapabilityToken(bootstrapToken);
  const workbenchUrl = new URL("/workbench", serverUrl);
  workbenchUrl.hash = new URLSearchParams({ bootstrap: bootstrapToken }).toString();
  const handoffRoot = await mkdtemp(join(tmpdir(), "shellx-motion-workbench-"));
  const handoffFile = join(handoffRoot, "launch.html");
  try {
    await securePrivateDirectory(handoffRoot);
    const document = `<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(workbenchUrl.toString())});</script>`;
    await writeFile(handoffFile, document, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await securePrivateFile(handoffFile);
    return { handoffRoot, handoffFile, handoffUrl: pathToFileURL(handoffFile).toString() };
  } catch (error) {
    await rm(handoffRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readCapabilityIfPresent(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Motion access key must be a private regular file, not a link or directory.");
    }
    const token = (await readFile(path, "utf8")).trim();
    assertCapabilityToken(token);
    await securePrivateFile(path);
    return token;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readProducerKeyIfPresent(path: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Motion render-reuse producer key must be a private regular file, not a link or directory.");
    }
    const encoded = (await readFile(path, "utf8")).trim();
    if (!PRODUCER_KEY_PATTERN.test(encoded)) throw new Error("Motion render-reuse producer key is invalid.");
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encoded) throw new Error("Motion render-reuse producer key is invalid.");
    await securePrivateFile(path);
    return key;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function assertCapabilityToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("Motion access keys must contain at least 32 URL-safe characters.");
  }
}

function assertMcpBridgeDiscovery(value: MotionMcpBridgeDiscovery): void {
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("Motion MCP bridge discovery requires a bound TCP port.");
  }
  assertCapabilityToken(value.credential);
}

function parseMcpBridgeDiscovery(raw: string): MotionMcpBridgeDiscovery {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Motion MCP bridge discovery is invalid.");
  }
  const value = parsed as Partial<MotionMcpBridgeDiscovery>;
  const discovery: MotionMcpBridgeDiscovery = { port: value.port as number, credential: value.credential as string };
  assertMcpBridgeDiscovery(discovery);
  return discovery;
}

function secureTokenEqual(actual: string, expected: string): boolean {
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function securePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Motion access storage must be a private directory, not a link or file.");
  }
  if (process.platform === "win32") {
    const userSid = await currentWindowsUserSid();
    await restrictWindowsCapabilityPath(path, userSid, true);
  } else {
    await chmod(path, 0o700);
  }
}

async function securePrivateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Motion access storage contains a non-regular file.");
  }
  if (process.platform === "win32") {
    const userSid = await currentWindowsUserSid();
    await restrictWindowsCapabilityPath(path, userSid, false);
  } else {
    await chmod(path, 0o600);
  }
}

async function currentWindowsUserSid(): Promise<string> {
  const executable = await resolveWorkbenchSystemExecutable("windows-whoami");
  const { stdout } = await execFileAsync(executable, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    env: workbenchChildEnvironment()
  });
  const sid = stdout.match(/S-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("Unable to resolve the current Windows user SID for access-key ACL hardening.");
  return sid;
}

async function restrictWindowsCapabilityPath(path: string, userSid: string, directory: boolean): Promise<void> {
  // Set-Acl can try to write audit-control metadata and require SeSecurityPrivilege.
  // Apply a newly constructed access-only descriptor through DirectoryInfo/FileInfo
  // instead: it replaces inherited and explicit DACL entries atomically while leaving
  // owner/audit metadata alone, so a reused path cannot retain a foreign explicit ACE.
  const securityType = directory ? "DirectorySecurity" : "FileSecurity";
  const itemType = directory ? "DirectoryInfo" : "FileInfo";
  const inheritance = directory ? "ContainerInherit,ObjectInherit" : "None";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = New-Object Security.Principal.SecurityIdentifier($env:SHELLX_MOTION_ACL_SID)",
    `$security = New-Object Security.AccessControl.${securityType}`,
    "$security.SetAccessRuleProtection($true, $false)",
    `$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow')`,
    "$security.AddAccessRule($rule) | Out-Null",
    `$item = New-Object IO.${itemType}($env:SHELLX_MOTION_ACL_PATH)`,
    "$item.SetAccessControl($security)"
  ].join("; ");
  const executable = await resolveWorkbenchSystemExecutable("windows-powershell");
  await execFileAsync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 32 * 1024,
    env: {
      ...workbenchChildEnvironment(),
      SHELLX_MOTION_ACL_PATH: path,
      SHELLX_MOTION_ACL_SID: userSid
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
