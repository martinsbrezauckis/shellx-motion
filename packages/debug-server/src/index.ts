import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import {
  createEffectModuleRegistryAuthority,
  createEffectModuleRegistryUseAuthority,
  type EffectModuleRegistryAuthority
} from "@shellx-motion/renderer-browser/internal/effect-modules";
import {
  DEBUG_COMMAND_CONTRACTS,
  MOTION_ENGINE_VERSION, createEphemeralAttestedRenderReuseProducerAuthority,
  readMotionAgentSnapshotResource,
  requestedTierRefusal,
  tierRefusal,
  type MotionDebugCommand,
  type MotionDebugCommandContract,
  type MotionDebugContext,
  type MotionDebugResult
} from "@shellx-motion/debug-api";
import {
  runHostLayoutAuthorityRepairAtStartup,
  type LayoutAuthorityRepairStartup,
} from "./layout-authority-repair-lifecycle.js";
import { debugContractForMcpToolName, mcpToolForDebugContract, mcpToolName } from "./mcp-tool-shape.js";
import { clearObservedMcpConnection, observeMcpInitialize, type McpWebSocketConnectionState } from "./mcp-observed-session.js";
import { authenticatedJobOwnerPrincipal, inferredServerActor } from "./dispatch-identities.js";
// Refusal wording and the per-transport error envelopes live together; see transport-refusals.ts.
import {
  PERMISSION_TIERS,
  PERMISSION_TIER_RANK,
  debugServerError,
  jsonRpcError,
  readPermissionTier,
  resolveRequestedTier,
  sdkFailure,
  type JsonRpcId,
  type JsonRpcResponseBody
} from "./transport-refusals.js";
import { validateMcpToolCall, validateRawDispatchArgs } from "./mcp-args-validation.js";
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  inspectModernMcpHttpRequest,
  modernMcpHttpStatus,
  modernMcpResult,
  type ModernMcpRequestContext
} from "./mcp-modern.js";
import { readWorkbenchDocsIndex, readWorkbenchDocsPage } from "./workbench-docs.js";
import {
  runWorkbenchUpdateApply,
  runWorkbenchUpdateCheck,
  type UpdateFetch
} from "./workbench-update.js";
import {
  createWorkbenchUpdateController,
} from "./workbench-update-controller.js";
import { createDefaultRevealOpener, runWorkbenchReveal, type RevealOpener } from "./workbench-reveal.js";
import {
  buildMotionAgentConnectionState,
  configureMotionAgent,
  runMotionAgentConfiguration,
  type MotionAgentConfigurator
} from "./workbench-connections.js";
import { isWorkbenchFile, writeWorkbenchFile } from "./workbench-static.js";
import { dispatchGuarded } from "./guarded-dispatch.js";
import { mcpResourceCapabilities, mcpResourceList, mcpResourceMethods, readMcpResource, type MotionAgentSnapshotResourceSource } from "./mcp-resources.js";
import { createOperatorReceiptGrants, createOperatorRenderGrants, grantOperatorReceiptRoot, grantOperatorRenderRoot, dispatchContextBase } from "./operator-receipt-grants.js";
import {
  createDefaultWorkbenchPathPicker,
  parseWorkbenchPathPurpose,
  runWorkbenchPathPicker,
  type WorkbenchPathPicker
} from "./workbench-path-picker.js";
import { effectModuleOperatorSessionCookie, handleEffectModuleWorkbenchRequest } from "./workbench-effect-modules.js";
import {
  createWorkbenchArtifactSessions,
  establishWorkbenchArtifactSession,
  mintWorkbenchArtifactHandle,
  mintWorkbenchPosterHandle,
  resolveWorkbenchArtifactHandle,
  resolveWorkbenchPosterHandle,
  workbenchArtifactSessionCookie,
  workbenchArtifactSessionFromRequest
} from "./workbench-artifact-session.js";
import { readWorkbenchArtifact, readWorkbenchPoster, retainExistingArtifactRoots } from "./workbench-artifact-read.js";
import { consumeWorkbenchBootstrapClaim } from "./workbench-bootstrap-claim.js";
import type { MotionDebugServerSecurityContext, MotionPermissionTier } from "./debug-server-security.js";
import {
  MOTION_SDK_SCHEMA,
  motionSdkCacheKey,
  type MotionSdkTransport,
  type MotionSdkTransportRequest,
  type MotionSdkTransportResponse
} from "@shellx-motion/sdk";
import { createLocalMotionSdkTransport } from "@shellx-motion/sdk/local";
import { localSdkOptionsFromDebugContext } from "./sdk-local-options.js";
import { runSdkRequest } from "./sdk-route.js";
import { strictServerRenderContext } from "./server-render-context.js";
import {
  closeWebSocketWithPolicyError,
  readWebSocketFrames,
  rejectWebSocketUpgrade,
  writeWebSocketFrame,
  writeWebSocketText,
  type WebSocketFrame
} from "./websocket-frame.js";
import { createBoundedAsyncQueue } from "./bounded-async-queue.js";
import { RawDebugRequestBodyTooLargeError, statusForRawDebugResult } from "./debug-http-status.js";

export interface MotionDebugServerOptions {
  host?: string;
  port?: number;
  grantedTier?: MotionPermissionTier;
  /** @deprecated Use grantedTier. This value is a server-owned maximum, never a client default. */
  defaultTier?: MotionPermissionTier;
  capabilityToken?: string;
  /** One-use launch value exchanged by the locally opened Workbench for the capability token; optionally removes its private handoff after exchange. */
  workbenchBootstrapToken?: string; onWorkbenchBootstrapClaim?: () => void | Promise<void>;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  maxConcurrentRequests?: number;
  maxWebSocketConnections?: number;
  /** Extra authenticated roots whose bounded image artifacts the local workbench may preview. */
  artifactRoots?: string[];
  /** Agent reference collections. The repo's promoted pack is discovered automatically. */
  templateRoots?: string[];
  /** Host-test seam to suppress automatic checkout discovery; not a transport option. */
  useDefaultTemplateRoots?: boolean;
  agentSnapshotSource?: MotionAgentSnapshotResourceSource;
  /** Absolute docs/public root the workbench documentation viewer serves. Defaults to the repo docs tree. */
  docsRoot?: string;
  /** `owner/repo` slug for the explicit update channel. Environment and caller overrides take precedence over the official repository. */
  updateRepo?: string;
  /** GitHub API base for the update channel (overridable for tests). Defaults to https://api.github.com. */
  updateApiBaseUrl?: string;
  /** Packaged-install root marker. Defaults to env SHELLX_MOTION_INSTALL_ROOT (unset = source checkout). */
  installRoot?: string;
  /** Upstream timeout for the update feed request, in milliseconds. */
  updateTimeoutMs?: number;
  /**
   * Unsafe development override for the update channel: allow a non-GitHub API base and private/
   * loopback addresses (for a fixture server). Defaults to env SHELLX_MOTION_UPDATE_ALLOW_UNSAFE_BASE.
   * NEVER enable in production — its active state is echoed back in the check payload.
   */
  updateAllowUnsafeBase?: boolean;
  /** Injected pinned fetch for the update channel; defaults to the pinned node transport. */
  updateFetch?: UpdateFetch;
  /** Start the shared update check at launch and refresh it periodically. The CLI enables this. */
  updateAutoCheck?: boolean;
  /** Period between automatic update checks. Defaults to thirty minutes. */
  updateCheckIntervalMs?: number;
  /** Injected OS opener for reveal-in-file-manager; defaults to the platform file manager. */
  revealOpener?: RevealOpener;
  /** Injected native file/folder chooser for Workbench Browse actions. */
  pathPicker?: WorkbenchPathPicker;
  /** Injected one-click MCP client configurator; defaults to the installed provider CLIs. */
  connectionConfigurator?: MotionAgentConfigurator;
  /** Host-selected private C1 registry root. Omitted servers expose no effect-module manager. */
  effectModulesRoot?: string;
  /** Host-only test/integration seam; no HTTP request, command, or package can provide an authority. */
  effectModuleRegistryFactory?: (stateRoot: string) => EffectModuleRegistryAuthority;
  /** Host-only pre-listen crash repair; no transport, package, CLI, or MCP input can invoke it. */
  repairLayoutAuthorityPairsAtStartup?: LayoutAuthorityRepairStartup;
  context?: Partial<Omit<MotionDebugContext, "tier">>;
  sdkTransport?: MotionSdkTransport;
}

export interface MotionDebugServerHandle {
  server: Server;
  url: URL;
  capabilityToken: string;
  close: () => Promise<void>;
}

interface DebugRequestBody {
  command?: unknown;
  args?: unknown;
  tier?: unknown;
  requestedTier?: unknown;
}

interface JsonRpcRequestBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_REQUEST_BYTES = 1_000_000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WEBSOCKET_PROTOCOL = "shellx-motion-debug-v1";
const WEBSOCKET_TOKEN_PREFIX = "shellx-motion-token.";
const MIN_CAPABILITY_TOKEN_LENGTH = 32;
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const DEFAULT_MAX_WEBSOCKET_CONNECTIONS = 8;
const MAX_OUTSTANDING_WEBSOCKET_FRAMES = 32;
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/**
 * Default documentation root: the single-source `docs/public` tree.
 *
 * Resolved by trying each plausible location and taking the first that exists, because the
 * correct relative depth differs between running from source (`packages/debug-server/src/`),
 * running from a build (`packages/debug-server/dist/`), and running from an install
 * (`node_modules/@shellx-motion/debug-server/dist/`). A single fixed `../../../` was right only
 * for the source tree and silently escaped the package into `node_modules/docs/public/` once
 * installed, where nothing exists.
 *
 * When none exist the value still points somewhere deterministic, and `docsRoot` can be passed
 * explicitly; the server reports a missing document rather than pretending to serve one.
 */
const DOCS_PUBLIC_ROOT_CANDIDATES = [
  // Packaged: the build mirrors docs/public beside the emitted server module.
  "./docs/public/",
  // Built or source, inside the workspace.
  "../../../docs/public/",
  "../../../../docs/public/"
] as const;

function resolveDefaultDocsPublicRoot(): string {
  for (const candidate of DOCS_PUBLIC_ROOT_CANDIDATES) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return fileURLToPath(new URL(DOCS_PUBLIC_ROOT_CANDIDATES[1], import.meta.url));
}

const DEFAULT_DOCS_PUBLIC_ROOT = resolveDefaultDocsPublicRoot();
const DEFAULT_UPDATE_API_BASE_URL = "https://api.github.com";
const DEFAULT_UPDATE_REPO = "martinsbrezauckis/shellx-motion";
const MCP_STDIO_BRIDGE_PATH = fileURLToPath(new URL("../bin/shellx-motion-mcp.mjs", import.meta.url));
const TEMPLATE_ROOT_CANDIDATES = [
  resolve(process.cwd(), "templates/shellx-product-pack"),
  fileURLToPath(new URL("../../../templates/shellx-product-pack/", import.meta.url)),
  fileURLToPath(new URL("../../../../templates/shellx-product-pack/", import.meta.url))
] as const;

function defaultTemplateRoots(): string[] {
  return [...new Set(TEMPLATE_ROOT_CANDIDATES.filter((candidate) => existsSync(candidate)).map((candidate) => resolve(candidate)))];
}

const JSON_RPC_METHODS = [
  "rpc.discover",
  "motion.debug.contracts",
  "motion.debug.dispatch",
  "server/discover",
  "initialize",
  "tools/list",
  "tools/call"
] as const;

/** The host's explicit `jobView: null` policy removes every coordinator capability from discovery. */
const COORDINATOR_COMMANDS = new Set<MotionDebugCommand>([
  "motion.job.submit", "motion.connector.submit", "motion.job.get", "motion.job.list", "motion.job.events", "motion.job.cancel", "motion.job.retry"
]);

function publishedDebugContracts(security: Pick<MotionDebugServerSecurityContext, "context">): readonly MotionDebugCommandContract[] {
  if (security.context.jobView === null) return DEBUG_COMMAND_CONTRACTS.filter((contract) => !COORDINATOR_COMMANDS.has(contract.command));
  return DEBUG_COMMAND_CONTRACTS;
}
const MCP_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSION;
export async function startMotionDebugServer(options: MotionDebugServerOptions = {}): Promise<MotionDebugServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!isLoopbackHost(host)) {
    throw new Error("Motion debug server direct non-loopback binding is disabled; bind loopback and use an authenticated HTTPS reverse proxy or SSH tunnel.");
  }
  const capabilityToken = options.capabilityToken ?? randomBytes(32).toString("base64url");
  if (capabilityToken.length < MIN_CAPABILITY_TOKEN_LENGTH || !CAPABILITY_TOKEN_PATTERN.test(capabilityToken)) {
    throw new Error(`Motion debug server capability tokens must be at least ${MIN_CAPABILITY_TOKEN_LENGTH} URL-safe characters.`);
  }
  const workbenchBootstrapToken = options.workbenchBootstrapToken ?? null;
  if (workbenchBootstrapToken !== null
    && (workbenchBootstrapToken.length < MIN_CAPABILITY_TOKEN_LENGTH || !CAPABILITY_TOKEN_PATTERN.test(workbenchBootstrapToken))) {
    throw new Error(`Motion Workbench bootstrap tokens must be at least ${MIN_CAPABILITY_TOKEN_LENGTH} URL-safe characters.`);
  }
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
    throw new Error("Motion debug server maxConcurrentRequests must be a positive integer.");
  }
  const maxWebSocketConnections = options.maxWebSocketConnections ?? DEFAULT_MAX_WEBSOCKET_CONNECTIONS;
  if (!Number.isInteger(maxWebSocketConnections) || maxWebSocketConnections < 1) {
    throw new Error("Motion debug server maxWebSocketConnections must be a positive integer.");
  }
  const templateRoots = [...new Set([
    ...(options.useDefaultTemplateRoots === false ? [] : defaultTemplateRoots()),
    ...(options.templateRoots ?? []).map((root) => resolve(root))
  ])];
  const updateRepo = normalizeUpdateRepo(options.updateRepo ?? process.env.SHELLX_MOTION_UPDATE_REPO ?? DEFAULT_UPDATE_REPO);
  const updateApiBaseUrl = options.updateApiBaseUrl ?? process.env.SHELLX_MOTION_UPDATE_API_BASE ?? DEFAULT_UPDATE_API_BASE_URL;
  const installRoot = normalizeInstallRoot(options.installRoot ?? process.env.SHELLX_MOTION_INSTALL_ROOT);
  const updateTimeoutMs = options.updateTimeoutMs ?? 5000;
  const updateAllowUnsafeBase = options.updateAllowUnsafeBase ?? isTruthyEnvFlag(process.env.SHELLX_MOTION_UPDATE_ALLOW_UNSAFE_BASE);
  const updateController = createWorkbenchUpdateController({
    currentVersion: MOTION_ENGINE_VERSION,
    intervalMs: options.updateCheckIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS,
    check: () => runWorkbenchUpdateCheck({
      repo: updateRepo,
      apiBaseUrl: updateApiBaseUrl,
      installRoot,
      currentVersion: MOTION_ENGINE_VERSION,
      timeoutMs: updateTimeoutMs,
      allowUnsafeBase: updateAllowUnsafeBase,
      ...(options.updateFetch ? { fetchImpl: options.updateFetch } : {})
    })
  });
  // Startup context supplies host authority/roots, never transport authorization.
  const {
    observedMcpAgentSession: _ignoredConfiguredObservedMcpSession,
    // The server mints this only from its private registry below. A caller of startMotionDebugServer
    // cannot substitute a capability-like token through the otherwise-host-owned base context.
    gpuEffectModuleUseAuthority: _ignoredConfiguredGpuEffectModuleUseAuthority,
    ...serverContext
  } = options.context ?? {};
  const attestedRenderReuseProducerAuthority = serverContext.attestedRenderReuseProducerAuthority ?? createEphemeralAttestedRenderReuseProducerAuthority();
  await runHostLayoutAuthorityRepairAtStartup(serverContext.receiptsRoot, options.repairLayoutAuthorityPairsAtStartup);
  const sessionId = `srv-${randomBytes(8).toString("hex")}`;
  const jobOwnerPrincipal = `job-${randomBytes(32).toString("hex")}`;
  const effectModulesRoot = options.effectModulesRoot ? resolve(options.effectModulesRoot) : null;
  const effectModules = effectModulesRoot
    ? (options.effectModuleRegistryFactory ?? ((stateRoot) => createEffectModuleRegistryAuthority({ stateRoot })))(effectModulesRoot)
    : null;
  // This is a one-way, opaque read/use projection. The Debug context never receives registry
  // management operations, filesystem roots, manifest bytes, or an operator-selected state path.
  const gpuEffectModuleUseAuthority = effectModules
    ? createEffectModuleRegistryUseAuthority(effectModules)
    : undefined;
  const scratchArtifactRoot = resolve(serverContext.scratchRoot ?? ".scratch");
  const configuredArtifactRoots = [...new Set([
    scratchArtifactRoot,
    ...(serverContext.receiptsRoot ? [resolve(serverContext.receiptsRoot)] : []),
    ...templateRoots,
    ...(options.artifactRoots ?? []).map((root) => resolve(root))
  ])];
  const artifactRootAuthorities = await retainExistingArtifactRoots(configuredArtifactRoots);
  const templateRootAuthorities = await retainExistingArtifactRoots(templateRoots);
  const security: MotionDebugServerSecurityContext = {
    capabilityToken,
    workbenchBootstrapToken, ...(options.onWorkbenchBootstrapClaim ? { onWorkbenchBootstrapClaim: options.onWorkbenchBootstrapClaim } : {}),
    workbenchOperatorSession: workbenchBootstrapToken ? randomBytes(32).toString("base64url") : null,
    grantedTier: options.grantedTier ?? options.defaultTier ?? "read_motion",
    // Non-secret per-instance session id, distinct from the capability token.
    sessionId,
    jobOwnerPrincipal,
    // Template roots are separately admitted by the Debug API caller boundary.
    context: strictServerRenderContext({ ...serverContext, templateRoots }, attestedRenderReuseProducerAuthority, gpuEffectModuleUseAuthority),
    ...(options.agentSnapshotSource ? { agentSnapshotSource: { ...options.agentSnapshotSource } } : {}),
    allowedOrigins: new Set((options.allowedOrigins ?? []).map(normalizeAllowedOrigin)),
    allowedHosts: new Set((options.allowedHosts ?? []).map(normalizeAllowedHost)),
    artifactRoots: artifactRootAuthorities.map((authority) => authority.path),
    artifactRootAuthorities,
    templateRoots,
    templateRootAuthorities,
    workbenchArtifactSessions: createWorkbenchArtifactSessions(),
    sdkTransport: options.sdkTransport ?? createLocalMotionSdkTransport(localSdkOptionsFromDebugContext({ ...serverContext, attestedRenderReuseProducerAuthority, callerId: serverContext.callerId?.trim() || jobOwnerPrincipal })),
    docsRoot: resolve(options.docsRoot ?? DEFAULT_DOCS_PUBLIC_ROOT),
    updateRepo,
    updateApiBaseUrl,
    installRoot,
    updateTimeoutMs,
    updateAllowUnsafeBase,
    updateFetch: options.updateFetch,
    updateController,
    revealOpener: options.revealOpener ?? createDefaultRevealOpener(),
    pathPicker: options.pathPicker ?? createDefaultWorkbenchPathPicker(),
    operatorReceiptRoots: createOperatorReceiptGrants(),
    operatorRenderGrants: createOperatorRenderGrants(),
    connectionConfigurator: options.connectionConfigurator ?? configureMotionAgent,
    effectModules,
    workbenchOrigins: new Set()
  };
  if (!PERMISSION_TIERS.has(security.grantedTier)) {
    throw new Error("Motion debug server grantedTier must be a valid Motion permission tier.");
  }
  let activeRequests = 0, activeWebSockets = 0;
  const activeWebSocketSockets = new Set<Duplex>();

  const server = createServer((request, response) => {
    if (activeRequests >= maxConcurrentRequests) {
      setBaseHeaders(response, null);
      writeJson(response, 429, debugServerError("too_many_requests", "Motion debug server request concurrency limit reached."));
      return;
    }
    activeRequests += 1;
    void handleRequest(request, response, security).finally(() => {
      activeRequests -= 1;
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (activeWebSockets >= maxWebSocketConnections) {
      rejectWebSocketUpgrade(socket, 429, "Too Many Connections");
      return;
    }
    if (handleWebSocketUpgrade(request, socket, head, security)) {
      activeWebSockets += 1; activeWebSocketSockets.add(socket);
      socket.once("close", () => {
        activeWebSockets -= 1; activeWebSocketSockets.delete(socket);
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    updateController.close();
    await closeServer(server);
    throw new Error("Motion debug server did not expose a TCP address.");
  }

  const actualPort = address.port;
  security.allowedHosts.add(formatHostHeader(address.address, actualPort));
  security.allowedHosts.add(formatHostHeader(host, actualPort));
  if (isLoopbackHost(host)) {
    for (const loopbackHost of ["127.0.0.1", "localhost", "::1"]) {
      security.allowedHosts.add(formatHostHeader(loopbackHost, actualPort));
      security.allowedOrigins.add(new URL(`http://${formatHostHeader(loopbackHost, actualPort)}`).origin);
      security.workbenchOrigins.add(new URL(`http://${formatHostHeader(loopbackHost, actualPort)}`).origin);
    }
  }
  if (options.updateAutoCheck === true) updateController.start();

  const handle = {
    server,
    url: new URL(`http://${formatHostHeader(address.address, address.port)}`),
    close: async () => {
      updateController.close();
      // `server.close()` waits for upgraded sockets, so end bridge-held principals before draining.
      for (const socket of activeWebSocketSockets) socket.destroy();
      // First stop accepting requests and wait for admitted HTTP work to drain. Only then may the
      // registry discard pending state: an install that already passed its authority check must not
      // stage a new confirmation after registry.close() has completed.
      const failures: unknown[] = [];
      try { await closeServer(server); }
      catch (error) { failures.push(error); }
      try { await security.effectModules?.close(); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, "Motion debug server shutdown encountered failures.");
    }
  } as MotionDebugServerHandle;
  // Keep the ephemeral capability directly accessible to in-process hosts without
  // leaking it through JSON.stringify(), object spread, or routine handle logging.
  Object.defineProperty(handle, "capabilityToken", {
    value: capabilityToken,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return handle;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  security: MotionDebugServerSecurityContext
): Promise<void> {
  try {
    const origin = requestOrigin(request);
    setBaseHeaders(response, origin && security.allowedOrigins.has(origin) ? origin : null);

    if (!isAllowedHost(request.headers.host, security.allowedHosts)) {
      writeJson(response, 403, debugServerError("forbidden_host", "Motion debug server rejected the Host header."));
      return;
    }
    if (origin && !security.allowedOrigins.has(origin)) {
      writeJson(response, 403, debugServerError("forbidden_origin", "Motion debug server rejected the request Origin."));
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;

    if (request.method === "GET" && isWorkbenchFile(path)) {
      await writeWorkbenchFile(response, path);
      return;
    }
    if (request.method === "GET" && path === "/favicon.ico") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && path === "/health") {
      writeJson(response, 200, {
        ok: true,
        name: "shellx-motion-debug-server",
        transport: "http",
        // Canonical engine version, so unauthenticated liveness callers and the
        // workbench read one value that matches every other transport.
        engineVersion: MOTION_ENGINE_VERSION,
        contractCount: publishedDebugContracts(security).length,
        sdkSchema: MOTION_SDK_SCHEMA
      });
      return;
    }

    // Start Motion exchanges a one-use URL-fragment value after the page clears it; ordinary URLs
    // still connect manually, and a consumed/incorrect launch value cannot be replayed.
    if (request.method === "POST" && path === "/workbench/bootstrap") {
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Workbench bootstrap requires application/json."));
        return;
      }
      const payload = await readJsonBody(request) as { bootstrap?: unknown };
      const bootstrap = typeof payload.bootstrap === "string" ? payload.bootstrap : "";
      if (!security.workbenchBootstrapToken
        || !bootstrap
        || !secureTokenEqual(bootstrap, security.workbenchBootstrapToken)) {
        writeJson(response, 401, debugServerError("invalid_bootstrap", "This Start Motion link is invalid or has already been used."));
        return;
      }
      if (!await consumeWorkbenchBootstrapClaim(security)) { writeJson(response, 500, debugServerError("bootstrap_handoff_cleanup_failed", "The private Start Motion handoff could not be removed.")); return; }
      if (security.workbenchOperatorSession) {
        response.setHeader("set-cookie", effectModuleOperatorSessionCookie(security.workbenchOperatorSession));
      }
      writeJson(response, 200, { ok: true, capabilityToken: security.capabilityToken });
      return;
    }

    if (!hasHttpCapability(request, security.capabilityToken)) {
      response.setHeader("www-authenticate", "Bearer realm=\"shellx-motion-debug\"");
      writeJson(response, 401, debugServerError("unauthorized", "Motion debug server authentication is required."));
      return;
    }

    if (path === "/workbench/effect-modules" || path.startsWith("/workbench/effect-modules/")) {
      await handleEffectModuleWorkbenchRequest(request, response, path, security);
      return;
    }

    if (request.method === "POST" && path === "/workbench/artifact-session") {
      const session = establishWorkbenchArtifactSession(request, security.workbenchArtifactSessions);
      response.setHeader("set-cookie", workbenchArtifactSessionCookie(session));
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && path === "/workbench/select-path") {
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "The file chooser requires application/json."));
        return;
      }
      const payload = await readJsonBody(request) as { purpose?: unknown; currentPath?: unknown };
      const selection = await runWorkbenchPathPicker(payload.purpose, payload.currentPath, security.pathPicker);
      if (!selection.ok) {
        writeJson(response, selection.status, debugServerError(selection.code, selection.message));
        return;
      }
      if (selection.cancelled) {
        writeJson(response, 200, { ok: true, cancelled: true });
        return;
      }
      // A person just chose this in an OS dialog: host intent, not a caller argument.
      grantOperatorReceiptRoot(security.operatorReceiptRoots, parseWorkbenchPathPurpose(payload.purpose), selection.path);
      grantOperatorRenderRoot(security.operatorRenderGrants, parseWorkbenchPathPurpose(payload.purpose), selection.path);
      writeJson(response, 200, { ok: true, cancelled: false, path: selection.path });
      return;
    }

    if (request.method === "GET" && path === "/workbench/artifact") {
      const artifactPath = resolveWorkbenchArtifactHandle(
        workbenchArtifactSessionFromRequest(request, security.workbenchArtifactSessions),
        requestUrl.searchParams.get("handle")
      );
      if (!artifactPath) {
        writeJson(response, 403, debugServerError("artifact_not_visible", "Workbench artifact requests require an opaque handle from this browser session."));
        return;
      }
      const artifact = await readWorkbenchArtifact(artifactPath, security.artifactRoots, security.artifactRootAuthorities);
      if (!artifact.ok) {
        writeJson(response, artifact.status, debugServerError(artifact.code, artifact.message));
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", artifact.contentType);
      response.setHeader("content-length", String(artifact.bytes.byteLength));
      response.end(artifact.bytes);
      return;
    }

    if (request.method === "GET" && path === "/workbench/poster") {
      const posterPath = resolveWorkbenchPosterHandle(
        workbenchArtifactSessionFromRequest(request, security.workbenchArtifactSessions),
        requestUrl.searchParams.get("handle")
      );
      if (!posterPath) {
        writeJson(response, 403, debugServerError("poster_not_visible", "Workbench poster requests require an opaque handle from this browser session."));
        return;
      }
      const poster = await readWorkbenchPoster(posterPath, security.templateRoots, security.templateRootAuthorities);
      if (!poster.ok) {
        writeJson(response, poster.status, debugServerError(poster.code, poster.message));
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", poster.contentType);
      response.setHeader("content-length", String(poster.bytes.byteLength));
      // Serve posters inert: sandbox + null default-src means a poster cannot run
      // script or reach the network even if it were opened directly instead of via <img>.
      // The exact policy is format-specific (raster posters drop the style-src
      // relaxation that only inline-styled SVG needs) — see ./workbench-image.ts.
      response.setHeader("content-security-policy", poster.contentSecurityPolicy);
      response.setHeader("content-disposition", "inline");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(poster.bytes);
      return;
    }

    // Engine Room documentation viewer: the same single-source docs tree that
    // later ships to docs.theshellx.com, served read-only over the authenticated
    // channel. Page ids map to files strictly through index.json.
    if (request.method === "GET" && path === "/workbench/docs/index.json") {
      const index = await readWorkbenchDocsIndex(security.docsRoot);
      if (!index.ok) {
        writeJson(response, index.status, debugServerError(index.code, index.message));
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", index.contentType);
      response.setHeader("content-length", String(index.bytes.byteLength));
      response.end(index.bytes);
      return;
    }

    if (request.method === "GET" && path === "/workbench/docs/page") {
      const pageId = requestUrl.searchParams.get("id");
      const page = await readWorkbenchDocsPage(security.docsRoot, pageId ?? "");
      if (!page.ok) {
        writeJson(response, page.status, debugServerError(page.code, page.message));
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", page.contentType);
      response.setHeader("content-length", String(page.bytes.byteLength));
      response.end(page.bytes);
      return;
    }

    if (request.method === "GET" && path === "/workbench/update-state") {
      writeJson(response, 200, { ok: true, ...security.updateController.snapshot() });
      return;
    }

    if (request.method === "GET" && path === "/workbench/connections/state") {
      const host = String(request.headers.host ?? "");
      const baseUrl = new URL(`http://${host}`);
      writeJson(response, 200, buildMotionAgentConnectionState(baseUrl));
      return;
    }

    if (request.method === "POST" && path === "/workbench/connections/configure") {
      // Configuring an MCP provider mutates that provider's user configuration. It is not a
      // read-only Workbench convenience: require the same deliberate local-write grant as other
      // host configuration and file-creating operations.
      if (PERMISSION_TIER_RANK[security.grantedTier] < PERMISSION_TIER_RANK.write_local) {
        writeJson(response, 403, debugServerError(
          "permission_denied",
          `Motion agent configuration requires write_local; this server holds ${security.grantedTier}.`
        ));
        return;
      }
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Agent configuration requires application/json."));
        return;
      }
      const payload = await readJsonBody(request) as { provider?: unknown };
      const configured = await runMotionAgentConfiguration(payload.provider, {
        command: process.execPath,
        args: [MCP_STDIO_BRIDGE_PATH]
      }, security.connectionConfigurator);
      if (!configured.ok) writeJson(response, configured.status, debugServerError(configured.code, configured.message));
      else writeJson(response, 200, { ok: true, ...configured.result });
      return;
    }

    // A manual refresh updates the same cache used by launch checks and agent discovery.
    if (request.method === "POST" && path === "/workbench/update-check") {
      const check = await security.updateController.refresh();
      writeJson(response, 200, check);
      return;
    }

    if (request.method === "POST" && path === "/workbench/update-apply") {
      const apply = runWorkbenchUpdateApply({
        repo: security.updateRepo,
        apiBaseUrl: security.updateApiBaseUrl,
        installRoot: security.installRoot,
        currentVersion: MOTION_ENGINE_VERSION
      });
      writeJson(response, 200, apply);
      return;
    }

    // Reveal an artifact's containing folder in the OS file manager. Used by the
    // receipt cards so users can find MCP-agent-created artifacts on disk.
    if (request.method === "POST" && path === "/workbench/reveal") {
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Motion reveal requires application/json."));
        return;
      }
      const payload = await readJsonBody(request);
      const reveal = await runWorkbenchReveal(
        (payload as { path?: unknown }).path,
        security.artifactRoots,
        security.artifactRootAuthorities,
        security.revealOpener
      );
      if (!reveal.ok) {
        writeJson(response, reveal.status, debugServerError(reveal.code, reveal.message));
        return;
      }
      writeJson(response, 200, { ok: true, revealed: reveal.revealed, platform: reveal.platform });
      return;
    }

    if (request.method === "GET" && path === "/debug/contracts") {
      writeJson(response, 200, {
        ok: true,
        transport: "http",
        // Canonical engine version travels with the contracts payload so the
        // workbench can show the running version beside the update-check button.
        engineVersion: MOTION_ENGINE_VERSION,
        // Expose the authenticated server grant so the workbench can honestly gate
        // tier-restricted actions (for example, disabling render below render_motion).
        grantedTier: security.grantedTier,
        templateRoots: security.templateRoots,
        // Where THIS host keeps receipts, so the human pages can show and read the real folder
        // instead of guessing one.
        //
        // They used to ship a literal `.scratch/receipts` in the markup as a starting value. That is
        // a root the BROWSER invented, and `receipts-root-policy.ts` refuses a caller-named root that
        // is not inside a host-named one — by design, and correctly. So every Workbench page opened
        // against a server whose receipts live anywhere else (which is every shipped server: the CLI
        // derives its root under the Motion user access directory) fired receipts reads that could
        // only be refused. Publishing the host's own root replaces the guess with the fact.
        //
        // Absolute, because `artifactRoots` already resolves the same value and a relative string is
        // meaningless to a browser that does not share the server's working directory. Omitted
        // entirely when the host declared no root: a page with no value shows "no receipt location
        // selected" and asks the person to Browse, which is the honest state — the fence would
        // refuse anything else anyway.
        ...(security.context.receiptsRoot ? { receiptsRoot: resolve(security.context.receiptsRoot) } : {}),
        update: security.updateController.summary(),
        contracts: publishedDebugContracts(security)
      });
      return;
    }

    if (path === "/sdk") {
      if (request.method !== "POST") {
        writeJson(response, 405, debugServerError("method_not_allowed", "Motion SDK dispatch requires POST /sdk."));
        return;
      }
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Motion SDK dispatch requires application/json."));
        return;
      }
      // Routed through runSdkRequest so this transport cannot drift from the boundary fence the
      // other three apply. See sdk-route.ts for why it was invisible while it was inline here.
      const answer = await runSdkRequest(await readJsonBody(request), security);
      writeJson(response, answer.status, answer.body);
      return;
    }

    if (path === "/rpc") {
      if (request.method !== "POST") {
        writeJson(response, 405, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "JSON-RPC dispatch requires POST /rpc."
          }
        });
        return;
      }

      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Motion debug JSON-RPC requires application/json."));
        return;
      }

      const payload = await readJsonBody(request);
      const modern = inspectModernMcpHttpRequest(payload, request.headers);
      if (modern.mode === "error") {
        writeJson(response, modern.status, modern.body);
        return;
      }
      const rpcBody = await handleJsonRpcRequest(
        payload,
        security,
        "json-rpc",
        undefined,
        modern.mode === "modern" ? modern.context : undefined
      );
      writeJson(response, modernMcpHttpStatus(rpcBody, modern.mode === "modern"), rpcBody);
      return;
    }

    if (path !== "/debug") {
      writeJson(response, 404, {
        ok: false,
        error: {
          code: "not_found",
          message: `Unknown Motion debug server route: ${path}.`
        },
        warnings: []
      });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, {
        ok: false,
        error: {
          code: "method_not_allowed",
          message: "Motion debug dispatch requires POST /debug."
        },
        warnings: []
      });
      return;
    }

    if (!hasJsonContentType(request)) {
      writeJson(response, 415, debugServerError("unsupported_media_type", "Motion debug dispatch requires application/json."));
      return;
    }

    const payload = await readJsonBody(request);
    const command = typeof payload.command === "string" ? payload.command : null;
    if (!command) {
      writeJson(response, 400, {
        ok: false,
        error: {
          code: "invalid_request",
          message: "POST /debug requires a string command."
        },
        warnings: []
      });
      return;
    }

    const resolvedTier = resolveRequestedTier(payload.requestedTier ?? payload.tier, security.grantedTier);
    if (!resolvedTier.ok) {
      writeJson(response, 403, {
        ...debugServerError("permission_denied", resolvedTier.message, resolvedTier),
        command
      });
      return;
    }
    // Same published schema the MCP and JSON-RPC transports enforce; see validateRawDispatchArgs.
    const invalidArgs = validateRawDispatchArgs(command, payload.args, resolvedTier.tier);
    const result = invalidArgs ?? await dispatchGuarded(command as MotionDebugCommand, payload.args ?? {}, {
      ...dispatchContextBase(security, resolvedTier.tier),
      callerId: authenticatedJobOwnerPrincipal(security.context.callerId),
      // POST /debug is the bare HTTP transport: observe wire + session + granted tier so History can
      // answer "BY WHO" even when the caller supplied no createdBy. See inferredServerActor.
      actor: inferredServerActor({ wire: "http", protocol: "raw", grantedTier: resolvedTier.tier, sessionId: security.sessionId })
    });
    const workbenchSession = workbenchArtifactSessionFromRequest(request, security.workbenchArtifactSessions);
    const workbenchArtifact = previewArtifactHandleForResult(
      command as MotionDebugCommand,
      result,
      workbenchSession
    );
    const workbenchPosters = posterHandlesForResult(command as MotionDebugCommand, result, workbenchSession);
    writeJson(response, statusForRawDebugResult(result), {
      ...result,
      command,
      ...(workbenchArtifact ? { workbenchArtifact: { handle: workbenchArtifact } } : {}),
      ...(workbenchPosters.length > 0 ? { workbenchPosters } : {})
    });
  } catch (error) {
    const status = error instanceof RawDebugRequestBodyTooLargeError
      && request.method === "POST"
      && new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/debug"
      ? 413
      : 400;
    writeJson(response, status, {
      ok: false,
      error: {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error)
      },
      warnings: []
    });
  }
}

/**
 * Per-WebSocket-connection state carried across frames on one socket. A single MCP client keeps its
 * connection open and sends `initialize` (declaring its identity) before any `tools/call`; this lets
 * the later tool receipts record which agent drove them, and gives the whole exchange one session id.
 */
async function handleJsonRpcRequest(
  payload: JsonRpcRequestBody,
  security: MotionDebugServerSecurityContext,
  transport: "json-rpc" | "websocket-json-rpc",
  connection?: McpWebSocketConnectionState,
  modern?: ModernMcpRequestContext
): Promise<JsonRpcResponseBody> {
  // The wire the frame arrived on; drives the observed actor `transport` for non-MCP dispatch.
  const wire: "http" | "ws" = transport === "websocket-json-rpc" ? "ws" : "http";
  // Prefer the durable per-connection id (WebSocket) so an MCP client's tools/call chain shares one
  // session identity; fall back to the server-instance id for stateless HTTP JSON-RPC.
  const sessionId = connection?.sessionId ?? security.sessionId;
  const id = readJsonRpcId(payload.id);
  if (payload.jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "JSON-RPC requests require jsonrpc \"2.0\".");
  }
  if (typeof payload.method !== "string") {
    return jsonRpcError(id, -32600, "JSON-RPC requests require a string method.");
  }

  if (payload.method === "server/discover") {
    if (!modern) return jsonRpcError(id, -32601, "Unknown JSON-RPC method: server/discover.");
    return jsonRpcResult(id, modernMcpResult({ supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS], capabilities: { tools: {}, ...mcpResourceCapabilities(security.agentSnapshotSource) }, instructions: "Use read-only Motion tools for inspection and request only the lowest permission tier required. Mutations remain enforced by the authenticated server grant.", cacheScope: "private", update: security.updateController.summary() }, MOTION_ENGINE_VERSION));
  }
  if (modern && payload.method !== "tools/list" && payload.method !== "tools/call" && payload.method !== "initialize" && !mcpResourceMethods(security.agentSnapshotSource).includes(payload.method)) {
    return jsonRpcError(id, -32601, `Unknown modern MCP method: ${payload.method}.`);
  }

  if (payload.method === "rpc.discover") {
    const result = { ok: true, name: "shellx-motion-debug-server", transport, methods: [...JSON_RPC_METHODS, ...mcpResourceMethods(security.agentSnapshotSource)], contractCount: publishedDebugContracts(security).length, update: security.updateController.summary() };
    return jsonRpcResult(id, modern ? modernMcpResult(result, MOTION_ENGINE_VERSION) : result);
  }

  if (payload.method === "initialize") {
    if (modern) {
      return jsonRpcError(id, -32601, `initialize is a legacy MCP method; supported protocol versions: ${MCP_MODERN_PROTOCOL_VERSION}, ${MCP_LEGACY_PROTOCOL_VERSION}.`);
    }
    const params = objectRecord(payload.params ?? {}) ?? {};
    // Capture the MCP client's declared identity ("name/version") from the handshake and remember it
    // for the lifetime of this WebSocket connection, so later tools/call receipts can record which
    // agent drove them. Observed evidence — the client names itself here, before any tool runs.
    if (connection) {
      observeMcpInitialize(connection, params);
    }
    return jsonRpcResult(id, {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, ...mcpResourceCapabilities(security.agentSnapshotSource) },
      serverInfo: {
        name: "shellx-motion-debug-server",
        version: MOTION_ENGINE_VERSION,
        update: security.updateController.summary()
      }
    });
  }

  if (payload.method === "tools/list") {
    const result = {
      tools: publishedDebugContracts(security).map(mcpToolForDebugContract)
    };
    return jsonRpcResult(id, modern ? modernMcpResult(result, MOTION_ENGINE_VERSION) : result);
  }

  if (payload.method === "resources/list") {
    if (!security.agentSnapshotSource) return jsonRpcError(id, -32601, "Unknown JSON-RPC method: resources/list."); const result = mcpResourceList(security.agentSnapshotSource); return jsonRpcResult(id, modern ? modernMcpResult(result, MOTION_ENGINE_VERSION) : result);
  }
  if (payload.method === "resources/read") {
    if (!security.agentSnapshotSource) return jsonRpcError(id, -32601, "Unknown JSON-RPC method: resources/read.");
    const result = await readMcpResource(payload.params, security.agentSnapshotSource, async (fixed) => await readMotionAgentSnapshotResource(fixed, { ...dispatchContextBase(security, "read_motion"), callerId: authenticatedJobOwnerPrincipal(security.context.callerId, connection?.jobOwnerPrincipal), ...(fixed.packageRoot ? { snapshotPackageRoots: [fixed.packageRoot] } : { snapshotPackageRoots: [] }), ...(fixed.receiptsRoot ? { receiptsRoot: fixed.receiptsRoot } : {}), operatorReceiptRoots: [], actor: inferredServerActor({ wire, protocol: "mcp", grantedTier: "read_motion", sessionId, ...(modern?.clientInfo || connection?.clientInfo ? { clientInfo: modern?.clientInfo ?? connection?.clientInfo } : {}) }) }));
    return result.ok ? jsonRpcResult(id, modern ? modernMcpResult(result.result, MOTION_ENGINE_VERSION) : result.result) : jsonRpcError(id, -32602, result.message);
  }

  if (payload.method === "tools/call") {
    const params = objectRecord(payload.params ?? {});
    if (!params) {
      return jsonRpcError(id, -32602, "tools/call params must be a JSON object.");
    }
    const name = typeof params.name === "string" ? params.name : null;
    if (!name) {
      return jsonRpcError(id, -32602, "tools/call params require a string name.");
    }
    const contract = debugContractForMcpToolName(name);
    if (!contract) {
      return jsonRpcError(id, -32602, `Unknown Motion MCP tool: ${name}.`);
    }

    const toolArgs = objectRecord(params.arguments ?? {}) ?? {};
    const resolvedTier = resolveRequestedTier(toolArgs.requestedTier ?? toolArgs.tier, security.grantedTier);
    if (!resolvedTier.ok) return jsonRpcError(id, -32001, resolvedTier.message, resolvedTier);
    // Enforce the schema this tool ADVERTISES, before anything runs. Until this call existed the
    // listing published a schema nobody executed, so a wrong-TYPE argument came back as
    // "requires <name>" — indistinguishable from a missing one — and an undeclared property was
    // accepted with ok:true. See mcp-args-validation.ts.
    //
    // Order matters: shape is checked only for callers the permission gate will admit. An
    // under-privileged caller must keep hearing permission_denied, because no argument fix would
    // let its call through, and dispatch owns that verdict.
    const permitted = PERMISSION_TIER_RANK[contract.permission] <= PERMISSION_TIER_RANK[resolvedTier.tier];
    const invalidArgs = permitted
      ? validateMcpToolCall({ toolName: name, contract, toolArguments: params.arguments })
      : null;
    const result = invalidArgs ?? await dispatchGuarded(contract.command, toolArgs.args ?? {}, {
      ...dispatchContextBase(security, resolvedTier.tier),
      callerId: authenticatedJobOwnerPrincipal(security.context.callerId, connection?.jobOwnerPrincipal),
      // MCP tools/call: an AI agent driving the engine. Record the "mcp" transport, the granted tier,
      // this connection's session, and the handshake-declared client identity (when a WS connection
      // carried an initialize). See inferredServerActor.
      actor: inferredServerActor({
        wire, protocol: "mcp", grantedTier: resolvedTier.tier, sessionId,
        ...(modern?.clientInfo || connection?.clientInfo
          ? { clientInfo: modern?.clientInfo ?? connection?.clientInfo }
          : {})
      }),
      ...(connection?.observedMcpAgentSession ? { observedMcpAgentSession: connection.observedMcpAgentSession } : {})
    });
    const structuredContent = {
      ...result,
      command: contract.command
    };
    const callResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent)
        }
      ],
      structuredContent,
      isError: !result.ok
    };
    return jsonRpcResult(id, modern ? modernMcpResult(callResult, MOTION_ENGINE_VERSION) : callResult);
  }

  if (payload.method === "motion.debug.contracts") {
    return jsonRpcResult(id, {
      ok: true,
      transport,
      update: security.updateController.summary(),
      contracts: publishedDebugContracts(security)
    });
  }

  if (payload.method === "motion.debug.dispatch") {
    const params = objectRecord(payload.params ?? {});
    if (!params) {
      return jsonRpcError(id, -32602, "motion.debug.dispatch params must be a JSON object.");
    }
    const command = typeof params.command === "string" ? params.command : null;
    if (!command) {
      return jsonRpcError(id, -32602, "motion.debug.dispatch params require a string command.");
    }

    const resolvedTier = resolveRequestedTier(params.requestedTier ?? params.tier, security.grantedTier);
    if (!resolvedTier.ok) return jsonRpcError(id, -32001, resolvedTier.message, resolvedTier);
    // Same published schema `tools/call` enforces. `rpc.discover` offers both methods, so an agent
    // that picked this one must not get a different answer for the same arguments.
    const invalidArgs = validateRawDispatchArgs(command, params.args, resolvedTier.tier);
    const result = invalidArgs ?? await dispatchGuarded(command as MotionDebugCommand, params.args ?? {}, {
      ...dispatchContextBase(security, resolvedTier.tier),
      callerId: authenticatedJobOwnerPrincipal(security.context.callerId, connection?.jobOwnerPrincipal),
      // Non-MCP JSON-RPC dispatch over the raw wire (http or ws). Record the observed transport.
      actor: inferredServerActor({ wire, protocol: "raw", grantedTier: resolvedTier.tier, sessionId })
    });
    return jsonRpcResult(id, {
      ...result,
      command
    });
  }

  return jsonRpcError(id, -32601, `Unknown JSON-RPC method: ${payload.method}.`);
}

// Keep the loopback WS transport dependency-free; hosts only need JSON-RPC text frames.
function handleWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  security: MotionDebugServerSecurityContext
): boolean {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade;
  if (path !== "/ws" || request.method !== "GET" || typeof key !== "string" || upgrade?.toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return false;
  }
  if (!isAllowedHost(request.headers.host, security.allowedHosts)) {
    rejectWebSocketUpgrade(socket, 403, "Forbidden Host");
    return false;
  }
  const origin = requestOrigin(request);
  if (origin && !security.allowedOrigins.has(origin)) {
    rejectWebSocketUpgrade(socket, 403, "Forbidden Origin");
    return false;
  }
  if (!hasWebSocketCapability(request, security.capabilityToken)) {
    rejectWebSocketUpgrade(socket, 401, "Unauthorized");
    return false;
  }

  const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    `Sec-WebSocket-Protocol: ${WEBSOCKET_PROTOCOL}`,
    "\r\n"
  ].join("\r\n"));

  // One session identity for the lifetime of this connection, so an MCP client's initialize +
  // tools/call frames share a `sessionId` and the initialize-declared clientInfo carries forward.
  const connection: McpWebSocketConnectionState = {
    sessionId: `${security.sessionId}:ws-${randomBytes(4).toString("hex")}`,
    jobOwnerPrincipal: `job-${randomBytes(32).toString("hex")}`
  };

  let buffer: Buffer<ArrayBufferLike> = Buffer.concat([head]);
  const processing = createBoundedAsyncQueue(MAX_OUTSTANDING_WEBSOCKET_FRAMES, () => closeWebSocketWithPolicyError(socket, "WebSocket debug dispatch failed."));
  const consume = (chunk?: Buffer<ArrayBufferLike>): void => {
    if (chunk) buffer = Buffer.concat([buffer, chunk]);
    if (buffer.byteLength > MAX_REQUEST_BYTES + 14) {
      closeWebSocketWithPolicyError(socket, "WebSocket message exceeds the debug server byte limit.");
      buffer = Buffer.alloc(0);
      return;
    }
    const parsed = readWebSocketFrames(buffer, MAX_REQUEST_BYTES);
    if (parsed.error) {
      closeWebSocketWithPolicyError(socket, parsed.error);
      buffer = Buffer.alloc(0);
      return;
    }
    buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (!processing.enqueue(() => handleWebSocketFrame(socket, frame, security, connection))) {
        closeWebSocketWithPolicyError(socket, "WebSocket outstanding-frame limit reached.");
        buffer = Buffer.alloc(0);
        return;
      }
    }
  };

  socket.on("data", consume);
  // A closed socket must not retain an authorization fact in a long-lived server.
  socket.once("close", () => clearObservedMcpConnection(connection));
  socket.once("error", () => clearObservedMcpConnection(connection));
  if (buffer.length > 0) consume();
  return true;
}

async function handleWebSocketFrame(
  socket: Duplex,
  frame: WebSocketFrame,
  security: MotionDebugServerSecurityContext,
  connection: McpWebSocketConnectionState
): Promise<void> {
  if (frame.opcode === 0x8) {
    writeWebSocketFrame(socket, 0x8, Buffer.alloc(0));
    socket.end();
    return;
  }
  if (frame.opcode === 0x9) {
    writeWebSocketFrame(socket, 0xa, frame.payload);
    return;
  }
  if (frame.opcode !== 0x1) return;

  let payload: JsonRpcRequestBody;
  try {
    const text = frame.payload.toString("utf8").trim();
    if (frame.payload.byteLength > MAX_REQUEST_BYTES) throw new Error(`Motion debug WebSocket frame exceeds ${MAX_REQUEST_BYTES} bytes.`);
    const parsed: unknown = JSON.parse(text);
    payload = objectRecord(parsed) ? parsed as JsonRpcRequestBody : {};
  } catch {
    writeWebSocketText(socket, JSON.stringify(jsonRpcError(null, -32700, "WebSocket JSON-RPC frames must contain a JSON object.")));
    return;
  }

  writeWebSocketText(socket, JSON.stringify(await handleJsonRpcRequest(payload, security, "websocket-json-rpc", connection)));
}

function setBaseHeaders(response: ServerResponse, allowedOrigin: string | null): void {
  if (allowedOrigin) response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name");
  response.setHeader("cache-control", "no-store");
  response.setHeader("vary", "Origin");
  response.setHeader("x-content-type-options", "nosniff");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", JSON_CONTENT_TYPE);
  response.end(`${JSON.stringify(body)}\n`);
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponseBody {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

async function readJsonBody(request: IncomingMessage): Promise<DebugRequestBody & JsonRpcRequestBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new RawDebugRequestBodyTooLargeError(MAX_REQUEST_BYTES);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Motion debug request body must be a JSON object.");
  }
  return parsed as DebugRequestBody;
}

function readJsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null
    ? value
    : null;
}


function hasHttpCapability(request: IncomingMessage, capabilityToken: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  return secureTokenEqual(authorization.slice("Bearer ".length).trim(), capabilityToken);
}

function hasWebSocketCapability(request: IncomingMessage, capabilityToken: string): boolean {
  const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!protocols.includes(WEBSOCKET_PROTOCOL)) return false;
  const tokenProtocol = protocols.find((value) => value.startsWith(WEBSOCKET_TOKEN_PREFIX));
  return Boolean(tokenProtocol && secureTokenEqual(tokenProtocol.slice(WEBSOCKET_TOKEN_PREFIX.length), capabilityToken));
}

function secureTokenEqual(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function requestOrigin(request: IncomingMessage): string | null {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin.trim()) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim();
  }
}

function normalizeAllowedOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Motion debug allowed origin must use http(s): ${raw}`);
  }
  if (url.origin !== raw.replace(/\/$/, "")) {
    throw new Error(`Motion debug allowed origin must not include a path, query, or fragment: ${raw}`);
  }
  return url.origin;
}

/** Trim and null-normalize the configured update repository slug. */
function normalizeUpdateRepo(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** Parse a 1/true/yes env flag (used for the unsafe update-base development override). */
function isTruthyEnvFlag(raw: string | undefined): boolean {
  return /^(?:1|true|yes)$/i.test(raw?.trim() ?? "");
}

/** Trim and null-normalize the packaged-install root marker. */
function normalizeInstallRoot(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function normalizeAllowedHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /[\s/\\?#]/.test(trimmed)) throw new Error(`Invalid Motion debug allowed host: ${raw}`);
  return trimmed;
}

function isAllowedHost(raw: string | undefined, allowedHosts: Set<string>): boolean {
  return typeof raw === "string" && allowedHosts.has(raw.trim().toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function formatHostHeader(host: string, port: number): string {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized.includes(":") ? `[${normalized}]:${port}` : `${normalized}:${port}`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/**
 * Attach a browser-session handle only to the one Workbench preview command.
 * Debug/MCP callers keep their normal result shape and may never turn an
 * arbitrary path into a Workbench-readable artifact.
 */
function previewArtifactHandleForResult(
  command: MotionDebugCommand,
  result: MotionDebugResult,
  session: ReturnType<typeof workbenchArtifactSessionFromRequest>
): string | null {
  if (command !== "motion.preview.frame" || !result.ok || !session) return null;
  const output = objectRecord(objectRecord(result.result)?.output);
  const path = typeof output?.path === "string" && output.path ? output.path : null;
  return path ? mintWorkbenchArtifactHandle(session, path) : null;
}

/**
 * Catalog entries are the only server-derived source for poster handles. A raw
 * path parameter must never turn an authenticated browser into a filesystem
 * reader, even when the path happens to sit inside a template collection.
 */
function posterHandlesForResult(
  command: MotionDebugCommand,
  result: MotionDebugResult,
  session: ReturnType<typeof workbenchArtifactSessionFromRequest>
): Array<{ packageRoot: string; handle: string }> {
  if (command !== "motion.template.catalog" || !result.ok || !session) return [];
  const templates = objectRecord(result.result)?.templates;
  if (!Array.isArray(templates)) return [];
  const handles: Array<{ packageRoot: string; handle: string }> = [];
  for (const candidate of templates) {
    const template = objectRecord(candidate);
    const packageRoot = typeof template?.packageRoot === "string" && template.packageRoot ? template.packageRoot : null;
    const preview = objectRecord(template?.preview) ?? objectRecord(objectRecord(template?.metadata)?.preview);
    const poster = typeof preview?.poster === "string" && preview.poster ? preview.poster : null;
    if (!packageRoot || !poster) continue;
    handles.push({ packageRoot, handle: mintWorkbenchPosterHandle(session, resolve(packageRoot, poster)) });
  }
  return handles;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
