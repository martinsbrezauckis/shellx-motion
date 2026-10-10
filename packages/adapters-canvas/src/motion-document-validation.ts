import { loadSchemaSync, validateDocumentSync, type MotionDocument } from "@shellx-motion/core";

/** Keep generated and legacy Canvas exports inside Core's public Motion contract. */
export function assertValidCanvasMotionDocument(
  motion: MotionDocument,
  context: "conversion" | "package"
): void {
  const validation = validateDocumentSync(loadSchemaSync("motion"), motion);
  if (validation.ok) return;
  const first = validation.errors[0];
  const prefix = context === "conversion"
    ? "Canvas conversion produced an invalid Motion document"
    : "Canvas package Motion document is invalid";
  throw new Error(`${prefix} at ${first.path}: ${first.message}.`);
}
