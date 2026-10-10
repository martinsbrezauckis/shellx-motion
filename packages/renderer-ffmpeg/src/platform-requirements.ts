/**
 * Shared platform readiness for CLI, Debug API, SDK and Workbench callers.
 *
 * Motion uses external FFmpeg for encoding and FFprobe for delivered-media inspection.
 * A result distinguishes a successful probe (`ok`) from an available capability
 * (`satisfied`). Missing or broken tools can therefore be reported without claiming
 * that the probe itself failed.
 *
 * Readiness is scoped to an operation. Preview may need no external tool, final
 * encoding needs FFmpeg, and quality readback needs FFprobe. Route-specific needs,
 * such as Chromium for the browser frame lane, come from `platform-operations.ts`.
 *
 * Tool descriptions and installation guidance come from `tool-requirements.ts`.
 * Probes are injected so this module does not import its own package entry point.
 */
import {
  defaultMotionHostRenderCapacity,
  type MotionHostRenderCapacity,
  type MotionToolIdentity,
  type MotionToolName,
  type MotionToolSource,
} from "@shellx-motion/core";
import {
  motionOperationReadinessList,
  motionToolRequiredForOperations,
  type MotionOperationReadiness,
  type MotionRequirementOperation
} from "./platform-operations.js";
// What may leave this module in a field a host prints. Extracted so one rule covers every string
// a third-party binary supplied — see that module's header.
import { boundedVersion, redactedDetail } from "./report-redaction.js";
import {
  MOTION_TOOL_ABSENT_PROBLEM,
  MOTION_TOOL_BROKEN_PROBLEM,
  MOTION_TOOL_OVERRIDE_ENV_VAR,
  MOTION_TOOL_REQUIRED_FOR_TEXT,
  motionToolDownloadUrl,
  motionToolInstallOptions,
  type MotionToolInstallOption
} from "./tool-requirements.js";

// Receipt vocabulary lives in core (a receipt carries it and hosts read it); the operation model
// lives next door. Both are re-exported here so every requirements consumer has ONE import site for
// the whole surface.
export type { MotionToolIdentity, MotionToolName, MotionToolSource } from "@shellx-motion/core";
export {
  MOTION_REQUIREMENT_OPERATIONS,
  type MotionOperationAlternative,
  type MotionOperationReadiness,
  type MotionRequirementOperation
} from "./platform-operations.js";
// The version cap moved with the code that enforces it; re-exported because it is a published
// constant hosts and tests read from this module.
export { MOTION_TOOL_VERSION_MAX_CHARS } from "./report-redaction.js";

/** Schema id so a host can version-check a stored or transported requirements result. */
export const MOTION_PLATFORM_REQUIREMENTS_SCHEMA = "shellx-motion/platform-requirements@1";

/**
 * What the probe learned about one tool.
 *
 *   - `ready`      — it ran and answered a version probe.
 *   - `missing`    — it is not installed, or not on PATH (an ENOENT-shaped failure).
 *   - `broken`     — it exists but the probe failed: a bad install, a permissions problem, a
 *                    resource-governor rejection, a timeout. Telling this user to "install FFmpeg"
 *                    would send them to repair something that is not wrong, which is exactly why
 *                    this is a distinct state rather than a second flavour of `missing`.
 *   - `unverified` — no probe was run for this tool in this call.
 */
export type MotionToolStatus = "ready" | "missing" | "broken" | "unverified";

/** One tool's full report: identity, readiness, what it is needed for, and how to install it. */
export interface MotionToolReport extends MotionToolIdentity {
  status: MotionToolStatus;
  /** Convenience mirror of `status === "ready"`, kept for the pre-existing `present` contract. */
  present: boolean;
  /**
   * Sentence naming what Motion cannot do without this tool, and what still works. Kept as prose
   * because it is the published contract ShellX Cut and the integration spec already read.
   */
  requiredFor: string;
  /** The same fact machine-readably: operations that cannot run without this tool. */
  requiredForOperations: MotionRequirementOperation[];
  /**
   * Plain-language statement of the problem. Absent when the tool is ready.
   *
   * This is the one field that may name a path, and only when the path is a value the OPERATOR set
   * (a rejected `SHELLX_MOTION_BROWSER` pin). Redacting it would defeat its purpose — a user
   * looking for their own typo needs to see the string they typed — and it is not machine-private
   * discovery the way a scanned install location is. Everything Motion found for itself is reduced:
   * `executable` to a basename, `detail` to `<path>`.
   */
  problem?: string;
  /**
   * The probe error, for a caller that needs to tell missing from broken itself.
   *
   * Absolute paths are replaced with `<path>` and control characters removed before it gets here:
   * this object is returned by `motion.platform.requirements` to any `read_motion` caller and
   * printed by `doctor --json`, so it redacts to the same standard as `executable`.
   */
  detail?: string;
  installOptions: MotionToolInstallOption[];
  downloadUrl: string;
  overrideEnvVar: string;
}

/**
 * The shared result. Every Motion surface returns THIS object (a host may wrap it in its own
 * envelope, but never reshapes or re-derives it).
 */
export interface MotionPlatformRequirements {
  schema: typeof MOTION_PLATFORM_REQUIREMENTS_SCHEMA;
  /** Did the probe run? See the module header — this is not the capability answer. */
  ok: true;
  /** Is every tool Motion needs ready? The capability answer a host branches on. */
  satisfied: boolean;
  /** Tools that are not `ready`. */
  missingCount: number;
  tools: MotionToolReport[];
  operations: MotionOperationReadiness[];
  /** Stable per-process capacity used by render admission and the local job governor. */
  capacity: MotionHostRenderCapacity;
}

/** What one tool's probe reported. Supplied by the caller so this module never spawns a process. */
export interface MotionToolProbeResult {
  tool: MotionToolName;
  source: MotionToolSource;
  /** The resolved executable, absolute or bare. Reduced to a basename before it reaches a report. */
  resolvedFrom: string;
  status: Exclude<MotionToolStatus, "unverified">;
  version?: string;
  detail?: string;
  /**
   * Plain-language problem statement that REPLACES the generic per-status sentence.
   *
   * Supplied only when the prober knows something the status alone cannot express — a
   * `SHELLX_MOTION_BROWSER` pin that names a path with no file at it is `broken`, but "found but
   * did not answer a version probe" would be a false description of it, and the one fact the
   * operator needs is which value was rejected.
   */
  problem?: string;
  /**
   * Extra sentences appended after `problem`, for facts the generic prose cannot know.
   *
   * The case this exists for: Motion refused to execute a browser out of a directory other users
   * can write. Without saying so, the report reads "no browser found" and sends a CI user to
   * install a browser into the same rejected cache, forever. Every note must already be free of
   * machine-private paths, because `problem` is printed verbatim.
   */
  notes?: string[];
}


/**
 * Reduce a probed executable + version line to redacted identity.
 *
 * The path is discarded down to its basename: a receipt is shared evidence, and an absolute path
 * names a user's home directory, their username and their product install layout. `source` carries
 * the part that actually matters for reproduction — whether the binary came from PATH, from an
 * explicit override, or from a bundled ShellX copy.
 *
 * @param probe What the caller's probe observed.
 * @returns Identity safe to persist in a public artifact.
 */
export function motionToolIdentity(probe: Pick<MotionToolProbeResult, "tool" | "source" | "resolvedFrom" | "version">): MotionToolIdentity {
  const version = boundedVersion(probe.version);
  return {
    tool: probe.tool,
    source: probe.source,
    executable: executableBasename(probe.resolvedFrom, probe.tool),
    ...(version ? { version } : {})
  };
}

function executableBasename(resolvedFrom: string, tool: MotionToolName): string {
  const trimmed = resolvedFrom.trim();
  if (!trimmed) return tool;
  // Split on both separators: a Windows override reaches a Linux CI run verbatim in test fixtures.
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? tool;
}

/** Build one tool's report from its probe result. */
export function motionToolReport(probe: MotionToolProbeResult, platform: NodeJS.Platform = process.platform): MotionToolReport {
  const identity = motionToolIdentity(probe);
  // A prober-supplied sentence wins over the generic one. The generic sentences describe what the
  // STATUS means in general; a prober that already knows the specific cause (an unusable
  // `SHELLX_MOTION_BROWSER` pin) would otherwise have that fact overwritten by prose that is
  // literally untrue of it.
  const baseProblem = probe.problem
    ?? (probe.status === "missing"
      ? MOTION_TOOL_ABSENT_PROBLEM[probe.tool]
      : probe.status === "broken"
        ? MOTION_TOOL_BROKEN_PROBLEM[probe.tool]
        : undefined);
  const problem = baseProblem
    ? [baseProblem, ...(probe.notes ?? [])].join(" ")
    : undefined;
  const detail = probe.detail ? redactedDetail(probe.detail) : undefined;
  return {
    ...identity,
    status: probe.status,
    present: probe.status === "ready",
    requiredFor: MOTION_TOOL_REQUIRED_FOR_TEXT[probe.tool],
    requiredForOperations: motionToolRequiredForOperations(probe.tool),
    ...(problem ? { problem } : {}),
    ...(detail ? { detail } : {}),
    installOptions: motionToolInstallOptions(probe.tool, platform),
    downloadUrl: motionToolDownloadUrl(probe.tool),
    overrideEnvVar: MOTION_TOOL_OVERRIDE_ENV_VAR[probe.tool]
  };
}

/**
 * Assemble the shared result from per-tool reports.
 *
 * `satisfied` is the AND over every operation's readiness rather than "no tool is missing", so the
 * two can never drift: adding an optional tool that no operation requires cannot silently flip a
 * machine to unsatisfied. Note what that means once routes exist — a machine with no Chromium is
 * reported unsatisfied, because its `render` WILL fail. That is the intended reading: the machine
 * is not ready for the command as documented, and `operations[].alternative` says what to run
 * instead rather than leaving the user to discover the failure.
 *
 * @param tools One report per probed tool, in a stable order.
 */
export function motionPlatformRequirements(
  tools: MotionToolReport[],
  capacity: MotionHostRenderCapacity = defaultMotionHostRenderCapacity,
): MotionPlatformRequirements {
  const ready = new Set(tools.filter((tool) => tool.status === "ready").map((tool) => tool.tool));
  const operations = motionOperationReadinessList(ready);
  return {
    schema: MOTION_PLATFORM_REQUIREMENTS_SCHEMA,
    ok: true,
    satisfied: operations.every((operation) => operation.satisfied),
    missingCount: tools.filter((tool) => tool.status !== "ready").length,
    tools,
    operations,
    capacity,
  };
}

/**
 * Readiness for one named operation, for a caller that asked about a specific intent.
 *
 * @param requirements A result from {@link motionPlatformRequirements}.
 * @param operation The operation the caller is about to attempt.
 */
export function motionOperationReadiness(
  requirements: MotionPlatformRequirements,
  operation: MotionRequirementOperation
): MotionOperationReadiness {
  return requirements.operations.find((entry) => entry.operation === operation)
    ?? { operation, satisfied: true, blockedBy: [], possible: true };
}

/**
 * The human-readable report `shellx-motion doctor` prints, rendered from the shared result so the text a
 * user reads and the JSON a host reads can never disagree.
 */
export function motionRequirementsReport(requirements: MotionPlatformRequirements): string {
  const lines: string[] = ["ShellX Motion — environment check", ""];
  for (const tool of requirements.tools) {
    lines.push(tool.status === "ready"
      ? `  OK       ${tool.tool}  ${tool.version ?? ""}`.trimEnd()
      : `  ${tool.status.toUpperCase().padEnd(7)}  ${tool.tool}`);
    lines.push(`           needed for: ${tool.requiredFor}`);
    if (tool.status !== "ready") {
      lines.push(`           ${tool.problem}`);
      lines.push("           install it with one of:");
      for (const option of tool.installOptions) lines.push(`             ${option.via.padEnd(20)} ${option.command}`);
      lines.push(`           already installed elsewhere? set ${tool.overrideEnvVar}=/path/to/${tool.tool}`);
      lines.push(`           downloads: ${tool.downloadUrl}`);
    }
    lines.push("");
  }
  lines.push("What this machine can do right now:");
  for (const operation of requirements.operations) {
    if (operation.satisfied) {
      lines.push(`  YES  ${operation.operation}`);
      continue;
    }
    lines.push(`  NO   ${operation.operation}  (needs ${operation.blockedBy.join(", ")})`);
    // A blocked default that another route rescues must print the route HERE, next to the "NO".
    // A user who reads only this block would otherwise install a browser they do not need.
    if (operation.alternative) {
      lines.push(operation.alternative.packageDependent
        ? `       may run with: ${operation.alternative.flag}  (depends on the package — read this first)`
        : `       runs today with: ${operation.alternative.flag}`);
      lines.push(`       ${operation.alternative.tradeoff}`);
    }
  }
  lines.push("");
  lines.push("Adaptive render capacity:");
  lines.push(`  per-job RSS  ${formatGib(requirements.capacity.jobs.maxProcessTreeRssBytes)} (${requirements.capacity.source})`);
  lines.push(`  points/layer ${requirements.capacity.points.maxPointsPerLayer} (${requirements.capacity.points.tier})`);
  return lines.join("\n");
}

function formatGib(bytes: number): string {
  return `${Number((bytes / (1024 ** 3)).toFixed(2))} GiB`;
}
