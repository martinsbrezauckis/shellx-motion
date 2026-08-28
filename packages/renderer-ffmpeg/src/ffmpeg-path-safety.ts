import { isAbsolute, join, relative, resolve } from "node:path";

export function encodePathSafetyError(
  input: { framesDir: string; outputPath: string; inputRoots?: string[]; outputRoots?: string[] },
  audioInputs: Array<{ path: string }>
): string | null {
  const inputRoots = effectiveEncodeInputRoots(input);
  for (const path of [join(input.framesDir, "%06d.png"), ...audioInputs.map((audio) => audio.path)]) {
    const error = ffmpegPathSafetyError(path, "input", inputRoots);
    if (error) return error;
  }
  return ffmpegPathSafetyError(input.outputPath, "output", input.outputRoots);
}

export function effectiveEncodeInputRoots(input: { framesDir: string; inputRoots?: string[] }): string[] {
  const explicitRoots = trustedInputRoots(input.inputRoots ?? []);
  return explicitRoots.length > 0 ? explicitRoots : [input.framesDir];
}

export function assertSafeFfmpegInputPath(path: string, inputRoots?: string[]): void {
  const error = ffmpegPathSafetyError(path, "input", inputRoots);
  if (error) throw new Error(error);
}

export function assertSafeFfmpegOutputPath(path: string, outputRoots?: string[]): void {
  const error = ffmpegPathSafetyError(path, "output", outputRoots);
  if (error) throw new Error(error);
}

export function localFileInputArgs(path: string): string[] {
  return ["-protocol_whitelist", "file", "-i", path];
}

function ffmpegPathSafetyError(path: string, role: "input" | "output", trustedRoots?: string[]): string | null {
  const trimmed = path.trim();
  if (!trimmed) return `Unsafe FFmpeg ${role} path: path operands must not be blank.`;
  if (trimmed.startsWith("-")) return `Unsafe FFmpeg ${role} path: path operands must not start with '-'.`;
  if (hasProtocolScheme(trimmed)) return `Unsafe FFmpeg ${role} path: protocol URLs are not allowed.`;
  if (trustedRoots && trustedInputRoots(trustedRoots).length > 0 && !isPathInsideAnyRoot(trimmed, trustedRoots)) {
    return `Unsafe FFmpeg ${role} path: path must be inside a trusted ${role} root.`;
  }
  return null;
}

function hasProtocolScheme(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

function isPathInsideAnyRoot(path: string, roots: string[]): boolean {
  const resolvedPath = resolve(path);
  return trustedInputRoots(roots).some((root) => isPathInsideOrEqual(root, resolvedPath));
}

function trustedInputRoots(roots: string[]): string[] {
  return roots
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(root));
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
