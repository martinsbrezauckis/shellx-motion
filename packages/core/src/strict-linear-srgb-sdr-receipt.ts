/**
 * Core-owned receipt boundary for the strict linear-sRGB SDR final route.
 *
 * Renderer code produces the evidence, but Core owns receipt validation and paired-reader
 * acceptance. Keeping the wire constants here prevents a Core-to-renderer dependency.
 */
export const LINEAR_SRGB_SDR_FINAL_LEGACY_TRANSPORT_SCHEMA = "shellx-motion/linear-srgb-sdr-final-transport@1" as const;
export const LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA = "shellx-motion/linear-srgb-sdr-final-transport@2" as const;
export const LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA = "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1" as const;
const LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA_PREFIX = "shellx-motion/linear-srgb-sdr-final-transport@";
const STRICT_LINEAR_SRGB_SDR_ROUTE_INPUT_HASH_KEYS = [
  "motion",
  "linear-srgb-sdr-route",
  "linear-srgb-sdr-preparation",
  "linear-srgb-sdr-ffmpeg-contract",
  "linear-srgb-sdr-webgpu-producer",
  "linear-srgb-sdr-producer-frame",
  "linear-srgb-sdr-comparison-policy",
  "linear-srgb-sdr-execution",
] as const;

export interface StrictLinearSrgbSdrFinalFileIdentity {
  readonly sha256: string;
  readonly byteLength: number;
}

/** Closed, path-free adoption of independently rehashed bytes into Core's private file stage. */
export interface StrictLinearSrgbSdrFinalPrivateOutputAdoption {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA;
  readonly verifiedOutput: StrictLinearSrgbSdrFinalFileIdentity;
  readonly privatePublicationStage: StrictLinearSrgbSdrFinalFileIdentity;
}

export type StrictLinearSrgbSdrFinalReceiptInspection =
  | Readonly<{ readonly kind: "not-strict" }>
  | Readonly<{ readonly kind: "historical-v1" }>
  | Readonly<{ readonly kind: "strict-v2"; readonly adoption: StrictLinearSrgbSdrFinalPrivateOutputAdoption }>
  | Readonly<{ readonly kind: "invalid-strict-v2"; readonly errors: readonly StrictLinearSrgbSdrFinalReceiptValidationError[] }>;

export interface StrictLinearSrgbSdrFinalReceiptValidationError {
  readonly path: string;
  readonly message: string;
}

/**
 * Classify a strict-SDR receipt and validate fresh @2 adoption evidence.
 *
 * The complete strict route identity is itself a claim requiring the exact fresh transport;
 * a caller must not be able to remove or substitute frameTransport to downgrade that claim.
 * Historical @1 receipts deliberately remain readable but are never a fresh strict qualification.
 */
export function inspectStrictLinearSrgbSdrFinalReceipt(
  receiptValue: unknown,
  receiptPath = "",
): StrictLinearSrgbSdrFinalReceiptInspection {
  const receipt = record(receiptValue);
  // Preserve the earlier public output-only inspection form. Receipt-aware callers below
  // receive the route identity needed to refuse an attempted strict-route downgrade.
  if (!receipt || (!Object.hasOwn(receipt, "output") && !Object.hasOwn(receipt, "inputHashes"))) {
    return inspectOutput(receipt, receiptPath || "/output", false);
  }
  return inspectOutput(
    record(receipt.output),
    `${receiptPath}/output`,
    hasCompleteStrictRouteIdentity(record(receipt.inputHashes)),
  );
}

function inspectOutput(
  output: Record<string, unknown> | undefined,
  outputPath: string,
  hasStrictRouteIdentity: boolean,
): StrictLinearSrgbSdrFinalReceiptInspection {
  const transport = record(output?.frameTransport);
  if (transport?.schema === LINEAR_SRGB_SDR_FINAL_LEGACY_TRANSPORT_SCHEMA) {
    return Object.freeze({ kind: "historical-v1" });
  }
  if (transport?.schema !== LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA) {
    if (hasStrictRouteIdentity) {
      return Object.freeze({
        kind: "invalid-strict-v2",
        errors: Object.freeze([{
          path: `${outputPath}/frameTransport/schema`,
          message: `complete strict route input hashes require ${LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA}; only @1 is historical-readable`,
        }]),
      });
    }
    if (typeof transport?.schema === "string" && transport.schema.startsWith(LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA_PREFIX)) {
      return Object.freeze({
        kind: "invalid-strict-v2",
        errors: Object.freeze([{ path: `${outputPath}/frameTransport/schema`, message: `must equal ${LINEAR_SRGB_SDR_FINAL_TRANSPORT_SCHEMA}; only @1 is historical-readable` }]),
      });
    }
    return Object.freeze({ kind: "not-strict" });
  }

  const errors: StrictLinearSrgbSdrFinalReceiptValidationError[] = [];
  const outputIdentity = fileIdentity(output, outputPath, errors, false);
  const adoptionPath = `${outputPath}/frameTransport/privateOutputAdoption`;
  const adoption = record(transport.privateOutputAdoption);
  if (!adoption) {
    errors.push({ path: adoptionPath, message: "must be a closed private-output adoption object" });
  } else {
    if (!exactKeys(adoption, ["schema", "verifiedOutput", "privatePublicationStage"])) {
      errors.push({ path: adoptionPath, message: "must contain exactly schema, verifiedOutput, and privatePublicationStage" });
    }
    if (adoption.schema !== LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA) {
      errors.push({ path: `${adoptionPath}/schema`, message: `must equal ${LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA}` });
    }
  }
  const verifiedOutput = fileIdentity(adoption?.verifiedOutput, `${adoptionPath}/verifiedOutput`, errors);
  const privatePublicationStage = fileIdentity(adoption?.privatePublicationStage, `${adoptionPath}/privatePublicationStage`, errors);
  if (outputIdentity && verifiedOutput && privatePublicationStage) {
    if (!sameIdentity(outputIdentity, verifiedOutput)) {
      errors.push({ path: outputPath, message: "SHA-256 and byteLength must equal the verified private-output adoption identity" });
    }
    if (!sameIdentity(verifiedOutput, privatePublicationStage)) {
      errors.push({ path: adoptionPath, message: "verifiedOutput and privatePublicationStage must be the same exact identity" });
    }
  }
  if (errors.length > 0) return Object.freeze({ kind: "invalid-strict-v2", errors: Object.freeze(errors) });
  return Object.freeze({
    kind: "strict-v2",
    adoption: Object.freeze({
      schema: LINEAR_SRGB_SDR_FINAL_PRIVATE_OUTPUT_ADOPTION_SCHEMA,
      verifiedOutput: Object.freeze(verifiedOutput!),
      privatePublicationStage: Object.freeze(privatePublicationStage!),
    }),
  });
}

/** Throwing form for paired-delivery gates that cannot accept malformed fresh strict evidence. */
export function assertStrictLinearSrgbSdrFinalReceipt(
  receiptValue: unknown,
  receiptPath = "",
): Exclude<StrictLinearSrgbSdrFinalReceiptInspection, { readonly kind: "invalid-strict-v2" }> {
  const inspection = inspectStrictLinearSrgbSdrFinalReceipt(receiptValue, receiptPath);
  if (inspection.kind === "invalid-strict-v2") {
    throw new Error(`Strict linear-sRGB SDR @2 receipt adoption is invalid: ${inspection.errors.map((error) => `${error.path} ${error.message}`).join("; ")}`);
  }
  return inspection;
}

function fileIdentity(
  value: unknown,
  path: string,
  errors: StrictLinearSrgbSdrFinalReceiptValidationError[],
  exact = true,
): StrictLinearSrgbSdrFinalFileIdentity | undefined {
  const identity = record(value);
  if (!identity) {
    errors.push({ path, message: "must be an object with sha256 and byteLength" });
    return undefined;
  }
  if (exact && !exactKeys(identity, ["sha256", "byteLength"])) {
    errors.push({ path, message: "must contain exactly sha256 and byteLength" });
  }
  const sha256 = typeof identity.sha256 === "string" && /^[a-f0-9]{64}$/u.test(identity.sha256)
    ? identity.sha256
    : undefined;
  const byteLength = typeof identity.byteLength === "number" && Number.isSafeInteger(identity.byteLength) && identity.byteLength > 0
    ? identity.byteLength
    : undefined;
  if (!sha256) errors.push({ path: `${path}/sha256`, message: "must be a 64-character lowercase hexadecimal SHA-256" });
  if (byteLength === undefined) errors.push({ path: `${path}/byteLength`, message: "must be a positive safe integer" });
  return sha256 && byteLength !== undefined ? { sha256, byteLength } : undefined;
}

function sameIdentity(left: StrictLinearSrgbSdrFinalFileIdentity, right: StrictLinearSrgbSdrFinalFileIdentity): boolean {
  return left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasCompleteStrictRouteIdentity(inputHashes: Record<string, unknown> | undefined): boolean {
  return !!inputHashes && STRICT_LINEAR_SRGB_SDR_ROUTE_INPUT_HASH_KEYS.every((key) => {
    const value = inputHashes[key];
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
