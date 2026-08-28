/** Native file/folder selection for the human Workbench. */
import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { workbenchDesktopChildEnvironment } from "./workbench-child-environment.js";
import { WorkbenchSystemExecutableUnavailableError, resolveWorkbenchSystemExecutable } from "./workbench-system-executable.js";

const execFileAsync = promisify(execFile);
const MAX_SELECTED_PATH_CHARS = 4096;

export type WorkbenchPathPurpose =
  | "package-root"
  | "receipts-root"
  | "render-output"
  | "quality-manifest";

/**
 * Internal-only picker purpose. It is deliberately absent from WorkbenchPathPurpose and the generic
 * `/workbench/select-path` parser, so an HTTP caller cannot request a local effect-module path.
 */
type EffectModuleManifestPickerPurpose = "effect-module-manifest";

export interface WorkbenchPathPickerRequest {
  purpose: WorkbenchPathPurpose | EffectModuleManifestPickerPurpose;
  kind: "folder" | "file" | "save-file";
  title: string;
  currentPath: string;
  extensions: string[];
}

export type WorkbenchPathPicker = (request: WorkbenchPathPickerRequest) => Promise<string | null>;

export type WorkbenchPathPickerResult =
  | { ok: true; cancelled: true }
  | { ok: true; cancelled: false; path: string }
  | { ok: false; status: number; code: string; message: string };

const PURPOSES: Record<WorkbenchPathPurpose, Omit<WorkbenchPathPickerRequest, "purpose" | "currentPath">> = {
  "package-root": { kind: "folder", title: "Choose a Motion package or collection", extensions: [] },
  "receipts-root": { kind: "folder", title: "Choose a receipt history folder", extensions: [] },
  "render-output": { kind: "save-file", title: "Choose where to save the render", extensions: [".mp4", ".webm", ".gif", ".png"] },
  "quality-manifest": { kind: "file", title: "Choose a quality manifest", extensions: [".json"] }
};

export function parseWorkbenchPathPurpose(value: unknown): WorkbenchPathPurpose | null {
  switch (value) {
    case "package-root":
    case "receipts-root":
    case "render-output":
    case "quality-manifest":
      return value;
    default:
      return null;
  }
}

export async function runWorkbenchPathPicker(
  purpose: unknown,
  currentPath: unknown,
  picker: WorkbenchPathPicker
): Promise<WorkbenchPathPickerResult> {
  const admittedPurpose = parseWorkbenchPathPurpose(purpose);
  if (admittedPurpose === null) {
    return { ok: false, status: 400, code: "invalid_path_purpose", message: "Choose a supported file or folder destination." };
  }
  const current = typeof currentPath === "string" ? currentPath.trim() : "";
  if (current.length > MAX_SELECTED_PATH_CHARS) {
    return { ok: false, status: 400, code: "invalid_current_path", message: "The current location is too long." };
  }

  let selected: string | null;
  try {
    selected = await picker({ purpose: admittedPurpose, ...PURPOSES[admittedPurpose], currentPath: current });
  } catch (error) {
    return {
      ok: false,
      status: 501,
      code: "path_picker_unavailable",
      message: error instanceof Error ? error.message : "The system file chooser is unavailable."
    };
  }
  if (selected === null || selected.trim() === "") return { ok: true, cancelled: true };
  if (selected.length > MAX_SELECTED_PATH_CHARS || !isAbsolute(selected)) {
    return { ok: false, status: 400, code: "invalid_selected_path", message: "The system chooser returned an invalid location." };
  }

  try {
    if (PURPOSES[admittedPurpose].kind === "folder") {
      const canonical = await realpath(selected);
      if (!(await stat(canonical)).isDirectory()) throw new Error("The selected location is not a folder.");
      return { ok: true, cancelled: false, path: canonical };
    }
    if (PURPOSES[admittedPurpose].kind === "file") {
      const canonical = await realpath(selected);
      if (!(await stat(canonical)).isFile()) throw new Error("The selected location is not a file.");
      const allowed = PURPOSES[admittedPurpose].extensions;
      if (allowed.length > 0 && !allowed.includes(extname(canonical).toLowerCase())) {
        throw new Error(`Choose a ${allowed.join(" or ")} file.`);
      }
      return { ok: true, cancelled: false, path: canonical };
    }

    const absolute = resolve(selected);
    const parent = await realpath(dirname(absolute));
    if (!(await stat(parent)).isDirectory()) throw new Error("The selected destination folder is unavailable.");
    const name = basename(absolute);
    if (!name || name === "." || name === "..") throw new Error("Choose a file name for the render.");
    const allowed = PURPOSES[admittedPurpose].extensions;
    if (allowed.length > 0 && !allowed.includes(extname(name).toLowerCase())) {
      throw new Error(`Choose a ${allowed.join(" or ")} file.`);
    }
    try {
      const target = await lstat(absolute);
      if (target.isSymbolicLink() || target.isDirectory()) throw new Error("Choose a regular output file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ok: true, cancelled: false, path: join(parent, name) };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: "invalid_selected_path",
      message: error instanceof Error ? error.message : "The selected location is unavailable."
    };
  }
}

/**
 * A host-shaped picker for C1 manifests. There is no `currentPath` or caller-selected purpose:
 * this can be reached only by the operator-gated management route.
 */
export async function runEffectModuleManifestPicker(
  picker: WorkbenchPathPicker
): Promise<WorkbenchPathPickerResult> {
  let selected: string | null;
  try {
    selected = await picker({
      purpose: "effect-module-manifest",
      kind: "file",
      title: "Choose a local Motion effect-module manifest",
      currentPath: "",
      extensions: [".json"]
    });
  } catch (error) {
    return {
      ok: false,
      status: 501,
      code: "path_picker_unavailable",
      message: error instanceof Error ? error.message : "The system file chooser is unavailable."
    };
  }
  if (selected === null || selected.trim() === "") return { ok: true, cancelled: true };
  if (selected.length > MAX_SELECTED_PATH_CHARS || !isAbsolute(selected)) {
    return { ok: false, status: 400, code: "invalid_selected_path", message: "The system chooser returned an invalid location." };
  }
  try {
    const selectedFacts = await lstat(selected);
    if (!selectedFacts.isFile() || selectedFacts.isSymbolicLink()) throw new Error("Choose a regular manifest file, not a link.");
    const canonical = await realpath(selected);
    if (!(await stat(canonical)).isFile()) throw new Error("The selected location is not a file.");
    if (extname(canonical).toLowerCase() !== ".json") throw new Error("Choose a .json file.");
    return { ok: true, cancelled: false, path: canonical };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: "invalid_selected_path",
      message: error instanceof Error ? error.message : "The selected location is unavailable."
    };
  }
}

export function createDefaultWorkbenchPathPicker(platform: NodeJS.Platform = process.platform): WorkbenchPathPicker {
  if (platform === "win32") return pickOnWindows;
  if (platform === "darwin") return pickOnMacos;
  if (platform === "linux") return pickOnLinux;
  return async () => { throw new Error("The system file chooser is not supported on this platform."); };
}

async function pickOnWindows(request: WorkbenchPathPickerRequest): Promise<string | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$kind = $env:SHELLX_MOTION_PICKER_KIND",
    "$title = $env:SHELLX_MOTION_PICKER_TITLE",
    "$current = $env:SHELLX_MOTION_PICKER_CURRENT",
    "if ($kind -eq 'folder') {",
    "  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "  $dialog.Description = $title",
    "  $dialog.ShowNewFolderButton = $true",
    "  if ($current -and (Test-Path -LiteralPath $current -PathType Container)) { $dialog.SelectedPath = $current }",
    "} elseif ($kind -eq 'file') {",
    "  $dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "  $dialog.Title = $title",
    "  $dialog.Filter = $env:SHELLX_MOTION_PICKER_FILTER",
    "  if ($current) { $parent = Split-Path -LiteralPath $current -Parent; if ($parent -and (Test-Path -LiteralPath $parent -PathType Container)) { $dialog.InitialDirectory = $parent } }",
    "} else {",
    "  $dialog = New-Object System.Windows.Forms.SaveFileDialog",
    "  $dialog.Title = $title",
    "  $dialog.Filter = 'Video and image files (*.mp4;*.webm;*.gif;*.png)|*.mp4;*.webm;*.gif;*.png|All files (*.*)|*.*'",
    "  $dialog.OverwritePrompt = $true",
    "  if ($current) { $parent = Split-Path -LiteralPath $current -Parent; if ($parent -and (Test-Path -LiteralPath $parent -PathType Container)) { $dialog.InitialDirectory = $parent }; $dialog.FileName = Split-Path -LiteralPath $current -Leaf }",
    "}",
    "$answer = $dialog.ShowDialog()",
    "if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "  if ($kind -eq 'folder') { [Console]::WriteLine($dialog.SelectedPath) } else { [Console]::WriteLine($dialog.FileName) }",
    "}",
    "$dialog.Dispose()"
  ].join("\n");
  const executable = await resolveWorkbenchSystemExecutable("windows-powershell");
  const { stdout } = await execFileAsync(executable, ["-NoProfile", "-STA", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024,
    env: {
      ...workbenchDesktopChildEnvironment(),
      SHELLX_MOTION_PICKER_KIND: request.kind,
      SHELLX_MOTION_PICKER_TITLE: request.title,
      SHELLX_MOTION_PICKER_CURRENT: request.currentPath,
      SHELLX_MOTION_PICKER_FILTER: "JSON files (*.json)|*.json|All files (*.*)|*.*"
    }
  });
  return stdout.trim() || null;
}

async function pickOnMacos(request: WorkbenchPathPickerRequest): Promise<string | null> {
  const lines = [
    "on run argv",
    "set pickerKind to item 1 of argv",
    "set pickerTitle to item 2 of argv",
    "if pickerKind is \"folder\" then",
    "set pickedItem to choose folder with prompt pickerTitle",
    "else if pickerKind is \"file\" then",
    "set pickedItem to choose file with prompt pickerTitle",
    "else",
    "set pickedItem to choose file name with prompt pickerTitle default name \"motion-render.mp4\"",
    "end if",
    "return POSIX path of pickedItem",
    "end run"
  ];
  try {
    const args = lines.flatMap((line) => ["-e", line]);
    args.push("--", request.kind, request.title);
    const executable = await resolveWorkbenchSystemExecutable("macos-osascript");
    const { stdout } = await execFileAsync(executable, args, {
      encoding: "utf8", maxBuffer: 32 * 1024, env: workbenchDesktopChildEnvironment()
    });
    return stdout.trim() || null;
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === "1") return null;
    throw error;
  }
}

async function pickOnLinux(request: WorkbenchPathPickerRequest): Promise<string | null> {
  const zenityArgs = ["--file-selection", `--title=${request.title}`];
  if (request.kind === "folder") zenityArgs.push("--directory");
  if (request.kind === "save-file") zenityArgs.push("--save", "--confirm-overwrite");
  if (request.currentPath) zenityArgs.push(`--filename=${request.currentPath}`);
  try {
    const executable = await resolveWorkbenchSystemExecutable("linux-zenity");
    const { stdout } = await execFileAsync(executable, zenityArgs, {
      encoding: "utf8", maxBuffer: 32 * 1024, env: workbenchDesktopChildEnvironment()
    });
    return stdout.trim() || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (String(code) === "1") return null;
    if (code !== "ENOENT" && !(error instanceof WorkbenchSystemExecutableUnavailableError)) throw error;
  }

  const kdialogArgs = request.kind === "folder"
    ? ["--getexistingdirectory", request.currentPath || ".", request.title]
    : request.kind === "save-file"
      ? ["--getsavefilename", request.currentPath || ".", "*.mp4 *.webm *.gif *.png", request.title]
      : ["--getopenfilename", request.currentPath || ".", request.purpose === "quality-manifest" ? "*.json" : request.extensions.map((extension) => `*${extension}`).join(" "), request.title];
  try {
    const executable = await resolveWorkbenchSystemExecutable("linux-kdialog");
    const { stdout } = await execFileAsync(executable, kdialogArgs, {
      encoding: "utf8", maxBuffer: 32 * 1024, env: workbenchDesktopChildEnvironment()
    });
    return stdout.trim() || null;
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === "1") return null;
    throw new Error("No supported Linux file chooser is installed (zenity or kdialog).", { cause: error });
  }
}
