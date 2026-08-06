/**
 * Destructive-output guard for the ShellX Motion CLI.
 *
 * Role: every CLI command that materializes a *directory-shaped* deliverable (`render --preset
 * png-sequence`, `template apply`, `template media-replace`) used to open with
 * `rm(outDir, { recursive: true, force: true })`. `--out` is chosen by the caller — a human, or more
 * often an agent driving the CLI — so pointing it at an existing directory silently destroyed
 * whatever lived there and the command still reported `ok: true` with a `"status": "passed"` receipt
 * (release the output-ownership invariant). This module is the single guard those sites now share.
 *
 * Policy (identical at every call site):
 *   - target missing            -> create it (unchanged behavior);
 *   - target is an empty dir    -> reuse it (unchanged behavior);
 *   - target is a non-empty dir -> refuse with `output_dir_not_empty`, delete nothing;
 *   - target exists, not a dir  -> refuse with `output_path_not_a_directory`, delete nothing;
 *   - `force: true` (`--force`) -> recursive wipe + recreate, i.e. the pre-guard behavior verbatim.
 *
 * Why an emptiness check rather than "delete only Motion-created artifacts by manifest": two of the
 * three call sites copy an entire package tree into `--out`, and no manifest of previously written
 * files is persisted there, so a selective delete could not be reconstructed on a first run and would
 * still remove user files whose names happened to collide. Emptiness is the only rule that is
 * provably non-destructive, is uniform across all three sites, and still preserves the "output
 * directory contains exactly this run's artifacts" invariant that PNG-sequence encode correctness
 * depends on (a stale frame from a longer previous render would otherwise be encoded).
 *
 * Invariant: on the refusal path nothing is created and nothing is removed. Callers must return the
 * typed error unchanged inside the usual `{ ok: false, command, error }` envelope.
 *
 * Dependencies: `lstat` / `mkdir` / `open` / `readdir` / `rm` (node:fs/promises).
 *
 * Primary callers: `packages/cli/src/main.ts` — `renderCommand` (image-sequence lane, encode lane
 * output file, encoder scratch frames) and `templateCommand` (`apply` and `media-replace` lanes) —
 * and every connector, which were the SECOND and THIRD occurrences of this defect: `template-to-cut`
 * recursively removed `<out>/package` before copying, and the remaining five connectors called no
 * guard at all while writing into a caller-supplied `--out`. Living in core is what stops a fourth
 * occurrence being written in a package that could not import the guard.
 *
 * The class this module exists to close: *a delete or an overwrite whose blast radius is chosen by
 * a caller-supplied path*. The rule is therefore mechanical rather than case-by-case — Motion may
 * destroy a path only when one of these holds:
 *   1. the caller asked for it (`--force`), or
 *   2. there is nothing there to lose (absent / empty), or
 *   3. the content is evidence Motion produced it (`prepareFramesDir`, below), or
 *   4. the path is Motion's own DEFAULT scratch root, which no caller named
 *      (`prepareFramesDir` with `callerSupplied: false` — the single explicit exception, stated at
 *      the call site instead of assumed by a comment).
 */
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export type OutputDirGuardErrorCode =
  | "output_dir_not_empty"
  | "output_path_not_a_directory"
  | "output_dir_unreadable"
  /** A single-file deliverable (`render --preset mp4-h264 --out clip.mp4`) already exists. */
  | "output_path_exists"
  /**
   * The frames directory resolved OUTSIDE the root it was supposed to live under, so nothing was
   * removed or created. Reached when a path component came from untrusted input -- a package
   * identifier containing `..` or a separator.
   */
  | "frames_dir_escapes_root";

export type OutputDirGuardError = {
  code: OutputDirGuardErrorCode;
  message: string;
  /** The resolved path that was refused, echoed so agents can act on it without re-parsing the message. */
  path: string;
};

export type OutputDirGuardResult = { ok: true } | { ok: false; error: OutputDirGuardError };

export type PrepareOutputDirOptions = {
  /** `true` when the command was invoked with `--force`; restores the pre-guard destructive behavior. */
  force: boolean;
};

/**
 * Make `path` usable as a command's output directory, refusing to destroy existing content.
 *
 * @param path Resolved (absolute) output directory path.
 * @param options.force Caller passed `--force`: wipe the directory recursively before recreating it.
 * @returns `{ ok: true }` once the directory exists and is safe to write into, otherwise a typed
 *          refusal. Side effects: creates the directory on the accepted path, and additionally
 *          removes it first when `force` is set. Never removes anything on the refusal path.
 */
export async function prepareOutputDir(path: string, options: PrepareOutputDirOptions): Promise<OutputDirGuardResult> {
  if (!options.force) {
    const refusal = await refuseUnsafeOutputDirReuse(path);
    if (refusal) return { ok: false, error: refusal };
  } else {
    await rm(path, { recursive: true, force: true });
  }
  await mkdir(path, { recursive: true });
  return { ok: true };
}

/**
 * Inspect an existing target and return the refusal it warrants, or `null` when reuse is safe.
 * Read-only: this never creates or removes anything.
 *
 * Exported because a command that writes several directories under one caller-supplied `--out` has
 * to decide about ALL of them before it creates ANY of them; `prepareOutputDir` creates on the
 * accepted path, so calling it in a loop would leave empty directories behind when a later one
 * refuses. Connectors pre-flight with this, then prepare.
 *
 * @param path Resolved (absolute) directory path to inspect.
 * @returns The refusal this target warrants, or `null` when writing into it destroys nothing.
 */
export async function refuseUnsafeOutputDirReuse(path: string): Promise<OutputDirGuardError | null> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return null;
  if (!existing.isDirectory()) {
    // `lstat` reports a symlink as a symlink even when it resolves to a directory. Refuse both: the
    // old `rm` unlinked the user's file (or their link) outright, which is exactly the loss we guard.
    return {
      code: "output_path_not_a_directory",
      path,
      message: `Output path already exists and is not a directory: ${path}. Nothing was written or deleted. Choose another --out path, or pass --force to replace it.`
    };
  }
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    // Unreadable (permissions, races): refusing is the safe default — we cannot prove the directory
    // is empty, so we must not fall through to a destructive path.
    return {
      code: "output_dir_unreadable",
      path,
      message: `Output directory could not be read: ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Nothing was written or deleted.`
    };
  }
  if (entries.length === 0) return null;
  return {
    code: "output_dir_not_empty",
    path,
    message: `Output directory is not empty: ${path} (${entries.length} existing ${entries.length === 1 ? "entry" : "entries"}). Nothing was written or deleted. Choose an empty or new --out path, or pass --force to replace its contents.`
  };
}


/** File names Motion writes into a frame directory. One half of the ownership evidence. */
const MOTION_FRAME_FILE = /^\d{6}\.png$/;

/** The other half: the bytes at the front of every PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PrepareFramesDirOptions = PrepareOutputDirOptions & {
  /**
   * `true` when the path traces back to something a caller chose — `--frames-dir`, an embedder's
   * scratch root, or a connector's `<out>/frames/<packageId>` under a caller-supplied `--out`.
   * `false` ONLY for Motion's own DEFAULT scratch root, which no caller named.
   *
   * Required (not optional) on purpose: this is the single fact that decides whether a recursive
   * delete is allowed without evidence, and every call site must state it rather than inherit a
   * default that later stops being true.
   */
  callerSupplied: boolean;
  /**
   * The root `path` must stay inside. When given, a `path` that resolves outside it is refused
   * before any branch runs, including the unconditional-wipe branch.
   *
   * `path` includes a package-controlled identifier. The identifier is charset-validated at the
   * loader, while this independent sink check closes the broader class: any future field joined
   * onto the path still cannot escape the expected root before deletion or creation.
   */
  withinRoot?: string;
};

/**
 * Prepare a frame directory for a render.
 *
 * A frames directory legitimately needs wiping — a stale frame from a longer previous render would
 * otherwise be encoded into this one — so the question is never "wipe or not" but "on what
 * evidence". Wipes when:
 *   - `force` (the caller asked), or
 *   - `callerSupplied: false` (Motion's own default scratch root), or
 *   - the directory is absent or empty (nothing to lose), or
 *   - every entry is a REGULAR FILE named like a Motion frame whose bytes start with the PNG
 *     signature (or is zero-length: the stub a crashed render leaves, with no content to lose).
 * Refuses anything else, because the alternative is deleting a caller's directory that happened to
 * be pointed at.
 *
 * What that evidence does and does not prove (the evidence-scope invariant narrowed this claim to what the code
 * enforces): it proves the directory holds nothing but files SHAPED like Motion's own output. It is
 * not proof of authorship — a caller's own PNG sequence named `000001.png…` is indistinguishable,
 * and `--force` is deliberately the only way past a refusal rather than a cleverer heuristic. The
 * previous rule tested names alone, so a DIRECTORY named `000001.png` (holding a caller's files)
 * was recursively deleted while the comment claimed content proved ownership; the type check now
 * refuses any non-file entry outright, whatever it is called.
 *
 * Rejected alternative: an ownership MARKER file written into the directory. It would prove
 * authorship, but it also licenses wiping arbitrary other content once present, and frame
 * directories are produced by entry points that would not carry it — turning a safety rail into a
 * wall on Motion's own output.
 *
 * @param path Resolved (absolute) frame directory path.
 * @param options.force Caller passed `--force`: wipe unconditionally.
 * @param options.callerSupplied See the type doc above.
 * @returns `{ ok: true }` with the directory existing and empty, or a typed refusal that removed
 *          and created nothing.
 */
export async function prepareFramesDir(path: string, options: PrepareFramesDirOptions): Promise<OutputDirGuardResult> {
  // Containment FIRST, before force and before callerSupplied. A path that escapes its root is not a
  // path this function may act on under any flag: `--force` means "wipe the directory I named", not
  // "wipe wherever this resolves to". Nothing is removed or created on this branch.
  if (options.withinRoot !== undefined) {
    const root = resolve(options.withinRoot);
    const target = resolve(path);
    const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
    if (target !== root && !target.startsWith(rootWithSep)) {
      return {
        ok: false,
        error: {
          code: "frames_dir_escapes_root",
          message:
            `Refusing to prepare a frames directory outside its root: resolved to ${target}, which is outside ${root}. ` +
            "A path component containing '..' or a path separator can steer this; identifiers used as path components " +
            "must be single safe components.",
          path: target
        }
      };
    }
  }
  // `=== false`, not `!callerSupplied`: the type makes the flag required, but a JavaScript caller (or
  // a stale build) that omits it must land on the GUARDED branch. Found by probing this function with
  // the field missing — the truthiness test silently granted the unguarded wipe.
  if (options.force || options.callerSupplied === false) {
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
    return { ok: true };
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && !existing.isDirectory()) {
    return { ok: false, error: { code: "output_path_not_a_directory", path, message: `Motion frames path exists and is not a directory: ${path}. Nothing was written or deleted. Choose another frames directory, or pass --force to replace it.` } };
  }
  if (existing) {
    const refusal = await refuseUnownedFramesDir(path);
    if (refusal) return { ok: false, error: refusal };
    await rm(path, { recursive: true, force: true });
  }
  await mkdir(path, { recursive: true });
  return { ok: true };
}

/**
 * Read-only ownership check for a frames directory: `null` when every entry is evidence Motion
 * wrote it, otherwise the refusal naming the entries that are not.
 */
async function refuseUnownedFramesDir(path: string): Promise<OutputDirGuardError | null> {
  let entries: Array<{ name: string; isFile: boolean }>;
  try {
    entries = (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  } catch (error) {
    return {
      code: "output_dir_unreadable",
      path,
      message: `Motion frames directory could not be read: ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Nothing was written or deleted.`
    };
  }
  const foreign: string[] = [];
  for (const entry of entries) {
    // Name first (cheap), then type, then bytes. A directory or symlink never passes, however it is
    // named — that is the reproduced the directory-entry ownership invariant loss.
    if (!MOTION_FRAME_FILE.test(entry.name) || !entry.isFile || !(await startsWithPngSignature(join(path, entry.name)))) {
      foreign.push(entry.name);
      // The refusal names at most three; stop opening files once the answer cannot change, so
      // pointing this at a directory of 100k unrelated files costs a readdir, not 100k opens.
      if (foreign.length > 3) break;
    }
  }
  if (foreign.length === 0) return null;
  return {
    code: "output_dir_not_empty",
    path,
    message: `Motion frames directory holds entries Motion did not write (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}): ${path}. Nothing was written or deleted. Choose an empty directory, or pass --force to overwrite it.`
  };
}

/** True when the file's first bytes are the PNG signature, or the file is empty (nothing to lose). */
async function startsWithPngSignature(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return true;
    return bytesRead === PNG_SIGNATURE.length && buffer.equals(PNG_SIGNATURE);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * Make `path` usable as a command's single-file deliverable (`render --preset mp4-h264 --out
 * clip.mp4`), refusing to destroy an existing file.
 *
 * The encode lane handed `--out` straight to FFmpeg's `-y`, so an existing file at a caller-chosen
 * path was overwritten with no guard and no `--force` — while the SAME command's `--out` as a
 * DIRECTORY (png-sequence) was guarded (the file-output ownership invariant). Same rule, applied to the file shape.
 *
 * A directory at the output path is refused even with `--force`: `--force` means "overwrite the
 * file I named", and silently recursive-deleting a directory to make room for a video is precisely
 * the blast radius this module exists to prevent.
 *
 * @param path Resolved (absolute) output file path.
 * @param options.force Caller passed `--force`: unlink the existing file first.
 * @returns `{ ok: true }` when the path is free to write, otherwise a typed refusal. On the forced
 *          path the existing file (or symlink) is unlinked, so writing cannot follow a link and
 *          overwrite its target in place.
 */
export async function prepareOutputFile(path: string, options: PrepareOutputDirOptions): Promise<OutputDirGuardResult> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return { ok: true };
  if (existing.isDirectory()) {
    return {
      ok: false,
      error: {
        code: "output_path_exists",
        path,
        message: `Output path is an existing directory: ${path}. Nothing was written or deleted. Motion will not delete a directory to write a file, with or without --force; choose a file path.`
      }
    };
  }
  if (!options.force) {
    return {
      ok: false,
      error: {
        code: "output_path_exists",
        path,
        message: `Output file already exists: ${path}. Nothing was written or deleted. Choose another --out path, or pass --force to overwrite it.`
      }
    };
  }
  await rm(path, { force: true });
  return { ok: true };
}


/**
 * A guard refusal thrown across a package boundary.
 *
 * Connectors signal failure by throwing, and a bare Error collapses into a generic
 * `connector_failed` at the CLI edge — which tells an agent nothing it can act on. Carrying the
 * typed code lets the refusal keep its identity all the way out to the caller.
 */
export class MotionOutputGuardError extends Error {
  constructor(readonly code: OutputDirGuardErrorCode, message: string, readonly path: string) {
    super(message);
    this.name = "MotionOutputGuardError";
    Object.setPrototypeOf(this, MotionOutputGuardError.prototype);
  }
}

/** Throw a guard result's refusal with its code intact, or return when it is safe to proceed. */
export function assertOutputDirGuard(result: OutputDirGuardResult): void {
  if (result.ok) return;
  throw new MotionOutputGuardError(result.error.code, result.error.message, result.error.path);
}
