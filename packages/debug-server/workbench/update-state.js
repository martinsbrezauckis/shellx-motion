/**
 * update-state.js — pure, DOM-free view-model builder for the engine-room About
 * page's update flow.
 *
 * Role: map the GitHub-releases update contract (the states returned by the
 * server's shared cached update state plus explicit check/apply responses into an
 * honest, render-ready view-model. Startup, periodic, human, and agent views all
 * derive from the same server-side result.
 *
 * Contract states this module renders honestly:
 *   idle                     — before the startup check has completed.
 *   checking                 — a check is in flight.
 *   unconfigured             — no release channel configured for this build.
 *   up-to-date               — running the latest published release.
 *   update-available         — a newer release exists (version + notes + Apply).
 *   network-error            — the release channel could not be reached.
 *   endpoint-absent          — the update endpoint is not present in this server
 *                              build (e.g. the server half is not merged); handled
 *                              like the docs endpoints' degraded state.
 *   applying                 — an apply is in flight.
 *   applied                  — the update was actually applied (applied === true).
 *   source-workflow-required — the server truthfully declined to swap bytes because
 *                              Motion runs from a source checkout; the user updates
 *                              through their git/build workflow (mode source-checkout).
 *   manual-action-required   — the server truthfully declined an in-place update
 *                              because there is no signed release channel; the user
 *                              installs the release manually (mode manual-download).
 *   apply-error              — the apply failed.
 *
 * Truth invariant: the check + apply states are DERIVED from the server's real
 * structural contract (`ok`/`configured`/`upToDate` for a check; `ok`/`applied`/
 * `mode` for an apply), never from an invented `state` string the server never
 * sends. "applied" is claimed ONLY when the server reports `applied === true`.
 *
 * Dependencies: none (ES module, browser + Node compatible).
 * Primary callers: about.js (DOM rendering), update-state.test.ts (integration
 * contract test that pipes real server results through these functions).
 */

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");

function safeHttpUrl(value) {
  const raw = asString(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Normalize a raw `POST /workbench/update-check` response body into a canonical
 * update state kind, DERIVED from the server's real structural contract
 * (see workbench-update.ts `UpdateCheckResult`):
 *
 *   { ok:false, ... }                                  -> network-error
 *   { ok:true, configured:false, ... }                 -> unconfigured
 *   { ok:true, configured:true, upToDate:true, ... }   -> up-to-date
 *   { ok:true, configured:true, upToDate:false, ... }  -> update-available
 *
 * The server does NOT emit a `state`/`status`/`kind` discriminant string, so we
 * do not read one — deriving from the structural fields is the single source of
 * truth and avoids the previous defect where every unrecognized `ok:true` body
 * was mapped to a fabricated "up-to-date". An `ok:true` body we cannot
 * substantiate (no `configured:false` and no boolean `upToDate`) is reported as
 * `network-error` rather than an invented "all good" state.
 *
 * @param {object} body Parsed response body.
 * @returns {string} A canonical state kind.
 */
export function normalizeCheckState(body) {
  const record = asObject(body);
  if (record.ok !== true) return "network-error";
  if (record.configured === false) return "unconfigured";
  if (record.upToDate === true) return "up-to-date";
  if (record.upToDate === false) return "update-available";
  return "network-error";
}

/** Map `GET /workbench/update-state` to the same canonical states as a manual check. */
export function normalizeCachedUpdateState(body) {
  const record = asObject(body);
  if (record.status === "checking") return "checking";
  if (record.status === "not_checked") return "idle";
  if (record.status === "checked") return normalizeCheckState(asObject(record.result));
  return "network-error";
}

/**
 * Normalize a raw `POST /workbench/update-apply` response body into a canonical
 * apply-state kind, DERIVED from the server's real structural contract
 * (see workbench-update.ts `UpdateApplyResult`):
 *
 *   { ok:false, ... }                                  -> apply-error
 *   { ok:true, applied:true, ... }                     -> applied
 *   { ok:true, applied:false, mode:"manual-download" } -> manual-action-required
 *   { ok:true, applied:false, mode:"source-checkout" } -> source-workflow-required
 *
 * Truth invariant: "applied" is returned ONLY when the server reports
 * `applied === true`. The server's current honest responses are always
 * `applied:false` with a `mode`, which map to explicit action-required states
 * instead of a fabricated success. An `ok:true`/`applied:false` body with an
 * unrecognized mode conservatively maps to `source-workflow-required` (update via
 * your own source workflow) rather than claiming anything was applied.
 *
 * @param {object} body Parsed response body.
 * @returns {string} A canonical apply-state kind.
 */
export function normalizeApplyState(body) {
  const record = asObject(body);
  if (record.ok !== true) return "apply-error";
  if (record.applied === true) return "applied";
  if (asString(record.mode) === "manual-download") return "manual-action-required";
  return "source-workflow-required";
}

/**
 * Build the render-ready update view-model from a lifecycle kind plus optional
 * data (versions, notes URL, stable error code, apply result). Pure and total: every
 * kind maps to a defined view-model; unknown kinds render as an honest neutral
 * "unknown" state rather than throwing.
 *
 * @param {string} kind One of the contract/lifecycle state kinds above.
 * @param {object} [data] Optional fields:
 *   currentVersion, latestVersion, notesUrl, errorCode, checkedOut, ref.
 * @returns {{
 *   kind: string,
 *   tone: "neutral"|"positive"|"warn"|"danger",
 *   title: string,
 *   message: string,
 *   currentVersion: string,
 *   latestVersion: string,
 *   notesUrl: string,
 *   checkDisabled: boolean,
 *   showCheck: boolean,
 *   canApply: boolean,
 *   applyDisabled: boolean
 * }}
 */
export function buildUpdateView(kind, data = {}) {
  const currentVersion = asString(data.currentVersion);
  const latestVersion = asString(data.latestVersion);
  const notesUrl = asString(data.notesUrl);
  const errorCode = asString(data.errorCode);

  const base = {
    kind,
    tone: "neutral",
    title: "",
    message: "",
    currentVersion,
    latestVersion,
    notesUrl: safeHttpUrl(notesUrl),
    checkDisabled: false,
    showCheck: true,
    canApply: false,
    applyDisabled: false
  };

  switch (kind) {
    case "idle":
      return {
        ...base,
        title: "Waiting for the startup check",
        message: "The current release status will appear here as soon as Motion finishes its first check."
      };
    case "checking":
      return { ...base, title: "Checking the release channel…", message: "Checking the official release channel.", checkDisabled: true };
    case "unconfigured":
      return {
        ...base,
        tone: "neutral",
        title: "Update channel not configured",
        message: "This build does not have an update channel."
      };
    case "up-to-date":
      return {
        ...base,
        tone: "positive",
        title: "Up to date",
        message: currentVersion
          ? `You are running the latest published release (${currentVersion}).`
          : "You are running the latest published release."
      };
    case "update-available":
      return {
        ...base,
        tone: "warn",
        title: "Update available",
        message: latestVersion
          ? `Version ${latestVersion} is available${currentVersion ? ` (you have ${currentVersion})` : ""}.`
          : "A newer release is available.",
        canApply: true
      };
    case "network-error":
      return {
        ...base,
        tone: "danger",
        title: "Could not reach the release channel",
        message: friendlyUpdateError(errorCode)
      };
    case "endpoint-absent":
      return {
        ...base,
        tone: "neutral",
        title: "Update checks unavailable in this build",
        message: "This Motion build cannot check the release channel."
      };
    case "applying":
      return { ...base, title: "Preparing the update…", message: "Checking the supported installation method.", checkDisabled: true, canApply: true, applyDisabled: true };
    case "applied":
      return {
        ...base,
        tone: "positive",
        title: "Update applied",
        message: buildAppliedMessage(data),
        canApply: false
      };
    case "source-workflow-required":
      return {
        ...base,
        tone: "warn",
        title: "This copy cannot update itself",
        message: "Install the new version through the same method used for this copy, then restart Motion.",
        canApply: false
      };
    case "manual-action-required":
      return {
        ...base,
        tone: "warn",
        title: "Download required",
        message: "Open the release page and install the latest verified version.",
        canApply: false
      };
    case "apply-error":
      return {
        ...base,
        tone: "danger",
        title: "Update failed to apply",
        message: "Motion could not install the update. The current installation was left unchanged.",
        canApply: true
      };
    default:
      return { ...base, title: "Update status unknown", message: "The update state could not be determined." };
  }
}

function friendlyUpdateError(code) {
  if (code === "update_feed_timeout") {
    return "The release channel did not respond in time. Motion will try again automatically, or you can check now.";
  }
  if (code === "update_feed_network_blocked") {
    return "This network did not allow Motion to reach the release channel. Motion will try again automatically.";
  }
  if (["update_feed_invalid", "update_feed_wrong_content_type", "update_feed_too_large", "update_feed_redirect_blocked"].includes(code)) {
    return "The release channel returned an invalid response, so Motion ignored it and kept the current installation unchanged.";
  }
  if (code === "update_feed_unavailable") {
    return "The release channel is not available yet. Motion will try again automatically, or you can check now.";
  }
  return "The release channel could not be reached. Motion will try again automatically, or you can check now.";
}

/**
 * Compose the user-facing applied message without exposing install internals.
 *
 * @param {object} data Apply result fields (latestVersion, ref, checkedOut).
 * @returns {string} The applied-state message.
 */
function buildAppliedMessage(data) {
  const version = asString(data.latestVersion);
  const ref = asString(data.ref);
  const checkedOut = data.checkedOut === true;
  const target = version || ref;
  if (!checkedOut) {
    return "Motion could not confirm that installation finished. Keep the current version running and check again.";
  }
  return target
    ? `Version ${target} is ready. Restart Motion to use it.`
    : "The update is ready. Restart Motion to use it.";
}
