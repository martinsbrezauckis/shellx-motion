/**
 * Opaque Workbench preview handles, bound to one browser session.
 *
 * A debug result may name a host path for its owning caller, but a later HTTP
 * image request must not turn that path into authority for every bearer that
 * can reach the server. The Workbench obtains an HttpOnly session cookie after
 * authenticating and receives opaque handles only for previews it requested.
 *
 * This is deliberately process-local: a server restart drops both the browser
 * sessions and their handles, so no path-bearing capability becomes durable.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const WORKBENCH_ARTIFACT_SESSION_COOKIE = "shellx_motion_workbench_artifact_session";
const MAX_SESSIONS = 16;
const MAX_HANDLES_PER_SESSION = 128;

export interface WorkbenchArtifactSession {
  readonly token: string;
  readonly artifacts: Map<string, string>;
  readonly posters: Map<string, string>;
}

/** Opaque state; construct it only with {@link createWorkbenchArtifactSessions}. */
export interface WorkbenchArtifactSessions {
  readonly sessions: WorkbenchArtifactSession[];
}

export function createWorkbenchArtifactSessions(): WorkbenchArtifactSessions {
  return { sessions: [] };
}

/**
 * Reuse this browser's existing session or mint a bounded, HttpOnly session.
 * The caller has already passed the Debug bearer/origin/host boundary; this
 * session adds the missing logical-caller boundary for artifact follow-ups.
 */
export function establishWorkbenchArtifactSession(
  request: IncomingMessage,
  state: WorkbenchArtifactSessions
): WorkbenchArtifactSession {
  const existing = workbenchArtifactSessionFromRequest(request, state);
  if (existing) return existing;
  if (state.sessions.length >= MAX_SESSIONS) state.sessions.shift();
  const session: WorkbenchArtifactSession = {
    token: randomBytes(32).toString("base64url"),
    artifacts: new Map(),
    posters: new Map()
  };
  state.sessions.push(session);
  return session;
}

export function workbenchArtifactSessionCookie(session: WorkbenchArtifactSession): string {
  // Handles are minted by POST /debug and redeemed under /workbench, so the
  // session must cover both same-origin paths. HttpOnly and SameSite=Strict
  // keep it unavailable to page scripts and cross-site requests.
  return `${WORKBENCH_ARTIFACT_SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict`;
}

export function workbenchArtifactSessionFromRequest(
  request: IncomingMessage,
  state: WorkbenchArtifactSessions
): WorkbenchArtifactSession | null {
  const token = requestCookie(request, WORKBENCH_ARTIFACT_SESSION_COOKIE);
  if (!token) return null;
  return state.sessions.find((session) => secureTokenEqual(token, session.token)) ?? null;
}

/** Mint an unguessable handle for an already-produced preview path. */
export function mintWorkbenchArtifactHandle(session: WorkbenchArtifactSession, path: string): string {
  if (session.artifacts.size >= MAX_HANDLES_PER_SESSION) {
    const oldest = session.artifacts.keys().next().value;
    if (typeof oldest === "string") session.artifacts.delete(oldest);
  }
  const handle = `wa_${randomBytes(32).toString("base64url")}`;
  session.artifacts.set(handle, path);
  return handle;
}

/** A handle is useful only to the Workbench browser session it was minted for. */
export function resolveWorkbenchArtifactHandle(
  session: WorkbenchArtifactSession | null,
  handle: string | null
): string | null {
  if (!session || !handle) return null;
  return session.artifacts.get(handle) ?? null;
}

/** Mint an unguessable handle for a poster declared by this caller's catalog response. */
export function mintWorkbenchPosterHandle(session: WorkbenchArtifactSession, path: string): string {
  if (session.posters.size >= MAX_HANDLES_PER_SESSION) {
    const oldest = session.posters.keys().next().value;
    if (typeof oldest === "string") session.posters.delete(oldest);
  }
  const handle = `wp_${randomBytes(32).toString("base64url")}`;
  session.posters.set(handle, path);
  return handle;
}

/** A poster handle is useful only to the Workbench browser session it was minted for. */
export function resolveWorkbenchPosterHandle(
  session: WorkbenchArtifactSession | null,
  handle: string | null
): string | null {
  if (!session || !handle) return null;
  return session.posters.get(handle) ?? null;
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
