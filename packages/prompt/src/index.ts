import { createHash } from "node:crypto";
import { ACTIONS, planAction, tierRefusal, type MotionActionPlan, type MotionPermissionTier } from "@shellx-motion/actions";
import {
  buildAgentRuntime,
  type AgentPromptResult,
  type AgentRuntime,
  type RunAgentPromptInput
} from "@shellx-motion/agent-runtime";
import {
  createAgentAuthoringJob,
  type AgentAuthoringJob,
  type AgentAuthoringJobEvent,
  type AgentAuthoringPlanSummary
} from "@shellx-motion/core";

export type MotionPromptRuntime = Pick<AgentRuntime, "runPrompt">;

export interface RunMotionPromptInput {
  request: string;
  tier: MotionPermissionTier;
  runtime?: MotionPromptRuntime;
  agentId?: string;
  packageId?: string;
  cwd?: string;
  now?: () => string;
  retention?: PromptRetentionInput;
}

export type PromptRawRetentionPurpose = "user_requested_replay" | "debugging";

export type PromptRetentionInput =
  | { mode: "summary_only" }
  | {
      mode: "raw_request";
      deleteAfter: string;
      purpose: PromptRawRetentionPurpose;
    };

/**
 * The retention state a prompt receipt records about its own request content.
 *
 * Three states, not two, because raw retention is a lifecycle rather than a flag:
 * - `summary_only` — the default; the receipt never carried the raw request.
 * - `raw_request` with `rawRequestRetained: true` — the caller opted in with a bounded
 *   `deleteAfter` deadline and a declared purpose, and `output.rawRequest` is present.
 * - `raw_request` with `rawRequestRetained: false` and `rawRequestRedactedAt` — the deadline
 *   passed and {@link redactExpiredRawPrompt} removed the raw content. `deleteAfter` and
 *   `purpose` stay on the record so the receipt still proves what was promised and when the
 *   promise was honored, without keeping the content the promise was about. Receipts never
 *   START in this state; it exists only as the output of the redaction transform.
 */
export type PromptRetentionRecord =
  | {
      mode: "summary_only";
      rawRequestRetained: false;
      summaryRedacted: true;
      summaryMaxBytes: number;
    }
  | {
      mode: "raw_request";
      rawRequestRetained: true;
      summaryRedacted: true;
      summaryMaxBytes: number;
      deleteAfter: string;
      purpose: PromptRawRetentionPurpose;
    }
  | {
      mode: "raw_request";
      rawRequestRetained: false;
      summaryRedacted: true;
      summaryMaxBytes: number;
      deleteAfter: string;
      purpose: PromptRawRetentionPurpose;
      /** ISO timestamp of the moment the raw content was actually removed from this receipt. */
      rawRequestRedactedAt: string;
    };

export type MotionPromptResult =
  | {
      ok: true;
      plan: MotionActionPlan;
      agent: Extract<AgentPromptResult, { ok: true }>;
      receipt: PromptRunReceipt;
    }
  | {
      ok: false;
      plan?: MotionActionPlan;
      /** Failure evidence is optional: agent_unavailable has no receipt. */
      agent?: Extract<AgentPromptResult, { ok: false }>;
      // Preserve Debug API refusal detail rather than flattening it at this boundary.
      error: { code: string; message: string; suggestedAction?: string; detail?: unknown };
      receipt?: PromptRunReceipt;
    };

export interface PromptRunReceipt {
  schema: "shellx-motion/receipt@1";
  id: string;
  operation: "prompt.run";
  status: "passed" | "failed";
  packageId: string;
  inputHashes: Record<string, string>;
  createdAt: string;
  lane: "agent";
  output: {
    agentId?: string;
    agentReceiptId?: string;
    agentReceiptPath?: string;
    requestSummary: string;
    requestSummaryTruncated: boolean;
    promptRetention: PromptRetentionRecord;
    rawRequest?: string;
    debugCommands: string[];
    executedCommands?: Array<{ command: string; ok: boolean; receiptId?: string }>;
    linkedReceiptIds?: string[];
    planTopic: string;
    authoringJob: AgentAuthoringJob;
    events: AgentAuthoringJobEvent[];
    eventCount: number;
    lastEventSeq: number;
    lastEventAt?: string;
    mutationPolicy: AgentAuthoringJob["mutationPolicy"];
  };
  warnings: string[];
}

const TIER_ORDER: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];
const ACTION_PERMISSION_BY_ID = new Map(ACTIONS.map((action) => [action.id, action.permission]));
export const PROMPT_SUMMARY_MAX_BYTES = 512;
export const RAW_PROMPT_RETENTION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const COMMAND_TIERS: Record<string, MotionPermissionTier> = {
  "motion.state": "read_motion",
  "motion.open": "read_motion",
  "motion.select": "read_motion",
  "motion.highlight": "read_motion",
  "motion.preview.frame": "render_motion",
  "motion.preview.panel": "read_motion",
  "motion.preview.playhead": "render_motion",
  "motion.preview.strip": "render_motion",
  "motion.render.cancel": "render_motion",
  "motion.render.retry": "render_motion",
  "motion.render.status": "read_motion",
  "motion.render.queue": "read_motion",
  "motion.packages.browse": "read_motion",
  "motion.receipts.list": "read_motion",
  "motion.receipts.read": "read_motion",
  "motion.receipts.panel": "read_motion",
  "motion.assets.panel": "read_motion",
  "motion.brand.panel": "read_motion",
  "motion.audio.panel": "read_motion",
  "motion.export.panel": "read_motion",
  "motion.timeline.panel": "read_motion",
  "motion.template.catalog": "read_motion",
  "motion.template.plan": "read_motion",
  "motion.template.panel": "read_motion",
  "motion.actions.panel": "read_motion",
  "motion.actions.find": "read_motion",
  "motion.actions.guide": "read_motion",
  "motion.actions.plan": "read_motion",
  "motion.agent.health": "read_motion",
  "motion.agent.transcript": "read_motion",
  "motion.timeline.duration.policy": "read_motion",
  "motion.timeline.duration.policy.set": "edit_motion",
  "motion.timeline.scene.create": "edit_motion",
  "motion.timeline.scene.delete": "edit_motion",
  "motion.timeline.scene.reorder": "edit_motion",
  "motion.timeline.scene.name.set": "edit_motion",
  "motion.timeline.layer.create": "edit_motion",
  "motion.timeline.layer.text.set": "edit_motion",
  "motion.timeline.layer.style.set": "edit_motion",
  "motion.timeline.layer.transform.set": "edit_motion",
  "motion.timeline.layer.effect.set": "edit_motion",
  "motion.timeline.layer.blend.set": "edit_motion",
  "motion.timeline.layer.crop.set": "edit_motion",
  "motion.timeline.layer.mask.set": "edit_motion",
  "motion.timeline.layer.fit.set": "edit_motion",
  "motion.timeline.layer.media.set": "edit_motion",
  "motion.timeline.layer.name.set": "edit_motion",
  "motion.timeline.layer.visibility.set": "edit_motion",
  "motion.timeline.layer.lock": "edit_motion",
  "motion.timeline.track.create": "edit_motion",
  "motion.timeline.track.reorder": "edit_motion",
  "motion.timeline.track.delete": "edit_motion",
  "motion.timeline.track.rename": "edit_motion",
  "motion.prompt.run": "draft_motion",
  "motion.script.compile": "write_local",
  "motion.support.bundle": "write_local",
  "motion.package.patch": "edit_motion"
};

export async function runMotionPrompt(input: RunMotionPromptInput): Promise<MotionPromptResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const packageId = input.packageId ?? "unknown";
  const retention = resolvePromptRetention(input.retention, createdAt);
  if (!retention.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_prompt_retention",
        message: retention.message
      }
    };
  }
  const plan = planAction(input.request);
  const requiredTier = requiredTierForPlan(plan);
  const debugCommands = plan.steps.map((step) => step.call);

  if (!hasTier(input.tier, requiredTier)) {
    // Same class as the dispatch tier gate: this refusal used to name the required tier and stop,
    // leaving the caller with no idea who could grant it. See permission-refusal.ts in actions.
    return {
      ok: false,
      plan,
      error: tierRefusal({ subject: "Prompt plan", requiredTier, grantedTier: input.tier })
    };
  }

  const runtime = input.runtime ?? buildAgentRuntime();
  const prompt = createAgentPrompt(input.request, plan);
  const agentInput: RunAgentPromptInput = {
    agentId: input.agentId,
    prompt,
    cwd: input.cwd,
    packageId,
    permission: input.tier
  };
  const agent = await runtime.runPrompt(agentInput);

  if (!agent.ok) {
    const receiptError = {
      code: agent.error.code,
      message: "Local agent prompt execution failed; inspect the linked agent result for bounded diagnostics."
    };
    return {
      ok: false,
      plan,
      ...(agent.receipt ? { agent } : {}),
      error: agent.error,
      receipt: finalizePromptReceipt(createPromptReceipt({
        request: input.request,
        retention: retention.value,
        packageId,
        createdAt,
        status: "failed",
        plan,
        debugCommands,
        agentId: input.agentId ?? (agent.receipt ? String(agent.receipt.output.agentId) : undefined),
        agentReceiptId: agent.receipt?.id,
        error: receiptError,
        warnings: withRetentionWarning([`Agent prompt failed with code ${safeErrorCode(agent.error.code)}.`], retention.value)
      }), retention.value, now)
    };
  }

  return {
    ok: true,
    plan,
    agent,
    receipt: finalizePromptReceipt(createPromptReceipt({
      request: input.request,
      retention: retention.value,
      packageId,
      createdAt,
      status: "passed",
      plan,
      debugCommands,
      agentId: input.agentId ?? String(agent.receipt.output.agentId),
      agentReceiptId: agent.receipt.id,
      warnings: withRetentionWarning(
        agent.receipt.warnings.length > 0
          ? [`Linked agent receipt ${agent.receipt.id} contains ${agent.receipt.warnings.length} bounded warning(s).`]
          : [],
        retention.value
      )
    }), retention.value, now)
  };
}

// `createFakePromptRuntime` used to live here and was therefore an export of the published package.
// A prompt run driven by it returns real receipts over a stubbed agent transcript, which is exactly
// the shape production success has — so it belonged in test scaffolding, not on the public surface
// It now lives in `./index.test-support`, which the build never emits.

function createAgentPrompt(request: string, plan: MotionActionPlan): string {
  return [
    "You are running as a ShellX Motion local CLI subscription agent.",
    "Return JSON only. Do not mutate files unless the plan includes a mutation command.",
    `User request JSON: ${JSON.stringify(request)}`,
    "Debug command plan:",
    ...plan.steps.map((step) => `${step.order}. ${step.call} - ${step.purpose}`),
    "Verification:",
    ...plan.verify.map((item) => `- ${item}`)
  ].join("\n");
}

function requiredTierForPlan(plan: MotionActionPlan): MotionPermissionTier {
  return plan.steps.reduce<MotionPermissionTier>((required, step) => {
    const tier = plan.action?.calls.includes(step.call)
      ? plan.action.permission
      : ACTION_PERMISSION_BY_ID.get(step.call) ?? COMMAND_TIERS[step.call] ?? "read_motion";
    return maxTier(required, tier);
  }, plan.action?.permission ?? "read_motion");
}

function createPromptReceipt(input: {
  request: string;
  retention: PromptRetentionRecord;
  packageId: string;
  createdAt: string;
  status: "passed" | "failed";
  plan: MotionActionPlan;
  debugCommands: string[];
  agentId?: string;
  agentReceiptId?: string;
  error?: { code: string; message: string; detail?: string };
  warnings: string[];
}): PromptRunReceipt {
  const requestHash = sha256(input.request);
  const id = `prompt-${sha256(`${requestHash}:${input.createdAt}:${input.status}`).slice(0, 16)}`;
  const requestSummary = summarizePromptPlan(input.plan, input.debugCommands);
  const authoringJob = createAgentAuthoringJob({
    jobId: id,
    packageId: input.packageId,
    brief: requestSummary.value,
    status: input.status === "passed" ? "succeeded" : "failed",
    createdAt: input.createdAt,
    plan: agentAuthoringPlanSummary(input.plan, input.debugCommands, requestSummary.value),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.error ? { error: input.error } : {})
  });
  const lastEvent = authoringJob.eventLog.at(-1);
  return {
    schema: "shellx-motion/receipt@1",
    id,
    operation: "prompt.run",
    status: input.status,
    packageId: input.packageId,
    inputHashes: {
      request: requestHash,
      plan: sha256(JSON.stringify(input.plan.steps))
    },
    createdAt: input.createdAt,
    lane: "agent",
    output: {
      agentId: input.agentId,
      agentReceiptId: input.agentReceiptId,
      ...(input.agentReceiptId ? { linkedReceiptIds: [input.agentReceiptId] } : {}),
      requestSummary: requestSummary.value,
      requestSummaryTruncated: requestSummary.truncated,
      promptRetention: input.retention,
      // A redacted record must never re-embed the raw request it exists to remove.
      ...(input.retention.mode === "raw_request" && input.retention.rawRequestRetained ? { rawRequest: input.request } : {}),
      debugCommands: input.debugCommands,
      planTopic: requestSummary.value,
      authoringJob,
      events: authoringJob.eventLog,
      eventCount: authoringJob.eventLog.length,
      lastEventSeq: lastEvent?.seq ?? 0,
      ...(lastEvent?.at ? { lastEventAt: lastEvent.at } : {}),
      mutationPolicy: authoringJob.mutationPolicy
    },
    warnings: input.warnings
  };
}

function finalizePromptReceipt(receipt: PromptRunReceipt, retention: PromptRetentionRecord, now: () => string): PromptRunReceipt { return retention.mode === "raw_request" ? redactExpiredRawPrompt(receipt, now()).receipt : receipt; }
function agentAuthoringPlanSummary(plan: MotionActionPlan, debugCommands: string[], safeTopic: string): AgentAuthoringPlanSummary {
  return {
    topic: safeTopic,
    ...(plan.action?.id ? { actionId: plan.action.id } : {}),
    debugCommands,
    verify: plan.verify,
    cautions: plan.cautions
  };
}

function hasTier(actual: MotionPermissionTier, required: MotionPermissionTier): boolean {
  return TIER_ORDER.indexOf(actual) >= TIER_ORDER.indexOf(required);
}

function maxTier(left: MotionPermissionTier, right: MotionPermissionTier): MotionPermissionTier {
  return hasTier(left, right) ? left : right;
}

function resolvePromptRetention(
  input: PromptRetentionInput | undefined,
  createdAt: string
): { ok: true; value: PromptRetentionRecord } | { ok: false; message: string } {
  if (!input || input.mode === "summary_only") {
    return {
      ok: true,
      value: {
        mode: "summary_only",
        rawRequestRetained: false,
        summaryRedacted: true,
        summaryMaxBytes: PROMPT_SUMMARY_MAX_BYTES
      }
    };
  }
  if (input.mode !== "raw_request") {
    return { ok: false, message: "Prompt retention mode must be summary_only or raw_request." };
  }
  if (input.purpose !== "user_requested_replay" && input.purpose !== "debugging") {
    return { ok: false, message: "Raw prompt retention requires purpose user_requested_replay or debugging." };
  }
  const createdAtMs = Date.parse(createdAt);
  const deleteAfterMs = Date.parse(input.deleteAfter);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(deleteAfterMs)) {
    return { ok: false, message: "Raw prompt retention requires valid createdAt and deleteAfter timestamps." };
  }
  if (deleteAfterMs <= createdAtMs) {
    return { ok: false, message: "Raw prompt retention deleteAfter must be later than the prompt creation time." };
  }
  if (deleteAfterMs - createdAtMs > RAW_PROMPT_RETENTION_MAX_MS) {
    return { ok: false, message: "Raw prompt retention cannot exceed 30 days." };
  }
  return {
    ok: true,
    value: {
      mode: "raw_request",
      rawRequestRetained: true,
      summaryRedacted: true,
      summaryMaxBytes: PROMPT_SUMMARY_MAX_BYTES,
      deleteAfter: new Date(deleteAfterMs).toISOString(),
      purpose: input.purpose
    }
  };
}

/**
 * Stable prefix of every warning {@link redactExpiredRawPrompt} appends. Exported so receipt
 * stores and panels can detect (and avoid re-appending) a redaction notice without matching the
 * timestamp-bearing tail of the message.
 */
export const RAW_PROMPT_REDACTION_WARNING_PREFIX = "Raw prompt redacted:";

/**
 * The structural slice of a receipt the raw-prompt lifecycle can act on.
 *
 * Deliberately minimal so the transform accepts both this package's typed
 * {@link PromptRunReceipt} and a loosely-parsed persisted receipt (`OperationReceipt` in
 * `@shellx-motion/core`, whose `output` is `unknown` after `JSON.parse`). The read path that
 * must enforce expiry sees receipts in the second shape, and an enforcement gate that only
 * worked on freshly-created receipts would miss exactly the receipts the finding is about.
 */
export interface RawPromptRetentionEnforceable {
  operation: string;
  output: unknown;
  warnings: string[];
}

/**
 * Read-time enforcement and purge transform for the raw-prompt retention promise.
 *
 * WHY THIS EXISTS: `resolvePromptRetention` validates `deleteAfter` at creation, but validation
 * alone made the deadline a recorded wish — nothing in the repository ever consumed it, so a raw
 * prompt persisted past its promised deletion date. This
 * function is the mechanism that consumes the deadline. The contract for every reader of
 * persisted prompt receipts:
 *
 * 1. Route each `prompt.run` receipt through this transform before returning it to any caller.
 *    A reader must never hand out `output.rawRequest` at or past `deleteAfter`.
 * 2. When `redacted` is `true` and the receipt came from a rewritable store, persist the
 *    returned receipt back over the stored one. That write IS the purge: read-time redaction
 *    alone would leave the raw bytes on disk, and a purge without read-time redaction would
 *    leave a window between the deadline and the next sweep. The pair closes both.
 *
 * FAIL CLOSED: if `output.rawRequest` is present but the retention record does not
 * affirmatively prove a live deadline — record missing, malformed, wrong mode,
 * `rawRequestRetained` not `true`, unparsable `deleteAfter`, or an unparsable `now` — the raw
 * content is removed anyway. Raw prompt content survives a read only on positive proof that it
 * is still inside its promised window. The boundary instant is also closed: at exactly
 * `deleteAfter` the content is already gone (`now >= deleteAfter` redacts).
 *
 * Deliberately pure and free of file IO: the hardened receipt reader (O_NOFOLLOW, size caps,
 * TOCTOU re-stats) lives in `@shellx-motion/debug-api`, and duplicating file access here would
 * create a second, weaker reader. Idempotent: a receipt already redacted (no `rawRequest` key)
 * passes through unchanged, so stores may apply it on every read.
 *
 * @param receipt Any receipt; non-`prompt.run` operations pass through untouched (`prompt.run`
 *   receipts are the only ones this repository ever writes `output.rawRequest` into).
 * @param now ISO timestamp for "now", injectable for tests and deterministic replays; defaults
 *   to the wall clock. An unparsable value redacts (fail closed) rather than extending retention.
 * @returns The same receipt object (`redacted: false`) when nothing had to change — reference
 *   equality lets callers skip a no-op persist — or a rewritten copy (`redacted: true`) with
 *   `output.rawRequest` removed, the retention record moved to its redacted state (kept as-is
 *   when it was malformed, because a malformed record is evidence), and a
 *   {@link RAW_PROMPT_REDACTION_WARNING_PREFIX} warning appended.
 */
export function redactExpiredRawPrompt<T extends RawPromptRetentionEnforceable>(
  receipt: T,
  now?: string
): { receipt: T; redacted: boolean } {
  if (receipt.operation !== "prompt.run") return { receipt, redacted: false };
  const output = receipt.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return { receipt, redacted: false };
  const outputRecord = output as Record<string, unknown>;
  if (!("rawRequest" in outputRecord)) return { receipt, redacted: false };
  const verdict = rawPromptRetentionVerdict(outputRecord.promptRetention, now);
  if (verdict.kind === "live") return { receipt, redacted: false };
  const { rawRequest: _removed, ...retainedOutput } = outputRecord;
  const redactedOutput =
    verdict.kind === "expired" ? { ...retainedOutput, promptRetention: verdict.redactedRecord } : retainedOutput;
  return {
    // The cast is sound by construction: the transform only deletes the optional `rawRequest`
    // key, rewrites `promptRetention` within its declared union, and appends to `warnings` —
    // every other property of T is spread through unchanged.
    receipt: {
      ...receipt,
      output: redactedOutput,
      warnings: [...new Set([...receipt.warnings, verdict.warning])]
    } as T,
    redacted: true
  };
}

type RawPromptRetentionVerdict =
  | { kind: "live" }
  | { kind: "expired"; redactedRecord: PromptRetentionRecord; warning: string }
  | { kind: "malformed"; warning: string };

/**
 * Decides whether a persisted retention record still proves a live raw-retention window.
 *
 * Operates on `unknown` because persisted receipts arrive as parsed JSON with no type
 * guarantees; every field is re-proven here rather than trusted. `malformed` and `expired` are
 * distinct verdicts because their evidence differs: an expired record is rewritten to the
 * redacted state (the promise was kept), while a malformed record is left in place untouched —
 * rewriting it would destroy the evidence of what was actually stored.
 */
function rawPromptRetentionVerdict(retention: unknown, nowInput: string | undefined): RawPromptRetentionVerdict {
  const record =
    typeof retention === "object" && retention !== null && !Array.isArray(retention)
      ? (retention as Record<string, unknown>)
      : null;
  const purpose = record?.purpose;
  const deleteAfter = record?.deleteAfter;
  if (
    !record
    || record.mode !== "raw_request"
    || record.rawRequestRetained !== true
    || typeof deleteAfter !== "string"
    || (purpose !== "user_requested_replay" && purpose !== "debugging")
  ) {
    return {
      kind: "malformed",
      warning: `${RAW_PROMPT_REDACTION_WARNING_PREFIX} the retention record did not prove a live deletion deadline, so the raw request was removed (fail closed).`
    };
  }
  const deleteAfterMs = Date.parse(deleteAfter);
  const nowMs = Date.parse(nowInput ?? new Date().toISOString());
  if (!Number.isFinite(deleteAfterMs) || !Number.isFinite(nowMs)) {
    return {
      kind: "malformed",
      warning: `${RAW_PROMPT_REDACTION_WARNING_PREFIX} the retention deadline could not be evaluated, so the raw request was removed (fail closed).`
    };
  }
  if (nowMs < deleteAfterMs) return { kind: "live" };
  const deleteAfterIso = new Date(deleteAfterMs).toISOString();
  const redactedAtIso = new Date(nowMs).toISOString();
  return {
    kind: "expired",
    redactedRecord: {
      mode: "raw_request",
      rawRequestRetained: false,
      summaryRedacted: true,
      summaryMaxBytes: typeof record.summaryMaxBytes === "number" ? record.summaryMaxBytes : PROMPT_SUMMARY_MAX_BYTES,
      deleteAfter: deleteAfterIso,
      purpose,
      rawRequestRedactedAt: redactedAtIso
    },
    warning: `${RAW_PROMPT_REDACTION_WARNING_PREFIX} retention deadline ${deleteAfterIso} passed; the raw request was removed at ${redactedAtIso}.`
  };
}

function summarizePromptPlan(
  plan: MotionActionPlan,
  debugCommands: string[]
): { value: string; truncated: boolean } {
  const classification = plan.action?.id ?? "unmatched_request";
  const commands = debugCommands.length > 0 ? debugCommands.join(", ") : "none";
  const summary = `Motion request classified as ${classification}; planned commands: ${commands}.`;
  const value = takeUtf8Bytes(summary, PROMPT_SUMMARY_MAX_BYTES);
  return { value, truncated: Buffer.byteLength(summary, "utf8") > PROMPT_SUMMARY_MAX_BYTES };
}

function withRetentionWarning(warnings: string[], retention: PromptRetentionRecord): string[] {
  // Readers redact past the deadline; a redacted state never announces active retention.
  return retention.mode === "raw_request" && retention.rawRequestRetained
    ? [...new Set([...warnings, `Raw prompt retained for ${retention.purpose} until ${retention.deleteAfter}; receipt readers redact it after that deadline.`])]
    : [...new Set(warnings)];
}

function takeUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function safeErrorCode(value: string): string {
  const normalized = value.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 64);
  return normalized || "agent_failed";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
