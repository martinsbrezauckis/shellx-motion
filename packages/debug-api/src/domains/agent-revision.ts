/** Agent revision-plan policy, evidence trust boundaries, and receipt construction. */
import {
  createAgentRevisionPlan,
  hashBuffer,
  type AgentRevisionContactSheetEvidence,
  type OperationReceipt
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { objectArg, stringArg } from "./args.js";

interface RevisionEvidenceRequest {
  receiptsRoot?: string;
  qualityReceipt?: unknown;
  qualityReceipts?: unknown[];
  qualityReceiptPaths: string[];
  qualityReceiptIds: string[];
  contactSheet?: unknown;
  contactSheetPath?: string;
  /**
   * The trusted input roots `contactSheetPath` was admitted against, forwarded so the reader can
   * re-check them rather than trusting that this gate ran. Wider than `receiptsRoot` on purpose: a
   * contact sheet is a render artifact and normally lives in the scratch root.
   */
  contactSheetRoots?: string[];
}

interface RevisionEvidence {
  qualityReceipts: OperationReceipt[];
  contactSheet?: AgentRevisionContactSheetEvidence;
}

export interface AgentRevisionServices {
  scratchRoot?: string;
  receiptsRoot?: string;
  qualityInputRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, path: string) => Promise<boolean>;
  isAgentReceiptPathInsideRoot?: (root: string, path: string) => Promise<boolean>;
  readAgentRevisionEvidence?: (input: RevisionEvidenceRequest) => Promise<
    { ok: true; evidence: RevisionEvidence } | { ok: false; message: string }
  >;
  writeJson?: (path: string, value: unknown) => Promise<void>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchAgentRevisionCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AgentRevisionServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.agent.revision.plan") return null;
  const packageId = stringArg(args, "packageId");
  if (!packageId) return invalidArgs("motion.agent.revision.plan requires packageId.");
  const templateId = stringArg(args, "templateId") ?? undefined;
  const sourceJobId = stringArg(args, "sourceJobId") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const qualityReceipt = ownValue(args, "qualityReceipt");
  const qualityReceipts = ownArray(args, "qualityReceipts");
  if (qualityReceipts === false) return invalidArgs("qualityReceipts must be an array.");
  const qualityReceiptPaths = stringValues(args, "qualityReceiptPath", "qualityReceiptPaths");
  if (!qualityReceiptPaths.ok) return invalidArgs(qualityReceiptPaths.message);
  const qualityReceiptIds = stringValues(args, "qualityReceiptId", "qualityReceiptIds");
  if (!qualityReceiptIds.ok) return invalidArgs(qualityReceiptIds.message);
  const contactSheet = ownValue(args, "contactSheet");
  const contactSheetPath = stringArg(args, "contactSheetPath") ?? stringArg(args, "contactSheetFile") ?? undefined;
  const planPath = stringArg(args, "planPath") ?? stringArg(args, "outputPath") ?? undefined;
  const createdAt = stringArg(args, "createdAt") ?? new Date().toISOString();
  const planIdArg = stringArg(args, "planId") ?? undefined;

  if (!services.readAgentRevisionEvidence) return capabilityUnavailable("Agent revision evidence loading is unavailable.");
  if (qualityReceiptPaths.values.length > 0) {
    if (!receiptsRoot) return invalidArgs("qualityReceiptPath requires receiptsRoot.");
    if (!services.isAgentReceiptPathInsideRoot) return capabilityUnavailable("Agent revision receipt-path validation is unavailable.");
    for (const path of qualityReceiptPaths.values) {
      if (!await services.isAgentReceiptPathInsideRoot(receiptsRoot, path)) {
        return invalidArgs("qualityReceiptPath must be inside receiptsRoot.");
      }
    }
  }
  if (qualityReceiptIds.values.length > 0 && !receiptsRoot) return invalidArgs("qualityReceiptId requires receiptsRoot.");

  const inputRoots = [services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? []), ...(receiptsRoot ? [receiptsRoot] : [])];
  if (contactSheetPath) {
    if (!services.isPathInsideTrustedRoot) return capabilityUnavailable("Agent revision input-path validation is unavailable.");
    if (!await insideAnyRoot(contactSheetPath, inputRoots, services.isPathInsideTrustedRoot)) {
      return invalidArgs("contactSheetPath must be inside a trusted debug input root.");
    }
  }
  if (planPath) {
    if (!services.isPathInsideTrustedRoot) return capabilityUnavailable("Agent revision output-path validation is unavailable.");
    const outputRoots = [services.scratchRoot ?? ".scratch", ...(receiptsRoot ? [receiptsRoot] : [])];
    if (!await insideAnyRoot(planPath, outputRoots, services.isPathInsideTrustedRoot)) {
      return invalidArgs("motion.agent.revision.plan planPath must be inside a trusted debug output root.");
    }
    if (!services.writeJson) return capabilityUnavailable("Agent revision plan persistence is unavailable.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Agent revision receipt persistence is unavailable.");

  const evidenceResult = await services.readAgentRevisionEvidence({
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(qualityReceipt !== undefined ? { qualityReceipt } : {}),
    ...(qualityReceipts ? { qualityReceipts } : {}),
    qualityReceiptPaths: qualityReceiptPaths.values,
    qualityReceiptIds: qualityReceiptIds.values,
    ...(contactSheet !== undefined ? { contactSheet } : {}),
    ...(contactSheetPath ? { contactSheetPath, contactSheetRoots: inputRoots } : {})
  });
  if (!evidenceResult.ok) return invalidArgs(evidenceResult.message);
  const { qualityReceipts: loadedQualityReceipts, contactSheet: loadedContactSheet } = evidenceResult.evidence;
  const planId = planIdArg ?? `revision-${safeFileToken(packageId)}-${hashBuffer(Buffer.from(JSON.stringify({
    packageId, templateId, sourceJobId,
    qualityReceiptIds: loadedQualityReceipts.map((receipt) => receipt.id),
    contactSheet: loadedContactSheet
  }), "utf8")).slice(0, 12)}`;
  const plan = createAgentRevisionPlan({
    planId, packageId,
    ...(templateId ? { templateId } : {}),
    ...(sourceJobId ? { sourceJobId } : {}),
    createdAt,
    qualityReceipts: loadedQualityReceipts,
    ...(loadedContactSheet ? { contactSheet: loadedContactSheet } : {})
  });
  if (planPath) await services.writeJson!(planPath, plan);
  const receipt = receiptsRoot ? revisionPlanReceipt(plan, loadedQualityReceipts, planPath) : undefined;
  const receiptPath = receiptsRoot && receipt ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
  return {
    ok: true,
    ...(receipt ? { receiptId: receipt.id } : {}),
    visibleState: {
      panel: "agent", operation: "agent.revision.plan", packageId, status: plan.status,
      findingCount: plan.findings.length, proposedActionCount: plan.proposedActions.length,
      ...(planPath ? { planPath } : {}), ...(receiptPath ? { receiptPath } : {})
    },
    result: {
      ok: true, plan, ...(planPath ? { planPath } : {}),
      ...(receipt ? { receipt } : {}), ...(receiptPath ? { receiptPath } : {})
    },
    warnings: plan.findings.map((finding) => finding.message)
  };
}

function ownValue(args: unknown, key: string): unknown {
  const record = objectArg(args);
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function ownArray(args: unknown, key: string): unknown[] | false | undefined {
  const value = ownValue(args, key);
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : false;
}

function stringValues(args: unknown, singleKey: string, arrayKey: string): { ok: true; values: string[] } | { ok: false; message: string } {
  const values: string[] = [];
  const single = ownValue(args, singleKey);
  if (single !== undefined) {
    if (typeof single !== "string") return { ok: false, message: `${singleKey} must be a string.` };
    if (single.length > 0) values.push(single);
  }
  const array = ownValue(args, arrayKey);
  if (array !== undefined) {
    if (!Array.isArray(array) || !array.every((entry) => typeof entry === "string")) {
      return { ok: false, message: `${arrayKey} must be an array of strings.` };
    }
    values.push(...array.filter((entry) => entry.length > 0));
  }
  return { ok: true, values };
}

async function insideAnyRoot(path: string, roots: string[], contains: (root: string, path: string) => Promise<boolean>): Promise<boolean> {
  for (const root of roots) if (await contains(root, path)) return true;
  return false;
}

function revisionPlanReceipt(plan: ReturnType<typeof createAgentRevisionPlan>, qualityReceipts: OperationReceipt[], planPath?: string): OperationReceipt {
  const inputHashes = {
    quality: hashBuffer(Buffer.from(JSON.stringify(qualityReceipts.map((receipt) => ({ id: receipt.id, status: receipt.status, warnings: receipt.warnings, output: receipt.output }))), "utf8")),
    contactSheet: hashBuffer(Buffer.from(JSON.stringify(plan.evidence.contactSheet ?? null), "utf8")),
    plan: hashBuffer(Buffer.from(JSON.stringify({ planId: plan.planId, packageId: plan.packageId, templateId: plan.templateId, sourceJobId: plan.sourceJobId }), "utf8"))
  };
  return {
    schema: "shellx-motion/receipt@1", id: plan.planId, operation: "agent.revision.plan",
    status: plan.status === "accepted" ? "passed" : "warning", packageId: plan.packageId,
    inputHashes, createdAt: plan.createdAt, lane: "agent",
    output: { plan, ...(planPath ? { planPath } : {}) },
    ...(planPath ? { artifacts: [{ role: "agent_revision_plan", path: planPath, status: "available", mediaType: "application/json", primary: true }] } : {}),
    warnings: plan.findings.map((finding) => finding.message)
  };
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "revision";
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
