import { lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Resolve a host proof tool without allowing cwd or a relative PATH component to select it. */
export function resolveTrustedScriptExecutable(toolName, options = {}) {
  const name = String(toolName ?? "").trim();
  if (!name || name.includes("\0") || /[\\/]/u.test(name)) {
    throw new Error("Trusted script executable names must be one bounded file name.");
  }
  const env = options.env ?? process.env;
  const override = String(options.override ?? "").trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error(`${name} override must be an absolute executable path.`);
    const executable = canonicalExecutable(override);
    if (!executable) throw new Error(`${name} override must name an existing regular executable file.`);
    return { executable, source: "override" };
  }

  const fileName = process.platform === "win32" ? `${name}.exe` : name;
  for (const rawEntry of String(env.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"|"$/gu, "");
    if (!entry || !isAbsolute(entry)) continue;
    const executable = canonicalExecutable(join(entry, fileName));
    if (executable) return { executable, source: "path" };
  }
  throw new Error(`No trusted ${fileName} was found on the absolute PATH entries.`);
}

function canonicalExecutable(candidate) {
  try {
    const lexical = lstatSync(candidate);
    if (process.platform === "win32" && lexical.isSymbolicLink()) return null;
    const canonical = realpathSync(candidate);
    const target = statSync(canonical);
    if (!isAbsolute(canonical) || !target.isFile()) return null;
    if (process.platform !== "win32" && (target.mode & 0o111) === 0) return null;
    return canonical;
  } catch {
    return null;
  }
}
