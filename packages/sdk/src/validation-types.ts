/** Public request and response shapes for package validation. */
import type { MotionValidationReport } from "@shellx-motion/core";
import type { MotionSdkPackageIdentity } from "./package-types.js";

export interface MotionSdkValidateRequest {
  packageRoot: string;
  /** Optional governed host receipt destination, never a package-owned default. */
  receiptsRoot?: string;
}

export interface MotionSdkValidateResponse {
  package: MotionSdkPackageIdentity;
  /** Two-stage Motion document validation; never a rendered-artifact claim. */
  validation: MotionValidationReport;
  template?: MotionSdkTemplateParameterSchema;
  receiptId?: string;
  receiptPath?: string;
  warnings: string[];
}

export interface MotionSdkTemplateParameterSchema {
  schema: "shellx-motion/template-parameters@1";
  templateId: string;
  jsonSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema";
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
}
