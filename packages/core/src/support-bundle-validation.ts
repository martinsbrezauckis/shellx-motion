type ValidationError = { path: string; message: string };

export function validateSupportBundleDocument(
  record: Record<string, unknown>,
  errors: ValidationError[]
): void {
  validateOnlyFields(record, "/", ["schema", "createdAt", "package", "receipts", "platformVerification", "debug", "runtime", "redactions"], errors);
  validateNonEmptyStringField(record, "createdAt", "/createdAt", errors);
  if ("package" in record) validateSupportBundlePackage(record.package, "/package", errors);
  validateSupportBundleReceipts(record.receipts, "/receipts", errors);
  if ("platformVerification" in record) validateSupportBundlePlatformVerification(record.platformVerification, "/platformVerification", errors);
  validateSupportBundleDebug(record.debug, "/debug", errors);
  validateSupportBundleRuntime(record.runtime, "/runtime", errors);
  validateSupportBundleRedactions(record.redactions, "/redactions", errors);
}

function validateSupportBundlePackage(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["id", "name", "motionId", "sourceApp", "compatibility", "motion", "layerCount", "assetCount", "timeline", "inputHashes"], errors);
  for (const field of ["id", "name", "motionId", "sourceApp"]) {
    validateNonEmptyStringField(record, field, `${path}/${field}`, errors);
  }
  const compatibility = readRecord(record.compatibility);
  if ("compatibility" in record && !compatibility) {
    errors.push({ path: `${path}/compatibility`, message: "must be an object" });
  } else if (compatibility) {
    validateOnlyFields(compatibility, `${path}/compatibility`, ["lanes", "hosts"], errors);
    for (const field of ["lanes", "hosts"]) {
      if (field in compatibility) validateStringArray(compatibility[field], `${path}/compatibility/${field}`, errors);
    }
  }
  if ("motion" in record) validateSupportBundleMotionSummary(record.motion, `${path}/motion`, errors);
  for (const field of ["layerCount", "assetCount"]) {
    if (field in record && !isNonNegativeInteger(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative integer" });
    }
  }
  if ("timeline" in record) validateSupportBundleTimeline(record.timeline, `${path}/timeline`, errors);
  if ("inputHashes" in record) validateStringRecord(record.inputHashes, `${path}/inputHashes`, errors);
}

function validateSupportBundleMotionSummary(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["durationMs", "fps", "width", "height"], errors);
  for (const field of ["durationMs", "fps", "width", "height"]) {
    if (field in record && !isPositiveFiniteNumber(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a positive finite number" });
    }
  }
}

function validateSupportBundleTimeline(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["trackCount", "sceneCount", "markerCount"], errors);
  for (const field of ["trackCount", "sceneCount", "markerCount"]) {
    if (field in record && !isNonNegativeInteger(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative integer" });
    }
  }
}

function validateSupportBundleReceipts(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["receiptCount", "receipts"], errors);
  validateRequiredFields(record, path, ["receiptCount", "receipts"], errors);
  if ("receiptCount" in record && !isNonNegativeInteger(record.receiptCount)) {
    errors.push({ path: `${path}/receiptCount`, message: "must be a non-negative integer" });
  }
  if ("receipts" in record) validateSupportBundleReceiptSummaries(record.receipts, `${path}/receipts`, errors);
}

function validateSupportBundleReceiptSummaries(value: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const receiptPath = `${path}/${index}`;
    const receipt = readRecord(entry);
    if (!receipt) {
      errors.push({ path: receiptPath, message: "must be an object" });
      return;
    }
    validateOnlyFields(receipt, receiptPath, ["id", "operation", "status", "packageId", "lane", "createdAt", "warnings"], errors);
    validateRequiredFields(receipt, receiptPath, ["id", "operation", "status", "packageId", "lane", "createdAt", "warnings"], errors);
    for (const field of ["id", "operation", "status", "packageId", "lane", "createdAt"]) {
      validateNonEmptyStringField(receipt, field, `${receiptPath}/${field}`, errors);
    }
    validateStringArray(receipt.warnings, `${receiptPath}/warnings`, errors);
  });
}

function validateSupportBundlePlatformVerification(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["receiptCount", "receipts"], errors);
  if ("receiptCount" in record && !isNonNegativeInteger(record.receiptCount)) {
    errors.push({ path: `${path}/receiptCount`, message: "must be a non-negative integer" });
  }
  if ("receipts" in record) validateSupportBundlePlatformReceipts(record.receipts, `${path}/receipts`, errors);
}

function validateSupportBundlePlatformReceipts(value: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const receiptPath = `${path}/${index}`;
    const receipt = readRecord(entry);
    if (!receipt) {
      errors.push({ path: receiptPath, message: "must be an object" });
      return;
    }
    validateOnlyFields(receipt, receiptPath, ["schema", "status", "dryRun", "commandCount", "failedCommandCount", "requiredFailedCommandCount", "receiptCount"], errors);
    for (const field of ["schema", "status"]) {
      validateNonEmptyStringField(receipt, field, `${receiptPath}/${field}`, errors);
    }
    if ("dryRun" in receipt && typeof receipt.dryRun !== "boolean") {
      errors.push({ path: `${receiptPath}/dryRun`, message: "must be a boolean" });
    }
    for (const field of ["commandCount", "failedCommandCount", "requiredFailedCommandCount", "receiptCount"]) {
      if (field in receipt && !isNonNegativeInteger(receipt[field])) {
        errors.push({ path: `${receiptPath}/${field}`, message: "must be a non-negative integer" });
      }
    }
  });
}

function validateSupportBundleDebug(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["commandCount", "commands", "actionCount", "actions"], errors);
  validateRequiredFields(record, path, ["commandCount", "commands", "actionCount", "actions"], errors);
  if ("commandCount" in record && !isNonNegativeInteger(record.commandCount)) {
    errors.push({ path: `${path}/commandCount`, message: "must be a non-negative integer" });
  }
  if ("commands" in record) validateStringArray(record.commands, `${path}/commands`, errors);
  if ("actionCount" in record && !isNonNegativeInteger(record.actionCount)) {
    errors.push({ path: `${path}/actionCount`, message: "must be a non-negative integer" });
  }
  if ("actions" in record) validateSupportBundleActions(record.actions, `${path}/actions`, errors);
}

function validateSupportBundleActions(value: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const actionPath = `${path}/${index}`;
    const action = readRecord(entry);
    if (!action) {
      errors.push({ path: actionPath, message: "must be an object" });
      return;
    }
    validateOnlyFields(action, actionPath, ["id", "permission", "mutates", "calls", "surfaces"], errors);
    validateRequiredFields(action, actionPath, ["id", "permission", "mutates", "calls", "surfaces"], errors);
    validateNonEmptyStringField(action, "id", `${actionPath}/id`, errors);
    validateNonEmptyStringField(action, "permission", `${actionPath}/permission`, errors);
    if ("mutates" in action && typeof action.mutates !== "boolean") {
      errors.push({ path: `${actionPath}/mutates`, message: "must be a boolean" });
    }
    if ("calls" in action) validateStringArray(action.calls, `${actionPath}/calls`, errors);
    if ("surfaces" in action) validateStringArray(action.surfaces, `${actionPath}/surfaces`, errors);
  });
}

function validateSupportBundleRuntime(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["node", "platform", "arch"], errors);
  validateRequiredFields(record, path, ["node", "platform", "arch"], errors);
  for (const field of ["node", "platform", "arch"]) {
    validateNonEmptyStringField(record, field, `${path}/${field}`, errors);
  }
}

function validateSupportBundleRedactions(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  validateOnlyFields(record, path, ["envValues", "hostPaths", "diagnosticPaths"], errors);
  validateRequiredFields(record, path, ["envValues", "hostPaths", "diagnosticPaths"], errors);
  if ("envValues" in record && record.envValues !== "omitted") {
    errors.push({ path: `${path}/envValues`, message: "must equal omitted" });
  }
  if ("hostPaths" in record && record.hostPaths !== "omitted") {
    errors.push({ path: `${path}/hostPaths`, message: "must equal omitted" });
  }
  if ("diagnosticPaths" in record && record.diagnosticPaths !== "redacted") {
    errors.push({ path: `${path}/diagnosticPaths`, message: "must equal redacted" });
  }
}

function validateOnlyFields(record: Record<string, unknown>, path: string, allowed: readonly string[], errors: ValidationError[]): void {
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) {
      errors.push({ path: path === "/" ? `/${field}` : `${path}/${field}`, message: "unexpected property" });
    }
  }
}

function validateRequiredFields(record: Record<string, unknown>, path: string, fields: string[], errors: ValidationError[]): void {
  for (const field of fields) {
    if (!(field in record)) errors.push({ path: `${path}/${field}`, message: "required" });
  }
}

function validateNonEmptyStringField(record: Record<string, unknown>, field: string, path: string, errors: ValidationError[]): void {
  if (field in record && (typeof record[field] !== "string" || record[field].length === 0)) {
    errors.push({ path, message: "must be a non-empty string" });
  }
}

function validateStringArray(value: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") errors.push({ path: `${path}/${index}`, message: "must be a string" });
  });
}

function validateStringRecord(value: unknown, path: string, errors: ValidationError[]): void {
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push({ path: `${path}/${key}`, message: "must be a non-empty string" });
    }
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function isPositiveFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
