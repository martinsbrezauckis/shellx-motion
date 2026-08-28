import { isAbsolute, join, relative, resolve } from "node:path";
import { compareCodeUnits } from "./canonical-json";

export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function publishedReviewPath(stagingRoot: string, outputRoot: string, stagedPath: string): string {
  const relation = relative(stagingRoot, stagedPath);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Review bundle artifact staging path escaped its private transaction.");
  }
  return join(outputRoot, relation);
}

export function sameReviewInputHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort(compareCodeUnits);
  const rightKeys = Object.keys(right).sort(compareCodeUnits);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function safeReviewToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function escapeReviewHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}
