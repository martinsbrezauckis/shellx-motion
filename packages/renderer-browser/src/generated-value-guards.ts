export function generatedNumber(
  value: unknown,
  min: number,
  max: number,
  label: string,
  inclusiveMin = true,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (inclusiveMin ? value < min : value <= min)
    || value > max
  ) {
    throw new Error(`${label} is out of range.`);
  }
  return value;
}

export function generatedHexColor(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error(`${label} must be a #RRGGBB color.`);
  }
  return value;
}
