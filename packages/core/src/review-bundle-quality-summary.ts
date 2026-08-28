import { escapeReviewHtml as escapeHtml, safeReviewToken } from "./review-bundle-helpers";
import { readStringField, recordOf } from "./review-bundle-receipt-data";
import type { OperationReceipt } from "./types";

export interface ReviewQualityGateSummary {
  path?: string;
  status?: string;
  receiptId?: string;
  hostReceiptPath?: string;
  code?: string;
  message?: string;
  rows?: ReviewQualityGateRowSummary[];
}

interface ReviewQualityGateRowSummary {
  rowId?: string;
  packageId?: string;
  path?: string;
  status?: string;
  receiptId?: string;
  hostReceiptPath?: string;
  code?: string;
  message?: string;
}

export function renderReviewQualityGateCell(receipt: OperationReceipt): string {
  const summary = reviewQualityGateSummary(receipt);
  if (!summary) return '<td class="quality muted">Not configured</td>';
  const status = summary.status ?? "configured";
  const details: string[] = [];
  if (summary.path) details.push(`<div class="muted quality-detail">${escapeHtml(displayPathLabel(summary.path))}</div>`);
  if (summary.receiptId) details.push(`<div class="muted quality-detail">Check: ${escapeHtml(summary.receiptId)}</div>`);
  if (!summary.receiptId && summary.hostReceiptPath) details.push(`<div class="muted quality-detail">Check: ${escapeHtml(displayPathLabel(summary.hostReceiptPath))}</div>`);
  if (summary.rows?.length) details.push(`<div class="muted quality-detail">${escapeHtml(qualityRowCounts(summary.rows))}</div>`);
  if (summary.code) details.push(`<div class="quality-detail quality-code">${escapeHtml(summary.code)}</div>`);
  if (summary.message) details.push(`<div class="muted quality-detail">${escapeHtml(summary.message)}</div>`);
  const rowErrors = (summary.rows ?? [])
    .filter((row) => row.code || row.message)
    .slice(0, 3)
    .map((row) => qualityRowIssue(row));
  for (const issue of rowErrors) details.push(`<div class="muted quality-detail">${escapeHtml(issue)}</div>`);
  return `<td class="quality">${statusPill(status)}${details.join("")}</td>`;
}

export function reviewQualityGateSummary(receipt: OperationReceipt): ReviewQualityGateSummary | undefined {
  const output = recordOf(receipt.output);
  if (!output) return undefined;
  const summary: ReviewQualityGateSummary = {};
  const path = readStringField(output, "qualityManifestPath") ?? readStringField(output, "qualityManifestAppliedPath");
  if (path) summary.path = path;
  assignQualityCheckSummary(summary, recordOf(output.qualityCheck));
  if (Array.isArray(output.jobs)) {
    const rows = output.jobs
      .map((job) => qualityGateRowSummary(recordOf(job)))
      .filter((row): row is ReviewQualityGateRowSummary => row !== undefined);
    if (rows.length > 0) summary.rows = rows;
  }
  if (!summary.status && summary.rows?.length) summary.status = deriveQualityRowsStatus(summary.rows);
  return hasQualityGateSummary(summary) ? summary : undefined;
}

export function isFailedReviewQualityGateSummary(summary: ReviewQualityGateSummary): boolean {
  return summary.status === "failed" || Boolean(summary.rows?.some((row) => row.status === "failed"));
}

function statusPill(status: string): string {
  return `<span class="status status-${escapeHtml(safeReviewToken(status))}">${escapeHtml(status)}</span>`;
}

function qualityGateRowSummary(job: Record<string, unknown> | null): ReviewQualityGateRowSummary | undefined {
  if (!job) return undefined;
  const row: ReviewQualityGateRowSummary = {};
  const rowId = readStringField(job, "rowId");
  const packageId = readStringField(job, "packageId");
  const path = readStringField(job, "qualityManifestAppliedPath") ?? readStringField(job, "qualityManifestPath");
  if (rowId) row.rowId = rowId;
  if (packageId) row.packageId = packageId;
  if (path) row.path = path;
  assignQualityCheckSummary(row, recordOf(job.qualityCheck));
  return hasQualityGateRowSummary(row) ? row : undefined;
}

function assignQualityCheckSummary(target: ReviewQualityGateSummary | ReviewQualityGateRowSummary, qualityCheck: Record<string, unknown> | null): void {
  if (!qualityCheck) return;
  const error = recordOf(qualityCheck.error);
  const status = readStringField(qualityCheck, "status") ?? readBooleanQualityStatus(qualityCheck.ok);
  const receiptId = readStringField(qualityCheck, "receiptId");
  const hostReceiptPath = readStringField(qualityCheck, "hostReceiptPath");
  const code = readStringField(qualityCheck, "code") ?? readStringField(error, "code");
  const message = readStringField(qualityCheck, "message") ?? readStringField(error, "message");
  if (status) target.status = status;
  if (receiptId) target.receiptId = receiptId;
  if (hostReceiptPath) target.hostReceiptPath = hostReceiptPath;
  if (code) target.code = code;
  if (message) target.message = message;
}

function readBooleanQualityStatus(value: unknown): string | undefined {
  if (value === true) return "passed";
  if (value === false) return "failed";
  return undefined;
}

function hasQualityGateSummary(summary: ReviewQualityGateSummary): boolean {
  return Boolean(summary.path || summary.status || summary.receiptId || summary.hostReceiptPath || summary.code || summary.message || summary.rows?.length);
}

function hasQualityGateRowSummary(row: ReviewQualityGateRowSummary): boolean {
  return Boolean(row.path || row.status || row.receiptId || row.hostReceiptPath || row.code || row.message);
}

function deriveQualityRowsStatus(rows: ReviewQualityGateRowSummary[]): string | undefined {
  const statuses = rows.map((row) => row.status).filter((status): status is string => Boolean(status));
  if (statuses.length === 0) return undefined;
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "warning")) return "warning";
  if (statuses.every((status) => status === "passed")) return "passed";
  if (statuses.every((status) => status === "not_run")) return "not_run";
  return "configured";
}

function qualityRowCounts(rows: ReviewQualityGateRowSummary[]): string {
  const statuses = rows.map((row) => row.status).filter((status): status is string => Boolean(status));
  const parts = [`${rows.length} ${rows.length === 1 ? "row" : "rows"}`];
  const ordered = ["passed", "warning", "failed", "not_run"];
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  for (const status of ordered) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
    counts.delete(status);
  }
  for (const status of [...counts.keys()].sort()) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${status}`);
  }
  return parts.join(", ");
}

function qualityRowIssue(row: ReviewQualityGateRowSummary): string {
  const label = row.rowId ?? row.packageId ?? "row";
  return [label, row.code, row.message].filter((part): part is string => Boolean(part)).join(": ");
}

function displayPathLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}
