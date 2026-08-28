/** C1's human-only local-effect manager: bearer, bootstrap operator cookie, and host picker. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MotionDebugContext } from "@shellx-motion/debug-api";
import type { EffectModuleRegistryAuthority } from "@shellx-motion/renderer-browser/internal/effect-modules";
import { runEffectModuleManifestPicker, type WorkbenchPathPicker } from "./workbench-path-picker.js";
import { PERMISSION_TIER_RANK, debugServerError } from "./transport-refusals.js";

const WORKBENCH_OPERATOR_COOKIE = "shellx_motion_workbench_operator";
const MAX_EFFECT_MODULE_REQUEST_BYTES = 1_000_000;

export interface EffectModuleWorkbenchSecurity {
  grantedTier: MotionDebugContext["tier"];
  /** Private host authority; routes never accept a registry root, provider, or browser control. */
  effectModules: EffectModuleRegistryAuthority | null;
  /** Bootstrap-derived HttpOnly secret, distinct from the ordinary bearer. */
  workbenchOperatorSession: string | null;
  /** Loopback Workbench origins allowed to present the operator cookie. */
  workbenchOrigins: Set<string>;
  /** Native host picker; its selected path never crosses the HTTP boundary. */
  pathPicker: WorkbenchPathPicker;
}

export function effectModuleOperatorSessionCookie(value: string): string {
  return `${WORKBENCH_OPERATOR_COOKIE}=${value}; Path=/workbench/effect-modules; HttpOnly; SameSite=Strict`;
}

/**
 * C1 intentionally has no debug command, MCP tool, SDK route, or caller-supplied filesystem
 * parameter. These Workbench endpoints are the only manager plane and require a capability bearer
 * plus the HttpOnly, same-origin session that a one-use bootstrap minted.
 */
export async function handleEffectModuleWorkbenchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  security: EffectModuleWorkbenchSecurity
): Promise<void> {
  if (PERMISSION_TIER_RANK[security.grantedTier] < PERMISSION_TIER_RANK.write_local) {
    writeJson(response, 403, debugServerError("permission_denied", `Effect-module management requires write_local; this server holds ${security.grantedTier}.`));
    return;
  }
  if (!security.effectModules) {
    writeJson(response, 503, debugServerError("effect_modules_unavailable", "This host did not configure the private local effect-module registry."));
    return;
  }
  if (!hasEffectModuleWorkbenchOperatorSession(request, security)) {
    writeJson(response, 403, debugServerError("operator_session_required", "Effect-module management requires the same-origin operator session created by Start Motion."));
    return;
  }

  try {
    if (request.method === "POST" && path === "/workbench/effect-modules") {
      if (!hasJsonContentType(request) || !isExactObject(await readJsonBody(request), [])) {
        writeJson(response, 400, debugServerError("invalid_request", "Effect-module listing requires an empty JSON object."));
        return;
      }
      writeJson(response, 200, { ok: true, entries: await security.effectModules.list() });
      return;
    }
    if (request.method === "POST" && path === "/workbench/effect-modules/install") {
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Effect-module install requires application/json."));
        return;
      }
      if (!isExactObject(await readJsonBody(request), [])) {
        writeJson(response, 400, debugServerError("invalid_request", "Effect-module install accepts no caller controls; choose the manifest in the native picker."));
        return;
      }
      const selection = await runEffectModuleManifestPicker(security.pathPicker);
      if (!selection.ok) {
        writeJson(response, selection.status, debugServerError(selection.code, selection.message));
        return;
      }
      if (selection.cancelled) {
        writeJson(response, 200, { ok: true, cancelled: true });
        return;
      }
      const pending = await security.effectModules.prepareInstallFromManifestFile(selection.path);
      writeJson(response, 200, { ok: true, cancelled: false, pending });
      return;
    }
    if (request.method === "POST" && (path === "/workbench/effect-modules/confirm" || path === "/workbench/effect-modules/cancel")) {
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", `Effect-module ${path.endsWith("/confirm") ? "confirmation" : "cancellation"} requires application/json.`));
        return;
      }
      const body = await readJsonBody(request);
      if (!isExactObject(body, ["confirmationId"]) || typeof body.confirmationId !== "string") {
        writeJson(response, 400, debugServerError("invalid_request", `Effect-module ${path.endsWith("/confirm") ? "confirmation" : "cancellation"} requires only an opaque confirmationId.`));
        return;
      }
      const result = path.endsWith("/confirm")
        ? await security.effectModules.confirmInstall(body.confirmationId)
        : await security.effectModules.cancelInstall(body.confirmationId);
      writeJson(response, 200, { ok: true, result });
      return;
    }

    const route = parseEffectModuleEntryRoute(path);
    if (route && !route.action && request.method === "POST") {
      if (!hasJsonContentType(request) || !isExactObject(await readJsonBody(request), [])) {
        writeJson(response, 400, debugServerError("invalid_request", "Effect-module inspection requires an empty JSON object."));
        return;
      }
      const entry = await security.effectModules.inspect(route.moduleId, route.version);
      if (!entry) {
        writeJson(response, 404, debugServerError("not_found", "The requested local effect-module version is not installed."));
        return;
      }
      writeJson(response, 200, { ok: true, entry });
      return;
    }
    if (route?.action === "revoke" && request.method === "POST") {
      if (!hasJsonContentType(request)) {
        writeJson(response, 415, debugServerError("unsupported_media_type", "Effect-module revocation requires application/json."));
        return;
      }
      if (!isExactObject(await readJsonBody(request), [])) {
        writeJson(response, 400, debugServerError("invalid_request", "Effect-module revocation accepts no caller controls."));
        return;
      }
      writeJson(response, 200, { ok: true, result: await security.effectModules.revoke(route.moduleId, route.version) });
      return;
    }
    writeJson(response, 404, debugServerError("not_found", "Unknown Workbench effect-module route."));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "effect_module_failed";
    writeJson(response, 400, debugServerError(code, error instanceof Error ? error.message : "Effect-module management failed."));
  }
}

function parseEffectModuleEntryRoute(path: string): { moduleId: string; version: string; action?: "revoke" } | null {
  const parts = path.split("/");
  if (parts[0] !== "" || parts[1] !== "workbench" || parts[2] !== "effect-modules" || (parts.length !== 5 && parts.length !== 6)) return null;
  try {
    const moduleId = decodeURIComponent(parts[3]!);
    const version = decodeURIComponent(parts[4]!);
    if (!moduleId || !version || (parts.length === 6 && parts[5] !== "revoke")) return null;
    return parts.length === 6 ? { moduleId, version, action: "revoke" } : { moduleId, version };
  } catch {
    return null;
  }
}

function hasEffectModuleWorkbenchOperatorSession(request: IncomingMessage, security: EffectModuleWorkbenchSecurity): boolean {
  const origin = requestOrigin(request);
  if (!origin || !security.workbenchOrigins.has(origin) || !security.workbenchOperatorSession) return false;
  const cookie = requestCookie(request, WORKBENCH_OPERATOR_COOKIE);
  return Boolean(cookie && secureTokenEqual(cookie, security.workbenchOperatorSession));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_EFFECT_MODULE_REQUEST_BYTES) throw new Error(`Effect-module request body exceeds ${MAX_EFFECT_MODULE_REQUEST_BYTES} bytes.`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Effect-module request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}
function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}
function requestOrigin(request: IncomingMessage): string | null {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin.trim()) return null;
  try { return new URL(origin).origin; } catch { return origin.trim(); }
}
function requestCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length > 8192) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator >= 1 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim() || null;
  }
  return null;
}
function secureTokenEqual(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
