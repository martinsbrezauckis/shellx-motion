/** Semantic admission for completed platform-verification evidence. */

export interface PlatformVerificationReceiptProblem {
  path: string;
  message: string;
}

interface PlatformVerificationCommandContract {
  id: string;
  command: readonly string[];
  required: boolean;
  platforms?: readonly string[];
  requiresEncoders?: readonly string[];
  tier?: "extended";
}

// This is the shipping counterpart of the verifier's command contract. Receipt readers must know
// which command an id proves; schema shape alone cannot establish that a caller actually completed
// Motion's platform ladder.
const PLATFORM_VERIFICATION_COMMANDS: readonly PlatformVerificationCommandContract[] = [
  { id: "install", command: ["pnpm", "install", "--frozen-lockfile"], required: true },
  { id: "typecheck", command: ["pnpm", "typecheck"], required: true },
  { id: "test", command: ["pnpm", "test"], required: true },
  { id: "debug:coverage", command: ["pnpm", "run", "debug:coverage"], required: true },
  { id: "agent:smoke", command: ["pnpm", "run", "agent:smoke"], required: true, platforms: ["linux"] },
  { id: "agent-unavailable:smoke", command: ["pnpm", "run", "agent-unavailable:smoke"], required: true },
  { id: "debug-server:smoke", command: ["pnpm", "run", "debug-server:smoke"], required: true },
  { id: "debug-server-prompt:smoke", command: ["pnpm", "run", "debug-server-prompt:smoke"], required: true, platforms: ["linux"] },
  { id: "validate:fixtures", command: ["pnpm", "run", "validate:fixtures"], required: true },
  { id: "package-archive:smoke", command: ["pnpm", "run", "package-archive:smoke"], required: true },
  { id: "canvas-package-preview:smoke", command: ["pnpm", "run", "canvas-package-preview:smoke"], required: true, platforms: ["linux"] },
  { id: "evidence-surfaces:smoke", command: ["pnpm", "run", "evidence-surfaces:smoke"], required: true, platforms: ["linux"] },
  { id: "sandbox:probe", command: ["pnpm", "run", "sandbox:probe"], required: true },
  { id: "tracking:smoke", command: ["pnpm", "run", "tracking:smoke"], required: true },
  { id: "render:smoke", command: ["pnpm", "run", "render:smoke"], required: true },
  { id: "render-mp4:smoke", command: ["pnpm", "run", "render-mp4:smoke"], required: true },
  { id: "ffmpeg-acceleration:smoke", command: ["pnpm", "run", "ffmpeg-acceleration:smoke"], required: true },
  { id: "render-webm:smoke", command: ["pnpm", "run", "render-webm:smoke"], required: true },
  { id: "render-hevc:smoke", command: ["pnpm", "run", "render-hevc:smoke"], required: true, requiresEncoders: ["hevc"] },
  { id: "render-av1:smoke", command: ["pnpm", "run", "render-av1:smoke"], required: true, requiresEncoders: ["av1"] },
  { id: "render-audio:smoke", command: ["pnpm", "run", "render-audio:smoke"], required: true },
  { id: "render-caption:smoke", command: ["pnpm", "run", "render-caption:smoke"], required: true },
  { id: "render-alpha:smoke", command: ["pnpm", "run", "render-alpha:smoke"], required: true },
  { id: "render-gif:smoke", command: ["pnpm", "run", "render-gif:smoke"], required: true },
  { id: "render-jpeg:smoke", command: ["pnpm", "run", "render-jpeg:smoke"], required: true },
  { id: "browser:capture-smoke", command: ["pnpm", "run", "browser:capture-smoke"], required: true },
  { id: "workbench:ui-smoke", command: ["pnpm", "run", "workbench:ui-smoke"], required: true },
  { id: "source-storyboard:smoke", command: ["pnpm", "run", "source-storyboard:smoke"], required: true, platforms: ["linux"] },
  { id: "render-job-lifecycle:smoke", command: ["pnpm", "run", "render-job-lifecycle:smoke"], required: true, platforms: ["linux"] },
  { id: "render-batch:smoke", command: ["pnpm", "run", "render-batch:smoke"], required: true },
  { id: "template-pack:proof", command: ["pnpm", "run", "template-pack:proof"], required: true, tier: "extended", platforms: ["linux"] },
  { id: "connector:smoke", command: ["pnpm", "run", "connector:smoke"], required: true, platforms: ["linux"] },
  { id: "connector:template-cut-render-smoke", command: ["pnpm", "run", "connector:template-cut-render-smoke"], required: true, platforms: ["linux"] },
  { id: "connector:canvas-bridge-smoke", command: ["pnpm", "run", "connector:canvas-bridge-smoke"], required: false },
  { id: "connector:canvas-bridge-mp4-smoke", command: ["pnpm", "run", "connector:canvas-bridge-mp4-smoke"], required: false },
  { id: "connector:canvas-mp4-smoke", command: ["pnpm", "run", "connector:canvas-mp4-smoke"], required: true, platforms: ["linux"] },
  { id: "connector:script-cut-smoke", command: ["pnpm", "run", "connector:script-cut-smoke"], required: true, platforms: ["linux"] },
  { id: "connector:canvas-cut-smoke", command: ["pnpm", "run", "connector:canvas-cut-smoke"], required: false, platforms: ["linux"] }
];

const CANONICAL_HOST_PLATFORMS: Readonly<Record<string, string>> = {
  linux: "linux",
  windows: "win32",
  macos: "darwin"
};

const HOST_CONNECTOR_COMMAND_IDS = new Set([
  "connector:canvas-bridge-smoke",
  "connector:canvas-bridge-mp4-smoke",
  "connector:canvas-cut-smoke"
]);

/** The current declared command plan, copied for receipt construction without exposing mutable state. */
export function platformVerificationCommandContract(includeExtended = false): PlatformVerificationCommandContract[] {
  return PLATFORM_VERIFICATION_COMMANDS
    .filter((command) => includeExtended || command.tier !== "extended")
    .map((command) => ({
      ...command,
      command: [...command.command],
      ...(command.platforms ? { platforms: [...command.platforms] } : {}),
      ...(command.requiresEncoders ? { requiresEncoders: [...command.requiresEncoders] } : {})
    }));
}

/**
 * Reject receipt-shaped values that cannot establish completed platform evidence.
 *
 * This deliberately checks the same semantic facts the platform verifier uses when it accepts a
 * collected receipt: terminal state, authentic command identity, completed outcome evidence, and
 * exact command-summary reconciliation. It does not claim cryptographic provenance for a
 * host-writable receipt store; callers must still use the stable host-owned reader.
 */
export function platformVerificationReceiptSemanticProblems(receipt: Record<string, unknown>): PlatformVerificationReceiptProblem[] {
  if (receipt.schema === "shellx-motion/platform-verification@1") return hostReceiptProblems(receipt);
  if (receipt.schema === "shellx-motion/platform-verification-aggregate@1") return aggregateReceiptProblems(receipt);
  return [{ path: "/schema", message: "must identify a platform verification receipt" }];
}

function hostReceiptProblems(receipt: Record<string, unknown>): PlatformVerificationReceiptProblem[] {
  const problems: PlatformVerificationReceiptProblem[] = [];
  if (receipt.status !== "passed" && receipt.status !== "failed") {
    problems.push({ path: "/status", message: "must be a terminal passed or failed receipt" });
    return problems;
  }
  if (receipt.dryRun !== false) problems.push({ path: "/dryRun", message: "completed evidence cannot be dry-run" });
  const commands = Array.isArray(receipt.commands) ? receipt.commands : [];
  const commandRecords = commands.map(record).filter((command): command is Record<string, unknown> => command !== null);
  const byId = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < commands.length; index += 1) {
    const command = record(commands[index]);
    if (!command) {
      problems.push({ path: `/commands/${index}`, message: "must be an object" });
      continue;
    }
    const id = typeof command.id === "string" ? command.id : "";
    if (!id) {
      problems.push({ path: `/commands/${index}/id`, message: "must be a declared command id" });
      continue;
    }
    if (byId.has(id)) problems.push({ path: `/commands/${index}/id`, message: "must be unique" });
    else byId.set(id, command);
    const declared = PLATFORM_VERIFICATION_COMMANDS.find((candidate) => candidate.id === id);
    if (!declared) {
      problems.push({ path: `/commands/${index}/id`, message: "must name a command declared by this build" });
    } else if (!sameStringArray(command.command, declared.command)) {
      problems.push({ path: `/commands/${index}/command`, message: "must match this build's declared command" });
    }
    validateCompletedCommand(command, index, problems);
  }
  if (!sameCommandSummary(receipt.commandSummary, commandRecords)) {
    problems.push({ path: "/commandSummary", message: "must exactly reconcile the completed command list" });
  }
  if (receipt.status === "passed" && commandRecords.some((command) => command.status === "failed")) {
    problems.push({ path: "/status", message: "cannot pass while a planned command failed" });
  }

  const host = record(receipt.host);
  const hostId = typeof host?.id === "string" ? host.id : null;
  const hostPlatform = typeof host?.platform === "string" ? host.platform : null;
  const expectedPlatform = hostId ? CANONICAL_HOST_PLATFORMS[hostId] : undefined;
  if (expectedPlatform && hostPlatform !== expectedPlatform) {
    problems.push({ path: "/host/platform", message: `must be ${expectedPlatform} for host ${hostId}` });
  }
  if (receipt.status === "passed") {
    if (!hostPlatform) problems.push({ path: "/host/platform", message: "is required for passing evidence" });
    const includeExtended = receipt.includeExtended === true;
    for (const declared of PLATFORM_VERIFICATION_COMMANDS) {
      if (!declared.required || (declared.tier === "extended" && !includeExtended)) continue;
      const command = byId.get(declared.id);
      if (!command) {
        problems.push({ path: "/commands", message: `missing required platform command: ${declared.id}` });
        continue;
      }
      if (command.required !== true) {
        problems.push({ path: `/commands/${declared.id}/required`, message: "required platform command must be marked required" });
      }
      if (!acceptablePassedHostCommand(command, declared, hostPlatform, expectedPlatform, receipt.toolchain, receipt.modernCodecsRequired === true)) {
        problems.push({ path: `/commands/${declared.id}/status`, message: "cannot support a passed platform claim" });
      }
    }
  }
  return problems;
}

function aggregateReceiptProblems(receipt: Record<string, unknown>): PlatformVerificationReceiptProblem[] {
  const problems: PlatformVerificationReceiptProblem[] = [];
  if (receipt.status !== "passed" && receipt.status !== "failed") {
    problems.push({ path: "/status", message: "must be a terminal passed or failed aggregate" });
    return problems;
  }
  if (receipt.dryRun !== false) problems.push({ path: "/dryRun", message: "completed evidence cannot be dry-run" });
  if (receipt.status !== "passed") return problems;

  const requiredHosts = stringArray(receipt.requiredHosts);
  if (requiredHosts.length === 0) {
    problems.push({ path: "/requiredHosts", message: "must identify at least one host for a passed aggregate" });
  }
  if (new Set(requiredHosts).size !== requiredHosts.length) {
    problems.push({ path: "/requiredHosts", message: "must not contain duplicate hosts" });
  }
  if (!matchesDeclaredRequiredCommandPlan(receipt.requiredCommands, receipt.extendedTierRequired === true)) {
    problems.push({ path: "/requiredCommands", message: "must match this build's complete required command set" });
  }
  const entries = Array.isArray(receipt.receipts) ? receipt.receipts.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  const byHost = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const hostId = typeof entry.hostId === "string" ? entry.hostId : null;
    if (!hostId) {
      problems.push({ path: `/receipts/${index}/hostId`, message: "is required for a passed aggregate" });
      continue;
    }
    if (byHost.has(hostId)) problems.push({ path: `/receipts/${index}/hostId`, message: "must be unique" });
    else byHost.set(hostId, entry);
  }
  for (const hostId of requiredHosts) {
    const entry = byHost.get(hostId);
    if (!entry) {
      problems.push({ path: "/receipts", message: `missing required host evidence: ${hostId}` });
      continue;
    }
    if (entry.schemaOk !== true || entry.ok !== true || entry.status !== "passed" || entry.dryRun !== false) {
      problems.push({ path: `/receipts/${hostId}`, message: "must be completed passing evidence" });
    }
    const required = record(entry.requiredCommands);
    if (!required || !requiredCommandSummaryReconciles(required, stringArray(receipt.requiredCommands))) {
      problems.push({ path: `/receipts/${hostId}/requiredCommands`, message: "must reconcile required command evidence" });
    }
  }
  const summary = record(receipt.summary);
  if (!summary) {
    problems.push({ path: "/summary", message: "is required" });
    return problems;
  }
  if (summary.requiredHostCount !== requiredHosts.length || summary.satisfiedHostCount !== requiredHosts.length
    || stringArray(summary.missingHosts).length !== 0 || stringArray(summary.failedHosts).length !== 0 || summary.invalidReceiptCount !== 0) {
    problems.push({ path: "/summary", message: "must reconcile a passed complete host matrix" });
  }
  return problems;
}

function validateCompletedCommand(command: Record<string, unknown>, index: number, problems: PlatformVerificationReceiptProblem[]): void {
  if (!Number.isFinite(command.durationMs) || (command.durationMs as number) < 0) {
    problems.push({ path: `/commands/${index}/durationMs`, message: "must be a non-negative completed duration" });
  }
  if (command.status === "passed") {
    if (!Number.isInteger(command.exitCode) || command.exitCode !== 0 || command.signal !== null) {
      problems.push({ path: `/commands/${index}/exitCode`, message: "must be zero for a passed command" });
    }
  } else if (command.status === "failed") {
    if (!Number.isInteger(command.exitCode) || command.exitCode === 0) {
      problems.push({ path: `/commands/${index}/exitCode`, message: "must be non-zero for a failed command" });
    }
  } else if (command.status === "skipped") {
    if (typeof command.skipKind !== "string" || !command.skipKind || typeof command.skipReason !== "string" || !command.skipReason) {
      problems.push({ path: `/commands/${index}`, message: "a skipped command must retain skipKind and skipReason" });
    }
  } else {
    problems.push({ path: `/commands/${index}/status`, message: "must be passed, failed, or skipped in a completed receipt" });
  }
}

function acceptablePassedHostCommand(
  command: Record<string, unknown>,
  declared: PlatformVerificationCommandContract,
  hostPlatform: string | null,
  expectedPlatform: string | undefined,
  toolchain: unknown,
  modernCodecsRequired: boolean
): boolean {
  if (command.status === "passed") return true;
  if (command.status !== "skipped" || !hostPlatform) return false;
  if (command.skipKind === "platform-inapplicable") {
    return expectedPlatform === hostPlatform && Array.isArray(declared.platforms) && !declared.platforms.includes(hostPlatform);
  }
  if (modernCodecsRequired || command.skipKind !== "capability-absent" || !Array.isArray(declared.requiresEncoders)) return false;
  const encoderInventory = record(record(toolchain)?.encoders);
  if (encoderInventory?.status !== "passed") return false;
  const capabilities = encoderInventory.capabilities;
  const capabilityRecord = record(capabilities);
  return capabilityRecord !== null && declared.requiresEncoders.some((encoder) => capabilityRecord[encoder] !== true);
}

function matchesDeclaredRequiredCommandPlan(value: unknown, includeExtended: boolean): boolean {
  const standard = requiredCommandIds(includeExtended, false);
  return sameStringArray(value, standard) || sameStringArray(value, requiredCommandIds(includeExtended, true));
}

function requiredCommandIds(includeExtended: boolean, requireHostConnectors: boolean): string[] {
  return PLATFORM_VERIFICATION_COMMANDS
    .filter((command) => (command.required || (requireHostConnectors && HOST_CONNECTOR_COMMAND_IDS.has(command.id)))
      && (includeExtended || command.tier !== "extended"))
    .map((command) => command.id);
}

function sameCommandSummary(value: unknown, commands: Record<string, unknown>[]): boolean {
  const summary = record(value);
  if (!summary) return false;
  const expected = { total: commands.length, passed: 0, failed: 0, skipped: 0, skippedByKind: {} as Record<string, number> };
  for (const command of commands) {
    if (command.status === "passed") expected.passed += 1;
    else if (command.status === "failed") expected.failed += 1;
    else if (command.status === "skipped") {
      expected.skipped += 1;
      const kind = typeof command.skipKind === "string" && command.skipKind ? command.skipKind : "unspecified";
      expected.skippedByKind[kind] = (expected.skippedByKind[kind] ?? 0) + 1;
    }
  }
  return summary.total === expected.total && summary.passed === expected.passed && summary.failed === expected.failed
    && summary.skipped === expected.skipped && sameIntegerMap(summary.skippedByKind, expected.skippedByKind);
}

function requiredCommandSummaryReconciles(summary: Record<string, unknown>, expectedIds: string[]): boolean {
  const total = summary.total;
  const passed = summary.passed;
  if (typeof total !== "number" || !Number.isInteger(total) || total !== expectedIds.length
    || typeof passed !== "number" || !Number.isInteger(passed) || passed < 0) return false;
  if (!Array.isArray(summary.missing) || summary.missing.length > 0 || !Array.isArray(summary.failed) || summary.failed.length > 0
    || !Array.isArray(summary.capabilitySkipped) || !Array.isArray(summary.platformInapplicableSkipped)) return false;
  const capabilitySkipped = recordIds(summary.capabilitySkipped);
  const platformSkipped = recordIds(summary.platformInapplicableSkipped);
  const exceptional = [...capabilitySkipped, ...platformSkipped];
  return new Set(exceptional).size === exceptional.length
    && exceptional.every((id) => expectedIds.includes(id))
    && capabilitySkipped.every((id) => PLATFORM_VERIFICATION_COMMANDS.some((command) => command.id === id && command.requiresEncoders?.length))
    && platformSkipped.every((id) => PLATFORM_VERIFICATION_COMMANDS.some((command) => command.id === id && command.platforms?.length))
    && total === passed + exceptional.length;
}

function recordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).map((entry) => typeof entry?.id === "string" ? entry.id : "");
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function sameIntegerMap(value: unknown, expected: Record<string, number>): boolean {
  const recordValue = record(value);
  if (!recordValue) return false;
  const compareCodeUnits = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0;
  const actual = Object.entries(recordValue).sort(compareCodeUnits);
  const wanted = Object.entries(expected).sort(compareCodeUnits);
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
