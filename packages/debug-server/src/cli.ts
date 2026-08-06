#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerOptions } from "./index";
import {
  clearMotionServerPort,
  ensureMotionReceiptsRoot,
  motionUserAccessPaths,
  readOrCreatePersistentCapabilityFile,
  writeEphemeralCapabilityFile,
  writeMotionServerPort
} from "./user-access";

type MotionPermissionTier = NonNullable<MotionDebugServerOptions["grantedTier"]>;

export type MotionDebugServerCliPlan =
  | {
      ok: true;
      command: "debug-server";
      dryRun: boolean;
      host: string;
      port: number;
      grantedTier: MotionPermissionTier;
      allowNonLoopback: boolean;
      allowedHosts: string[];
      allowedOrigins: string[];
      artifactRoots: string[];
      templateRoots: string[];
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

export interface MotionDebugServerTransportManifest {
  auth: {
    http: "authorization-bearer";
    webSocket: "authenticated-subprotocol";
    tokenEnv: "SHELLX_MOTION_DEBUG_TOKEN";
  };
  rest: {
    health: "/health";
    contracts: "/debug/contracts";
    dispatch: "/debug";
    sdk: "/sdk";
  };
  workbench: {
    ui: "/workbench";
    connections: "/workbench/connections";
    bootstrap: "/workbench/bootstrap";
    artifact: "/workbench/artifact";
    poster: "/workbench/poster";
    updateState: "/workbench/update-state";
    selectPath: "/workbench/select-path";
    auth: "one-use-launch-or-session-token-entry";
  };
  jsonRpc: {
    endpoint: "/rpc";
    methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"];
  };
  mcp: {
    endpoint: "/rpc";
    methods: ["server/discover", "initialize", "tools/list", "tools/call"];
    toolNamePattern: "motion_<debug_command_with_dots_as_underscores>";
  };
  webSocket: {
    endpoint: "/ws";
    transport: "websocket-json-rpc";
    methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"];
  };
}

const PERMISSION_TIERS = new Set<MotionPermissionTier>([
  "read_motion",
  "draft_motion",
  "render_motion",
  "edit_motion",
  "write_local",
  "push_remote"
]);
const execFileAsync = promisify(execFile);

const TRANSPORT_MANIFEST: MotionDebugServerTransportManifest = {
  auth: {
    http: "authorization-bearer",
    webSocket: "authenticated-subprotocol",
    tokenEnv: "SHELLX_MOTION_DEBUG_TOKEN"
  },
  rest: {
    health: "/health",
    contracts: "/debug/contracts",
    dispatch: "/debug",
    sdk: "/sdk"
  },
  workbench: {
    ui: "/workbench",
    connections: "/workbench/connections",
    bootstrap: "/workbench/bootstrap",
    artifact: "/workbench/artifact",
    poster: "/workbench/poster",
    updateState: "/workbench/update-state",
    selectPath: "/workbench/select-path",
    auth: "one-use-launch-or-session-token-entry"
  },
  jsonRpc: {
    endpoint: "/rpc",
    methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"]
  },
  mcp: {
    endpoint: "/rpc",
    methods: ["server/discover", "initialize", "tools/list", "tools/call"],
    toolNamePattern: "motion_<debug_command_with_dots_as_underscores>"
  },
  webSocket: {
    endpoint: "/ws",
    transport: "websocket-json-rpc",
    methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"]
  }
};

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
  const allowNonLoopback = hasFlag(argv, "--allow-non-loopback");
  const allowedHosts = optionValues(argv, "--allowed-host");
  if (!isLoopbackHost(host) || allowNonLoopback) {
    return invalidArgs("debug-server direct non-loopback binding is disabled; bind loopback and use an authenticated HTTPS reverse proxy or SSH tunnel.");
  }

  return {
    ok: true,
    command: "debug-server",
    dryRun: hasFlag(argv, "--dry-run"),
    host,
    port,
    grantedTier: tierValue as MotionPermissionTier,
    allowNonLoopback,
    allowedHosts,
    allowedOrigins: optionValues(argv, "--allowed-origin"),
    // Extra authenticated roots whose bounded image/poster artifacts the workbench may read.
    // Template roots remain available to agent catalog/reference commands and the
    // bounded poster endpoint even though the human Gallery is intentionally absent.
    artifactRoots: optionValues(argv, "--artifact-root"),
    templateRoots: optionValues(argv, "--template-root"),
    persistentAccess: hasFlag(argv, "--persistent-access"),
    openWorkbench: hasFlag(argv, "--open-workbench"),
    transport: TRANSPORT_MANIFEST,
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
  const handle = await startMotionDebugServer({
    host: plan.host,
    port: plan.port,
    grantedTier: plan.grantedTier,
    context: { receiptsRoot },
    allowNonLoopback: plan.allowNonLoopback,
    allowedHosts: plan.allowedHosts,
    allowedOrigins: plan.allowedOrigins,
    ...(plan.artifactRoots.length > 0 ? { artifactRoots: plan.artifactRoots } : {}),
    ...(plan.templateRoots.length > 0 ? { templateRoots: plan.templateRoots } : {}),
    updateAutoCheck: true,
    ...(configuredToken || persistentAccess ? { capabilityToken: configuredToken ?? persistentAccess!.token } : {}),
    ...(workbenchBootstrapToken ? { workbenchBootstrapToken } : {})
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
        await openWorkbenchInDefaultBrowser(workbenchBootstrapUrl(handle.url, workbenchBootstrapToken));
      } catch (error) {
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
    if (publishedPort !== null) await clearMotionServerPort(accessPaths, publishedPort);
    if (tokenRoot) await rm(tokenRoot, { recursive: true, force: true });
  }
  return 0;
}

export { writeEphemeralCapabilityFile } from "./user-access";

export function workbenchBootstrapUrl(serverUrl: URL, bootstrapToken: string): string {
  const workbenchUrl = new URL("/workbench", serverUrl);
  workbenchUrl.hash = new URLSearchParams({ bootstrap: bootstrapToken }).toString();
  return workbenchUrl.toString();
}

async function openWorkbenchInDefaultBrowser(url: string): Promise<void> {
  const launch = process.platform === "win32"
    ? { command: "explorer.exe", args: [url] }
    : process.platform === "darwin"
      ? { command: "open", args: [url] }
      : { command: "xdg-open", args: [url] };
  await execFileAsync(launch.command, launch.args, {
    encoding: "utf8",
    windowsHide: false,
    timeout: 10_000
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
