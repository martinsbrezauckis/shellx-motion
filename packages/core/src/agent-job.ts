import type { OperationReceipt } from "./types";
import type { JobState } from "./generated/job-status";

/**
 * Re-exported from the single authored contract (schemas/job-status.json).
 *
 * The former local union also declared "planned" and "queued", neither of which this module
 * ever produced — it only ever emits "succeeded" or "failed". "planned" additionally collided
 * with the artifact-status vocabulary, which is why the contract reserves it.
 */
export type AgentAuthoringJobStatus = JobState;
export type AgentAuthoringAssetRouteId = "codex-subscription-cli" | "grok-build-cli" | "package-local";
export type AgentAuthoringAssetRole = "authoring" | "image" | "video" | "audio" | "review";
export type AgentAuthoringMutationMode = "proposal_only" | "debug_commands_allowed" | "no_mutation";
export type AgentRevisionPlanStatus = "accepted" | "needs_revision";

export interface AgentAuthoringPlanSummary {
  topic: string;
  actionId?: string;
  debugCommands: string[];
  verify: string[];
  cautions: string[];
}

export interface AgentAuthoringAssetRoute {
  id: string;
  label: string;
  route: AgentAuthoringAssetRouteId;
  role: AgentAuthoringAssetRole;
  status: "planned" | "used" | "not_required" | "unavailable";
  reason: string;
}

export interface AgentAuthoringFileChange {
  command: string;
  mutation: "planned" | "output" | "none";
  description: string;
}

export interface AgentAuthoringApproval {
  id: string;
  label: string;
  status: "required" | "satisfied" | "blocked" | "not_required";
  reason: string;
}

export interface AgentAuthoringOutputPaths {
  receiptsRoot?: string;
  promptReceiptPath?: string;
  agentReceiptPath?: string;
  packageRoot?: string;
  renderedMediaPath?: string;
  reviewBundlePath?: string;
}

export interface AgentAuthoringMutationPolicy {
  mode: AgentAuthoringMutationMode;
  reason: string;
}

export interface AgentAuthoringFailure {
  code: string;
  message: string;
  detail?: string;
}

export interface AgentAuthoringJobEvent {
  seq: number;
  at: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AgentAuthoringJob {
  schema: "shellx-motion/agent-authoring-job@1";
  jobId: string;
  packageId: string;
  brief: string;
  status: AgentAuthoringJobStatus;
  agentId?: string;
  createdAt: string;
  plan: AgentAuthoringPlanSummary;
  assetRoutes: AgentAuthoringAssetRoute[];
  proposedFileChanges: AgentAuthoringFileChange[];
  requiredApprovals: AgentAuthoringApproval[];
  outputPaths: AgentAuthoringOutputPaths;
  mutationPolicy: AgentAuthoringMutationPolicy;
  eventLog: AgentAuthoringJobEvent[];
  failure?: AgentAuthoringFailure;
}

export interface AgentRevisionContactSheetEvidence {
  path: string;
  status: "approved" | "needs_revision" | "missing";
  notes?: string[];
}

export interface AgentRevisionFinding {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  receiptId?: string;
  path?: string;
}

export interface AgentRevisionProposedAction {
  id: string;
  command: "motion.prompt.run" | "motion.template.apply" | "motion.render.final" | "motion.review.html.bundle";
  target: {
    packageId: string;
    templateId?: string;
  };
  reason: string;
}

export interface AgentRevisionPlan {
  schema: "shellx-motion/agent-revision-plan@1";
  planId: string;
  packageId: string;
  templateId?: string;
  sourceJobId?: string;
  createdAt: string;
  status: AgentRevisionPlanStatus;
  evidence: {
    qualityReceiptIds: string[];
    contactSheet?: AgentRevisionContactSheetEvidence;
  };
  findings: AgentRevisionFinding[];
  proposedActions: AgentRevisionProposedAction[];
  mutationPolicy: AgentAuthoringMutationPolicy;
}

export interface CreateAgentAuthoringJobInput {
  jobId: string;
  packageId: string;
  brief: string;
  status: AgentAuthoringJobStatus;
  createdAt: string;
  plan: AgentAuthoringPlanSummary;
  agentId?: string;
  executeAgentCommands?: boolean;
  outputPaths?: AgentAuthoringOutputPaths;
  executedCommands?: Array<{ command: string; ok: boolean; receiptId?: string }>;
  error?: AgentAuthoringFailure;
}

export interface CreateAgentRevisionPlanInput {
  planId: string;
  packageId: string;
  templateId?: string;
  sourceJobId?: string;
  createdAt: string;
  qualityReceipts?: OperationReceipt[];
  contactSheet?: AgentRevisionContactSheetEvidence;
}

export function createAgentAuthoringJob(input: CreateAgentAuthoringJobInput): AgentAuthoringJob {
  const mutationPolicy = agentAuthoringMutationPolicy(input);
  const eventLog = agentAuthoringEventLog(input);
  return {
    schema: "shellx-motion/agent-authoring-job@1",
    jobId: input.jobId,
    packageId: input.packageId,
    brief: input.brief,
    status: input.status,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    createdAt: input.createdAt,
    plan: input.plan,
    assetRoutes: agentAuthoringAssetRoutes(input.brief, input.status),
    proposedFileChanges: agentAuthoringFileChanges(input.plan.debugCommands),
    requiredApprovals: agentAuthoringApprovals(input, mutationPolicy),
    outputPaths: input.outputPaths ?? {},
    mutationPolicy,
    eventLog,
    ...(input.error ? { failure: input.error } : {})
  };
}

export function withAgentAuthoringJobOutputPaths(job: AgentAuthoringJob, outputPaths: AgentAuthoringOutputPaths): AgentAuthoringJob {
  return {
    ...job,
    outputPaths: {
      ...job.outputPaths,
      ...outputPaths
    }
  };
}

export function withAgentAuthoringJobExecution(
  job: AgentAuthoringJob,
  input: {
    executedCommands: Array<{ command: string; ok: boolean; receiptId?: string }>;
    at?: string;
  }
): AgentAuthoringJob {
  const failed = input.executedCommands.filter((command) => !command.ok);
  const eventLog = [
    ...job.eventLog,
    {
      seq: nextAgentAuthoringEventSeq(job),
      at: input.at ?? job.createdAt,
      type: failed.length > 0 ? "commands.failed" : "commands.completed",
      message: failed.length > 0
        ? "One or more agent-proposed debug commands failed."
        : "Agent-proposed debug commands completed.",
      data: { commands: input.executedCommands }
    }
  ];
  return {
    ...job,
    status: failed.length > 0 ? "failed" : "succeeded",
    mutationPolicy: {
      mode: "debug_commands_allowed",
      reason: "User enabled execution of agent-proposed debug commands."
    },
    requiredApprovals: job.requiredApprovals.map((approval) => approval.id === "execute-debug-commands"
      ? {
          ...approval,
          status: "satisfied" as const,
          reason: "Execution was explicitly enabled for this prompt run."
        }
      : approval),
    eventLog,
    ...(failed.length > 0 ? {
      failure: {
        code: "prompt_command_failed",
        message: "One or more agent-proposed debug commands failed."
      }
    } : {})
  };
}

export function createAgentRevisionPlan(input: CreateAgentRevisionPlanInput): AgentRevisionPlan {
  const qualityReceipts = input.qualityReceipts ?? [];
  const findings = [
    ...qualityRevisionFindings(qualityReceipts),
    ...contactSheetRevisionFindings(input.contactSheet)
  ];
  const proposedActions = findings.length > 0
    ? revisionProposedActions(input, findings)
    : [];
  return {
    schema: "shellx-motion/agent-revision-plan@1",
    planId: input.planId,
    packageId: input.packageId,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.sourceJobId ? { sourceJobId: input.sourceJobId } : {}),
    createdAt: input.createdAt,
    status: findings.length > 0 ? "needs_revision" : "accepted",
    evidence: {
      qualityReceiptIds: qualityReceipts.map((receipt) => receipt.id),
      ...(input.contactSheet ? { contactSheet: input.contactSheet } : {})
    },
    findings,
    proposedActions,
    mutationPolicy: {
      mode: "proposal_only",
      reason: "Revision plan must be reviewed before mutating packages or host projects."
    }
  };
}

function agentAuthoringMutationPolicy(input: CreateAgentAuthoringJobInput): AgentAuthoringMutationPolicy {
  if (input.status === "failed" || input.error) {
    return {
      mode: "no_mutation",
      reason: "Agent job failed before any mutation-capable command execution."
    };
  }
  if (input.executeAgentCommands) {
    return {
      mode: "debug_commands_allowed",
      reason: "User enabled execution of agent-proposed debug commands."
    };
  }
  return {
    mode: "proposal_only",
    reason: "Agent may propose package changes; host must approve before mutation."
  };
}

function agentAuthoringAssetRoutes(brief: string, status: AgentAuthoringJobStatus): AgentAuthoringAssetRoute[] {
  const lowerBrief = brief.toLowerCase();
  const routes: AgentAuthoringAssetRoute[] = [
    {
      id: "codex-authoring",
      label: "Codex subscription CLI",
      route: "codex-subscription-cli",
      role: "authoring",
      status: status === "failed" ? "planned" : "used",
      reason: "Default ShellX Motion route for brief planning, package authoring, and critique."
    }
  ];
  const wantsGeneratedVisuals = /\b(grok|imagine|image|photo|illustration|visual|video|asset|hero)\b/.test(lowerBrief);
  routes.push(wantsGeneratedVisuals
    ? {
        id: "grok-generated-assets",
        label: "Grok Build / Imagine generated assets",
        route: "grok-build-cli",
        role: /\b(image|photo|illustration|visual|hero)\b/.test(lowerBrief) ? "image" : lowerBrief.includes("video") ? "video" : "image",
        status: "planned",
        reason: "Generated media must be imported as package-local assets with provenance before render."
      }
    : {
        id: "package-local-assets",
        label: "Package-local assets",
        route: "package-local",
        role: "review",
        status: "not_required",
        reason: "The brief does not require new generated media assets."
      });
  return routes;
}

function agentAuthoringFileChanges(debugCommands: string[]): AgentAuthoringFileChange[] {
  return debugCommands.map((command) => {
    if (command === "motion.render.final" || command === "motion.preview.frame" || command === "motion.preview.strip" || command === "motion.quality.check") {
      return {
        command,
        mutation: "output",
        description: `${command} writes render, preview, quality, or receipt outputs.`
      };
    }
    if (command.includes(".apply") || command.includes(".patch") || command.includes(".set") || command.includes(".create") || command.includes(".delete") || command.includes(".replace")) {
      return {
        command,
        mutation: "planned",
        description: `${command} can mutate a Motion package or host project when approved.`
      };
    }
    return {
      command,
      mutation: "none",
      description: `${command} is read-only or planning-only.`
    };
  });
}

function agentAuthoringApprovals(input: CreateAgentAuthoringJobInput, mutationPolicy: AgentAuthoringMutationPolicy): AgentAuthoringApproval[] {
  const approvals: AgentAuthoringApproval[] = [
    {
      id: "review-agent-plan",
      label: "Review agent plan",
      status: input.status === "failed" ? "blocked" : "satisfied",
      reason: input.status === "failed"
        ? "Agent did not produce an executable plan."
        : "Prompt receipt records the selected debug command plan."
    },
    {
      id: "agent-availability",
      label: "Local CLI agent availability",
      status: input.status === "failed" && input.error?.code === "agent_unavailable" ? "blocked" : "satisfied",
      reason: input.status === "failed" && input.error?.code === "agent_unavailable"
        ? "Selected subscription CLI agent is unavailable; no fallback agent was executed."
        : "Selected local CLI agent completed or is queued for host-owned execution."
    }
  ];
  const hasMutation = input.plan.debugCommands.some((command) => agentAuthoringFileChanges([command])[0]?.mutation === "planned");
  approvals.push({
    id: "execute-debug-commands",
    label: "Execute agent-proposed debug commands",
    status: mutationPolicy.mode === "debug_commands_allowed"
      ? "satisfied"
      : hasMutation
        ? "required"
        : "not_required",
    reason: mutationPolicy.mode === "debug_commands_allowed"
      ? "Execution was explicitly enabled for this prompt run."
      : hasMutation
        ? "Mutation-capable commands require host approval before execution."
        : "The selected plan does not contain mutation-capable commands."
  });
  return approvals;
}

function agentAuthoringEventLog(input: CreateAgentAuthoringJobInput): AgentAuthoringJobEvent[] {
  const events: AgentAuthoringJobEvent[] = [
    {
      seq: 1,
      at: input.createdAt,
      type: "brief.received",
      message: "User brief captured for local CLI agent authoring.",
      data: { packageId: input.packageId }
    },
    {
      seq: 2,
      at: input.createdAt,
      type: "plan.created",
      message: "Debug command plan selected for the brief.",
      data: { topic: input.plan.topic, actionId: input.plan.actionId, debugCommands: input.plan.debugCommands }
    }
  ];
  if (input.status === "failed") {
    events.push({
      seq: 3,
      at: input.createdAt,
      type: "agent.failed",
      message: input.error?.message ?? "Agent authoring failed.",
      data: input.error ? { code: input.error.code, detail: input.error.detail } : undefined
    });
    return events;
  }
  if (input.status === "succeeded") {
    events.push({
      seq: 3,
      at: input.createdAt,
      type: "agent.completed",
      message: "Local CLI agent completed the authoring pass.",
      ...(input.agentId ? { data: { agentId: input.agentId } } : {})
    });
  } else {
    events.push({
      seq: 3,
      at: input.createdAt,
      type: "agent.queued",
      message: "Agent authoring job is queued or running under host control.",
      data: { status: input.status }
    });
  }
  if (input.executedCommands && input.executedCommands.length > 0) {
    const failed = input.executedCommands.filter((command) => !command.ok);
    events.push({
      seq: 4,
      at: input.createdAt,
      type: failed.length > 0 ? "commands.failed" : "commands.completed",
      message: failed.length > 0
        ? "One or more agent-proposed debug commands failed."
        : "Agent-proposed debug commands completed.",
      data: { commands: input.executedCommands }
    });
  }
  return events;
}

function nextAgentAuthoringEventSeq(job: AgentAuthoringJob): number {
  return job.eventLog.reduce((maxSeq, event) => Math.max(maxSeq, event.seq), 0) + 1;
}

function qualityRevisionFindings(receipts: OperationReceipt[]): AgentRevisionFinding[] {
  return receipts.flatMap((receipt) => {
    const findings: AgentRevisionFinding[] = [];
    if (receipt.status === "failed" || receipt.status === "warning") {
      findings.push({
        severity: receipt.status === "failed" ? "error" : "warning",
        code: "quality_failed",
        message: firstQualityMessage(receipt) ?? `Quality receipt ${receipt.id} reported ${receipt.status}.`,
        receiptId: receipt.id
      });
    }

    const quality = objectRecord(objectRecord(receipt.output)?.quality);
    const blankFrames = numberValue(quality?.blankFrames);
    if (blankFrames && blankFrames > 0) {
      findings.push({
        severity: "error",
        code: "blank_frames",
        message: `Quality receipt ${receipt.id} reports ${blankFrames} blank frame${blankFrames === 1 ? "" : "s"}.`,
        receiptId: receipt.id
      });
    }

    const checks = Array.isArray(objectRecord(receipt.output)?.checks)
      ? objectRecord(receipt.output)?.checks as unknown[]
      : [];
    for (const check of checks) {
      const checkRecord = objectRecord(check);
      const status = stringValue(checkRecord?.status);
      if (status === "failed" || status === "warning") {
        findings.push({
          severity: status === "failed" ? "error" : "warning",
          code: "quality_check_failed",
          message: stringValue(checkRecord?.message) ?? `Quality check ${stringValue(checkRecord?.id) ?? "unknown"} reported ${status}.`,
          receiptId: receipt.id
        });
      }
    }

    return findings;
  });
}

function firstQualityMessage(receipt: OperationReceipt): string | undefined {
  if (receipt.warnings.length > 0) {
    return receipt.warnings[0];
  }
  const checks = Array.isArray(objectRecord(receipt.output)?.checks)
    ? objectRecord(receipt.output)?.checks as unknown[]
    : [];
  for (const check of checks) {
    const checkRecord = objectRecord(check);
    const status = stringValue(checkRecord?.status);
    const message = stringValue(checkRecord?.message);
    if ((status === "failed" || status === "warning") && message) {
      return message;
    }
  }
  return undefined;
}

function contactSheetRevisionFindings(contactSheet?: AgentRevisionContactSheetEvidence): AgentRevisionFinding[] {
  if (!contactSheet) {
    return [{
      severity: "warning",
      code: "contact_sheet_missing",
      message: "No contact-sheet evidence was provided for critique.",
    }];
  }
  if (contactSheet.status !== "needs_revision") {
    return [];
  }
  const notes = contactSheet.notes && contactSheet.notes.length > 0
    ? contactSheet.notes
    : ["Contact sheet was marked as needing revision."];
  return notes.map((note) => ({
    severity: "warning" as const,
    code: "contact_sheet_needs_revision",
    message: note,
    path: contactSheet.path
  }));
}

function revisionProposedActions(input: CreateAgentRevisionPlanInput, findings: AgentRevisionFinding[]): AgentRevisionProposedAction[] {
  const hasQualityFinding = findings.some((finding) => finding.code.startsWith("quality") || finding.code === "blank_frames");
  const reason = hasQualityFinding
    ? "Revise package based on quality and contact-sheet findings before any mutation."
    : "Revise package based on contact-sheet findings before any mutation.";
  return [{
    id: "revise-with-agent",
    command: "motion.prompt.run",
    target: {
      packageId: input.packageId,
      ...(input.templateId ? { templateId: input.templateId } : {})
    },
    reason
  }];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
