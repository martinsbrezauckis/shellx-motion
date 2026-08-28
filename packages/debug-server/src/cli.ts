#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEBUG_COMMAND_CONTRACTS, configureAttestedRenderReuseProducerAuthority } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerOptions } from "./index";
import { DEBUG_SERVER_TRANSPORT_MANIFEST, type MotionDebugServerTransportManifest } from "./debug-server-transport.js";
import {
  clearMotionServerPort,
  ensureMotionEffectModulesRoot,
  ensureMotionReceiptsRoot,
  motionUserAccessPaths,
  readOrCreatePersistentCapabilityFile,
  readOrCreateRenderReuseProducerKey,
  writeEphemeralCapabilityFile,
  writeWorkbenchBootstrapHandoff,
  writeMotionServerPort
} from "./user-access";
import { workbenchDesktopChildEnvironment } from "./workbench-child-environment.js";
import { resolveWorkbenchSystemExecutable } from "./workbench-system-executable.js";

type MotionPermissionTier = NonNullable<MotionDebugServerOptions["grantedTier"]>;

export type MotionDebugServerCliPlan =
  | {
      ok: true;
      command: "debug-server";
      dryRun: boolean;
      host: string;
      port: number;
      grantedTier: MotionPermissionTier;
      allowedHosts: string[];
      allowedOrigins: string[];
      artifactRoots: string[];
      templateRoots: string[];
      /** Host-owned roots for caller-steered package create and copy-on-write edit operations. */
      authoringInputRoots: string[];
      authoringOutputRoots: string[];
      /** Host-owned final/batch render authority; authenticated requests cannot add to it. */
      renderPackageRoots: string[];
      renderInputRoots: string[];
      renderOutputRoots: string[];
      persistentAccess: boolean;
      openWorkbench: boolean;
      transport: MotionDebugServerTransportManifest;
      contractCount: number;
    }
  | {
      ok: false;
      command: "debug-server";
      error: { code: "invalid_args"; message: string };
    };

export type { MotionDebugServerTransportManifest } from "./debug-server-transport.js";

const PERMISSION_TIERS = new Set<MotionPermissionTier>([
  "read_motion",
  "draft_motion",
  "render_motion",
  "edit_motion",
  "write_local",
  "push_remote"
]);
const execFileAsync = promisify(execFile);


export function planMotionDebugServerCli(argv: string[]): MotionDebugServerCliPlan {
  const portValue = optionValue(argv, "--port") ?? "0";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return invalidArgs("debug-server --port must be an integer from 0 to 65535.");
  }

  const tierValue = optionValue(argv, "--tier") ?? optionValue(argv, "--default-tier") ?? "read_motion";
  if (!PERMISSION_TIERS.has(tierValue as MotionPermissionTier)) {
    return invalidArgs("debug-server --tier must be a valid Motion permission tier.");
  }
  if (tierValue !== "read_motion" && !hasFlag(argv, "--trusted-local-tier")) {
    return invalidArgs("debug-server tiers above read_motion require --trusted-local-tier.");
  }
  if (tierValue === "push_remote" && !hasFlag(argv, "--allow-push-remote")) {
    return invalidArgs("debug-server push_remote requires --allow-push-remote.");
  }

  const host = optionValue(argv, "--host") ?? "127.0.0.1";
  // Keep refusing the retired flag rather than silently accepting a script that appears to ask for
  // broader exposure. Direct non-loopback binding is not a server mode.
  const requestedNonLoopback = hasFlag(argv, "--allow-non-loopback");
  const allowedHosts = optionValues(argv, "--allowed-host");
  if (!isLoopbackHost(host) || requestedNonLoopback) {
    return invalidArgs("debug-server direct non-loopback binding is disabled; bind loopback and use an authenticated HTTPS reverse proxy or SSH tunnel.");
  }

  return {
    ok: true,
    command: "debug-server",
    dryRun: hasFlag(argv, "--dry-run"),
    host,
    port,
    grantedTier: tierValue as MotionPermissionTier,
    allowedHosts,
    allowedOrigins: optionValues(argv, "--allowed-origin"),
    // Extra authenticated roots whose bounded image/poster artifacts the workbench may read.
    // Template roots remain available to agent catalog/reference commands and the
    // bounded poster endpoint even though the human Gallery is intentionally absent.
    artifactRoots: optionValues(argv, "--artifact-root"),
    templateRoots: optionValues(argv, "--template-root"),
    // These are a host launch policy, not a request parameter. Leaving either list empty keeps
    // caller-steered package create/edit unavailable while preserving read/render-only use.
    authoringInputRoots: optionValues(argv, "--authoring-input-root"),
    authoringOutputRoots: optionValues(argv, "--authoring-output-root"),
    renderPackageRoots: optionValues(argv, "--render-package-root"),
    renderInputRoots: optionValues(argv, "--render-input-root"),
    renderOutputRoots: optionValues(argv, "--render-output-root"),
    persistentAccess: hasFlag(argv, "--persistent-access"),
    openWorkbench: hasFlag(argv, "--open-workbench"),
    transport: DEBUG_SERVER_TRANSPORT_MANIFEST,
    contractCount: DEBUG_COMMAND_CONTRACTS.length
  };
}

export async function runMotionDebugServerCli(
  argv: string[] = process.argv.slice(2),
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  const plan = planMotionDebugServerCli(argv);
  if (!plan.ok) {
    io.stderr.write(`${JSON.stringify(plan)}\n`);
    return 1;
  }

  if (plan.dryRun) {
    io.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  }

  const configuredToken = process.env.SHELLX_MOTION_DEBUG_TOKEN;
  const accessPaths = motionUserAccessPaths(process.env.SHELLX_MOTION_ACCESS_ROOT?.trim() || undefined);
  const persistentAccess = !configuredToken && plan.persistentAccess
    ? await readOrCreatePersistentCapabilityFile(accessPaths)
    : null;
  const workbenchBootstrapToken = plan.openWorkbench ? randomBytes(32).toString("base64url") : null;
  // The trusted side of the receipts fence. Configured here, on every start, because the Debug API
  // refuses a caller-named receipts root that is not inside a root the HOST named -- and until this
  // existed the shipped server named none, so there was nothing for a caller's root to be checked
  // against. An operator who wants a different folder points the Workbench chooser at one, which
  // grants it for that session only.
  const receiptsRoot = await ensureMotionReceiptsRoot(accessPaths);
  const attestedRenderReuseProducerAuthority = configureAttestedRenderReuseProducerAuthority({ key: await readOrCreateRenderReuseProducerKey(accessPaths) });
  // This is installed-host authority, never a CLI argument or MotionDebugContext field.
  const effectModulesRoot = await ensureMotionEffectModulesRoot(accessPaths);
  let workbenchHandoffRoot: string | null = null;
  const removeWorkbenchHandoff = async (): Promise<void> => {
    const handoffRoot = workbenchHandoffRoot;
    workbenchHandoffRoot = null;
    if (handoffRoot) await rm(handoffRoot, { recursive: true, force: true });
  };
  const handle = await startMotionDebugServer({
    host: plan.host,
    port: plan.port,
    grantedTier: plan.grantedTier,
    context: {
      receiptsRoot,
      attestedRenderReuseProducerAuthority,
      ...(plan.authoringInputRoots.length > 0 ? { authoringInputRoots: plan.authoringInputRoots } : {}),
      ...(plan.authoringOutputRoots.length > 0 ? { authoringOutputRoots: plan.authoringOutputRoots } : {}),
      ...(plan.renderPackageRoots.length > 0 ? { renderPackageRoots: plan.renderPackageRoots } : {}),
      ...(plan.renderInputRoots.length > 0 ? { renderInputRoots: plan.renderInputRoots } : {}),
      ...(plan.renderOutputRoots.length > 0 ? { renderOutputRoots: plan.renderOutputRoots } : {})
    },
    effectModulesRoot,
    allowedHosts: plan.allowedHosts,
    allowedOrigins: plan.allowedOrigins,
    ...(plan.artifactRoots.length > 0 ? { artifactRoots: plan.artifactRoots } : {}),
    ...(plan.templateRoots.length > 0 ? { templateRoots: plan.templateRoots } : {}),
    updateAutoCheck: true,
    ...(configuredToken || persistentAccess ? { capabilityToken: configuredToken ?? persistentAccess!.token } : {}),
    ...(workbenchBootstrapToken
      ? { workbenchBootstrapToken, onWorkbenchBootstrapClaim: removeWorkbenchHandoff }
      : {})
  });
  let tokenRoot: string | null = null;
  let publishedPort: number | null = null;
  try {
    let tokenFile: string | undefined;
    if (!configuredToken && !persistentAccess) {
      const ephemeralToken = await writeEphemeralCapabilityFile(handle.capabilityToken);
      tokenRoot = ephemeralToken.tokenRoot;
      tokenFile = ephemeralToken.tokenFile;
    }
    if (persistentAccess) {
      publishedPort = Number(handle.url.port);
      await writeMotionServerPort(accessPaths, publishedPort);
    }
    io.stdout.write(`${JSON.stringify({
      ...plan,
      dryRun: false,
      url: handle.url.toString(),
      workbenchUrl: new URL("/workbench", handle.url).toString(),
      port: Number(handle.url.port),
      auth: configuredToken
        ? { source: "environment", env: "SHELLX_MOTION_DEBUG_TOKEN" }
        : persistentAccess
          ? { source: "persistent-file", tokenFile: persistentAccess.tokenFile, created: persistentAccess.created }
          : { source: "ephemeral-file", tokenFile }
    })}\n`);
    if (workbenchBootstrapToken) {
      try {
        const handoff = await writeWorkbenchBootstrapHandoff(handle.url, workbenchBootstrapToken);
        workbenchHandoffRoot = handoff.handoffRoot;
        await openWorkbenchInDefaultBrowser(handoff.handoffUrl);
      } catch (error) {
        await removeWorkbenchHandoff();
        io.stderr.write(`${JSON.stringify({
          ok: false,
          command: "open-workbench",
          error: {
            code: "browser_open_failed",
            message: error instanceof Error ? error.message : String(error)
          },
          workbenchUrl: new URL("/workbench", handle.url).toString()
        })}\n`);
      }
    }
    await waitForShutdown();
  } finally {
    await handle.close();
    await removeWorkbenchHandoff();
    if (publishedPort !== null) await clearMotionServerPort(accessPaths, publishedPort);
    if (tokenRoot) await rm(tokenRoot, { recursive: true, force: true });
  }
  return 0;
}

export { writeEphemeralCapabilityFile, writeWorkbenchBootstrapHandoff } from "./user-access";

/** The public Workbench entry point contains no bootstrap material. */
export function workbenchBootstrapUrl(serverUrl: URL): string {
  return new URL("/workbench", serverUrl).toString();
}

async function openWorkbenchInDefaultBrowser(url: string): Promise<void> {
  const executable = await resolveWorkbenchSystemExecutable("browser-opener");
  await execFileAsync(executable, [url], {
    encoding: "utf8",
    windowsHide: false,
    timeout: 10_000,
    // A human desktop opener may need the explicit X11 authority exception. The bootstrap secret
    // is inside the owner-only file URL, never in this helper's arguments or environment.
    env: workbenchDesktopChildEnvironment()
  });
}

function invalidArgs(message: string): MotionDebugServerCliPlan {
  return {
    ok: false,
    command: "debug-server",
    error: {
      code: "invalid_args",
      message
    }
  };
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function optionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

/**
 * True when this module is the process entry point, resolving symlinks on both sides.
 * npm bin shims are symlinks; pnpm writes real-path shims. Basename comparison silently
 * failed under npm/npx, so the entry never ran.
 */
function isDirectEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(moduleUrl) === argv1;
  }
}

// npm exposes a bin as a SYMLINK, so process.argv[1] stays .../node_modules/.bin/<name>
// while import.meta.url is realpath-resolved. Comparing basenames missed, and the CLI
// exited 0 having done nothing. Compare resolved real paths instead.
if (isDirectEntry(import.meta.url, process.argv[1])) {
  try {
    const code = await runMotionDebugServerCli();
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      command: "debug-server",
      error: {
        code: "debug_server_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    })}\n`);
    process.exitCode = 1;
  }
}
