/** Strict and permissive boolean spellings accepted by CLI option parsing. */
export function parseBooleanOption(value: string): boolean {
  return value === "true" || value === "1" || value === "yes";
}

export function parseStrictBooleanOption(value: string): boolean | undefined {
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return undefined;
}
