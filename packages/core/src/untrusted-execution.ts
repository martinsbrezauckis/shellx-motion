import type { MotionDocument } from "./types";
import {
  probeLocalMotionSandboxCapability,
  type LocalMotionSandboxCapabilityReport,
  type LocalMotionSandboxProbeServices,
} from "./sandbox-capability";

/**
 * Trust classification for a package at the point it is about to enter a renderer.
 *
 * This is deliberately inferred from executable layer kinds, never from provenance, a package
 * flag, or an agent prompt. An untrusted package must not be able to nominate itself as trusted.
 */
export type MotionPackageExecutionTrust =
  | { classification: "data-only"; activeLayerIds: [] }
  | { classification: "active-content"; activeLayerIds: string[] };

/** Current and historical layer names that cause renderer-hosted JavaScript to execute. */
const ACTIVE_CONTENT_LAYER_TYPES = new Set(["web", "html", "canvas"]);

/** Inspect whether rendering this document would execute package-provided active content. */
export function classifyMotionPackageExecutionTrust(motion: Pick<MotionDocument, "layers">): MotionPackageExecutionTrust {
  const activeLayerIds = motion.layers
    .filter((layer) => ACTIVE_CONTENT_LAYER_TYPES.has(layer.type))
    .map((layer) => layer.id);
  return activeLayerIds.length === 0
    ? { classification: "data-only", activeLayerIds: [] }
    : { classification: "active-content", activeLayerIds };
}

/** A typed, fail-closed refusal for a host that requested enforced untrusted execution. */
export class UntrustedMotionExecutionRefusal extends Error {
  constructor(
    readonly code:
      | "active_content_refused"
      | "sandbox_unavailable"
      | "unsupported_platform"
      | "untrusted_network_configuration_refused"
      | "chromium_sandbox_opt_out_refused"
      | "untrusted_browser_launcher_override_refused",
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = "UntrustedMotionExecutionRefusal";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Refuse active package content before a browser, parser, or runtime is launched.
 *
 * Trusted-local agent-authored scripting is a host-owned execution policy and is intentionally
 * not represented here. Package provenance, including a claimed creator, never bypasses this
 * gate; a host must choose a separate trusted-local execution path explicitly.
 */
export function assertDataOnlyForUntrustedExecution(motion: Pick<MotionDocument, "layers">): void {
  const trust = classifyMotionPackageExecutionTrust(motion);
  if (trust.classification === "data-only") return;
  throw new UntrustedMotionExecutionRefusal(
    "active_content_refused",
    `Enforced untrusted execution refuses package active content in layer(s): ${trust.activeLayerIds.join(", ")}.`,
    { activeLayerIds: trust.activeLayerIds }
  );
}

export interface EnforcedLinuxBubblewrapCapability {
  provider: "linux-bubblewrap";
  platform: "linux";
  executable: {
    path: string;
    sha256: string;
    version?: string;
  };
  probe: LocalMotionSandboxCapabilityReport["probe"];
}

export interface EnforcedLinuxBubblewrapServices {
  probe?: (services?: LocalMotionSandboxProbeServices) => Promise<LocalMotionSandboxCapabilityReport>;
  probeServices?: LocalMotionSandboxProbeServices;
}

/**
 * Resolve the one provider currently allowed for enforced untrusted rendering.
 *
 * A normal optional capability report is not upgraded to enforcement by wishful thinking: this
 * function accepts only a successful Linux Bubblewrap probe with a pinned executable identity.
 * Windows AppContainer and macOS helper work remain intentionally unavailable here, so callers
 * refuse instead of falling back to the ambient user account.
 */
export async function requireEnforcedLinuxBubblewrap(
  services: EnforcedLinuxBubblewrapServices = {}
): Promise<EnforcedLinuxBubblewrapCapability> {
  const report = await (services.probe ?? probeLocalMotionSandboxCapability)(services.probeServices);
  if (report.platform !== "linux") {
    throw new UntrustedMotionExecutionRefusal(
      "unsupported_platform",
      `Enforced untrusted execution currently supports Linux Bubblewrap only; received ${report.platform}.`,
      { platform: report.platform, provider: report.provider, status: report.status, reasonCode: report.reasonCode }
    );
  }
  if (
    report.provider !== "linux-bubblewrap"
    || report.status !== "available"
    || !report.executable
  ) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      `Enforced untrusted execution requires a verified Linux Bubblewrap provider; ${report.provider} is ${report.status}.`,
      { provider: report.provider, status: report.status, reasonCode: report.reasonCode, probe: report.probe }
    );
  }
  return {
    provider: "linux-bubblewrap",
    platform: "linux",
    executable: {
      path: report.executable.path,
      sha256: report.executable.sha256,
      ...(report.executable.version ? { version: report.executable.version } : {}),
    },
    probe: report.probe,
  };
}
