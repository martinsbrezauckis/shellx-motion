/** Receipt observation is non-authoritative after an atomic delivery commits. */
import { isPublicationCommitUncertain, type OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { AuthoringRootPolicyError } from "./authoring-root-policy.js";
import type { IntegrationDomainServices as IntegrationServices } from "./integration-services.js";

export async function connectorResult(
  command: MotionDebugCommand,
  result: { ok: boolean; receiptPath: string; warnings: string[] },
  services: IntegrationServices,
  visibleState: Record<string, unknown>,
  extraResult: Record<string, unknown> = {},
  observationProfile: { atomic?: boolean } = {}
): Promise<MotionDebugResult> {
  let receipt: OperationReceipt | null | undefined;
  let hostReceiptPath: string | undefined;
  const observerWarnings: string[] = [];
  const committed = observationProfile.atomic === true && result.ok;
  const observerPrefix = committed
    ? "Connector delivery committed, but"
    : result.ok
      ? "Connector delivery completed, but"
      : "Connector delivery returned a failed result, and";
  try {
    receipt = services.readReceipt ? await services.readReceipt(result.receiptPath) : undefined;
    if (services.receiptsRoot && receipt) {
      if (!services.writeReceipt) throw new Error("Receipt persistence capability is unavailable");
      hostReceiptPath = await services.writeReceipt(services.receiptsRoot, receipt);
    } else if (services.receiptsRoot && !receipt) {
      observerWarnings.push(`${observerPrefix} its receipt could not be observed for the configured host mirror.`);
    } else if (!services.readReceipt) {
      observerWarnings.push(`${observerPrefix} host receipt observation is unavailable.`);
    }
  } catch (error) {
    observerWarnings.push(`${observerPrefix} host receipt observation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const publicResult = { ...result, ...extraResult, ...(hostReceiptPath ? { hostReceiptPath } : {}) };
  const publicVisibleState = { ...visibleState, ...(hostReceiptPath ? { hostReceiptPath } : {}) };
  if (!result.ok) {
    return {
      ok: false,
      error: { code: "connector_failed", message: `${command} returned a failed connector receipt.`, detail: { receiptPath: result.receiptPath } },
      ...(receipt ? { receiptId: receipt.id } : {}), visibleState: publicVisibleState, result: publicResult,
      warnings: [...result.warnings, ...observerWarnings]
    };
  }
  return { ok: true, ...(receipt ? { receiptId: receipt.id } : {}), visibleState: publicVisibleState, result: publicResult, warnings: [...result.warnings, ...observerWarnings] };
}

export function connectorException(error: unknown): MotionDebugResult {
  if (error instanceof AuthoringRootPolicyError) return { ok: false, error: { code: "invalid_args", message: error.message }, warnings: [] };
  if (isPublicationCommitUncertain(error)) {
    const detail = { possiblyCommitted: true, publicPaths: [error.evidence.publicPath], expectedPublications: [error.evidence] };
    return { ok: false, error: { code: error.code, message: error.message, detail }, result: detail, warnings: [] };
  }
  return { ok: false, error: { code: "connector_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
