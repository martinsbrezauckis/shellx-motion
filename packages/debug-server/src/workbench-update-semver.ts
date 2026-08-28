/**
 * Strict SemVer parsing and precedence for the workbench update channel.
 *
 * GitHub release tags may carry one leading `v`; after that normalization, this follows SemVer
 * 2.0 precedence exactly. Build metadata is retained for display but ignored for comparison.
 */
export interface EngineSemanticVersion {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[] | null;
  normalized: string;
}

/** Parse strict SemVer 2.0, accepting GitHub's optional leading `v` tag prefix. */
export function parseEngineVersion(input: string): EngineSemanticVersion | null {
  const version = input.trim();
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : null;
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier))) {
    return null;
  }
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
    normalized: version.replace(/^v/, "")
  };
}

/** Return `null` instead of inventing precedence for malformed inputs. */
export function compareEngineVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseEngineVersion(a);
  const right = parseEngineVersion(b);
  if (!left || !right) return null;
  for (const field of ["major", "minor", "patch"] as const) {
    const compared = compareNumericIdentifier(left[field], right[field]);
    if (compared !== 0) return compared;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Compare non-negative integer text without losing precision to JavaScript numbers. */
function compareNumericIdentifier(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function comparePrerelease(left: string[] | null, right: string[] | null): -1 | 0 | 1 {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return compareNumericIdentifier(a, b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}
