/** Runtime launch-policy evidence. `requested` deliberately does not claim kernel enforcement. */
export interface ChromiumRuntimeSandboxEvidence {
  schema: "shellx-motion/runtime-sandbox@1";
  provider: "chromium";
  status: "requested" | "disabled";
  scope: "browser-process";
  reasonCode?: "trusted_host_opt_out" | "playwright_default_no_sandbox";
}

/** Concrete Bubblewrap evidence emitted only after the browser session was launched through it. */
export interface LinuxBubblewrapRuntimeSandboxEvidence {
  schema: "shellx-motion/runtime-sandbox@1";
  provider: "linux-bubblewrap";
  status: "enforced";
  scope: "browser-process";
  /** Immutable repository-owned launcher module selected by the trusted renderer host. */
  launcher: { path: string; sha256: string };
  /** Canonical Node interpreter whose directory pins the launcher's otherwise untrusted PATH lookup. */
  interpreter: { path: string; sha256: string };
  executable: { path: string; sha256: string; version?: string };
  policy: {
    network: "denied";
    packageFilesystem: "read-only";
    /** The root and /tmp are namespace-local tmpfs; only the private profile is host-backed writable. */
    writableFilesystem: "isolated-tmpfs-root-and-browser-profile";
    process: "new-pid-namespace";
    capabilities: "dropped";
    seccomp: "not-configured";
  };
}

export type LocalMotionRuntimeSandboxEvidence =
  | ChromiumRuntimeSandboxEvidence
  | LinuxBubblewrapRuntimeSandboxEvidence;

export function validateRuntimeSandboxEvidence(evidence: LocalMotionRuntimeSandboxEvidence): LocalMotionRuntimeSandboxEvidence {
  if (evidence.schema !== "shellx-motion/runtime-sandbox@1" || evidence.scope !== "browser-process") {
    throw new Error("Motion runtime sandbox evidence is invalid.");
  }
  if (evidence.provider === "chromium") {
    if (!(["requested", "disabled"] as const).includes(evidence.status)) {
      throw new Error("Chromium runtime sandbox evidence has an invalid status.");
    }
    if (evidence.status === "requested" && evidence.reasonCode !== undefined) {
      throw new Error("Requested runtime sandbox evidence must not include an opt-out reason.");
    }
    if (evidence.status === "disabled" && evidence.reasonCode !== "trusted_host_opt_out" && evidence.reasonCode !== "playwright_default_no_sandbox") {
      throw new Error("Disabled runtime sandbox evidence requires an explicit truthful reason.");
    }
    return { ...evidence };
  }
  if (
    evidence.provider !== "linux-bubblewrap"
    || evidence.status !== "enforced"
    || !/^\/[\s\S]+/.test(evidence.launcher.path)
    || !/^[a-f0-9]{64}$/.test(evidence.launcher.sha256)
    || !/^\/[\s\S]+/.test(evidence.interpreter.path)
    || !/^[a-f0-9]{64}$/.test(evidence.interpreter.sha256)
    || !/^\/[\s\S]+/.test(evidence.executable.path)
    || !/^[a-f0-9]{64}$/.test(evidence.executable.sha256)
    || evidence.policy.network !== "denied"
    || evidence.policy.packageFilesystem !== "read-only"
    || evidence.policy.writableFilesystem !== "isolated-tmpfs-root-and-browser-profile"
    || evidence.policy.process !== "new-pid-namespace"
    || evidence.policy.capabilities !== "dropped"
    || evidence.policy.seccomp !== "not-configured"
  ) {
    throw new Error("Linux Bubblewrap runtime sandbox evidence is invalid.");
  }
  return {
    ...evidence,
    launcher: { ...evidence.launcher },
    interpreter: { ...evidence.interpreter },
    executable: { ...evidence.executable },
    policy: { ...evidence.policy },
  };
}
