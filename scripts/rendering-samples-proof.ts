/**
 * Executes only catalog-declared familyWorkflowBindings in fresh proof-owned scratch roots.
 *
 * This is intentionally a source gate, not an installed/native qualification. It never
 * removes prior proof runs: each invocation receives a new `.scratch/rendering-samples-proof/run-*`
 * directory and the workflow scripts are admitted to remove only their own child root. Canonical
 * sample invocations without a binding stay structural recipes: this runner neither executes nor
 * runtime-proves them, and it never expands into every delivery format.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { renderingSamplesProofRootEnvironment } from "./rendering-samples-proof-root";
import { validateRenderingSampleCatalog } from "./rendering-sample-catalog";

const ROOT = resolve(import.meta.dirname, "..");

type JsonRecord = Record<string, unknown>;
type WorkflowKind = "package-script" | "cli-import";
type ProofOutputKind = "file" | "directory";

export interface RenderingSamplesProofOutput {
  path: string;
  kind: ProofOutputKind;
  mediaType: "application/json" | "application/vnd.shellx.motion.package" | "video/mp4";
}

export interface RenderingSamplesProofBinding {
  familyId: string;
  title: string;
  kind: WorkflowKind;
  packageScript?: string;
  sourceCheckout?: string[];
  receiptOperations: string[];
  proofOutputs: RenderingSamplesProofOutput[];
}

/** Parses only the catalog information the source gate will execute. */
export function renderingSamplesProofPlan(catalog: JsonRecord): RenderingSamplesProofBinding[] {
  if (!Array.isArray(catalog.familyWorkflowBindings) || catalog.familyWorkflowBindings.length === 0) {
    throw new Error("rendering-sample catalog has no declared workflow bindings.");
  }
  return catalog.familyWorkflowBindings.map((entry, index) => proofBinding(entry, index));
}

export async function runRenderingSamplesProof(root = ROOT): Promise<{ proofRoot: string; bindings: Array<{ familyId: string; title: string }> }> {
  const validationErrors = await validateRenderingSampleCatalog(root);
  if (validationErrors.length > 0) {
    throw new Error(`rendering-sample catalog is not valid; refusing workflow proof:\n${validationErrors.map((error) => `- ${error}`).join("\n")}`);
  }
  const catalog = readRecord(JSON.parse(await readFile(join(root, "docs/public/rendering-sample-catalog.json"), "utf8")), "rendering-sample catalog");
  const plan = renderingSamplesProofPlan(catalog);
  const proofBase = resolve(root, ".scratch", "rendering-samples-proof");
  await mkdir(proofBase, { recursive: true });
  const proofRoot = await mkdtemp(join(proofBase, "run-"));
  const completed: Array<{ familyId: string; title: string }> = [];

  for (const [index, binding] of plan.entries()) {
    const bindingRoot = resolve(proofRoot, `${String(index + 1).padStart(2, "0")}-${fileToken(binding.familyId)}`);
    assertChildPath(proofRoot, bindingRoot, `${binding.familyId} proof root`);
    await mkdir(bindingRoot, { recursive: true });
    const execution = commandForBinding(binding, bindingRoot);
    const stdout = await runProcess(execution.command, execution.args, root, {
      ...process.env,
      [renderingSamplesProofRootEnvironment]: bindingRoot,
      SHELLX_MOTION_LEASE_ROOT: join(bindingRoot, "runtime", "job-leases"),
      SHELLX_MOTION_JOB_RECORD_ROOT: join(bindingRoot, "runtime", "job-records"),
      SHELLX_MOTION_JOB_COORDINATOR_ROOT: join(bindingRoot, "runtime", "job-coordinator"),
    });
    await assertProofOutputs(binding, bindingRoot);
    const receiptOperations = new Set(succeededMotionReceiptOperations([
      ...await jsonRecordsBelow(bindingRoot),
      ...parseProcessJsonRecords(stdout)
    ]));
    for (const expected of binding.receiptOperations) {
      if (!receiptOperations.has(expected)) {
        throw new Error(`${binding.familyId}: proof did not retain the declared succeeded ${expected} receipt operation.`);
      }
    }
    completed.push({ familyId: binding.familyId, title: binding.title });
  }
  return { proofRoot, bindings: completed };
}

function proofBinding(value: unknown, index: number): RenderingSamplesProofBinding {
  const binding = readRecord(value, `familyWorkflowBindings[${index}]`);
  const familyId = readString(binding.familyId, `familyWorkflowBindings[${index}].familyId`);
  const title = readString(binding.title, `${familyId}.title`);
  const kind = readString(binding.kind, `${familyId}.kind`);
  if (kind !== "package-script" && kind !== "cli-import") throw new Error(`${familyId}: unsupported workflow kind ${kind}.`);
  const receiptOperations = readStringArray(binding.receiptOperations, `${familyId}.receiptOperations`);
  const proofOutputs = readProofOutputs(binding.proofOutputs, familyId);
  if (kind === "package-script") {
    return { familyId, title, kind, packageScript: readString(binding.packageScript, `${familyId}.packageScript`), receiptOperations, proofOutputs };
  }
  return { familyId, title, kind, sourceCheckout: readStringArray(binding.sourceCheckout, `${familyId}.sourceCheckout`), receiptOperations, proofOutputs };
}

function readProofOutputs(value: unknown, familyId: string): RenderingSamplesProofOutput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${familyId}: proofOutputs must be a non-empty array.`);
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const output = readRecord(entry, `${familyId}.proofOutputs[${index}]`);
    const path = readString(output.path, `${familyId}.proofOutputs[${index}].path`);
    if (!isSafeRelativePath(path) || paths.has(path)) throw new Error(`${familyId}: proof output path must be unique and safely relative: ${path}.`);
    paths.add(path);
    const kind = readString(output.kind, `${familyId}.proofOutputs[${index}].kind`);
    if (kind !== "file" && kind !== "directory") throw new Error(`${familyId}: unsupported proof output kind ${kind}.`);
    const mediaType = readString(output.mediaType, `${familyId}.proofOutputs[${index}].mediaType`);
    if (mediaType !== "application/json" && mediaType !== "application/vnd.shellx.motion.package" && mediaType !== "video/mp4") {
      throw new Error(`${familyId}: unsupported proof output media type ${mediaType}.`);
    }
    return { path, kind, mediaType } as RenderingSamplesProofOutput;
  });
}

function commandForBinding(binding: RenderingSamplesProofBinding, bindingRoot: string): { command: string; args: string[] } {
  if (binding.kind === "package-script") return { command: "pnpm", args: ["run", binding.packageScript!] };
  const sourceCheckout = [...binding.sourceCheckout!];
  const outputIndex = sourceCheckout.lastIndexOf("--out");
  if (outputIndex < 0 || outputIndex === sourceCheckout.length - 1 || binding.proofOutputs.length !== 1) {
    throw new Error(`${binding.familyId}: cli-import proof requires exactly one declared --out package output.`);
  }
  sourceCheckout[outputIndex + 1] = proofOutputPath(bindingRoot, binding.proofOutputs[0]!);
  return { command: sourceCheckout[0]!, args: sourceCheckout.slice(1) };
}

async function assertProofOutputs(binding: RenderingSamplesProofBinding, bindingRoot: string): Promise<void> {
  for (const output of binding.proofOutputs) {
    const path = proofOutputPath(bindingRoot, output);
    const facts = await lstat(path);
    if (facts.isSymbolicLink()) throw new Error(`${binding.familyId}: proof output must not be a symlink: ${output.path}.`);
    if (output.kind === "directory") {
      if (!facts.isDirectory()) throw new Error(`${binding.familyId}: expected package directory ${output.path}.`);
      await assertRegularJson(join(path, "manifest.json"), `${binding.familyId} package manifest`);
      await assertRegularJson(join(path, "motion.json"), `${binding.familyId} package motion`);
    } else if (!facts.isFile()) {
      throw new Error(`${binding.familyId}: expected proof file ${output.path}.`);
    } else if (output.mediaType === "application/json") {
      await assertRegularJson(path, `${binding.familyId} proof JSON`);
    } else if (output.mediaType === "video/mp4") {
      const bytes = await readFile(path);
      if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
        throw new Error(`${binding.familyId}: expected ISO-base-media MP4 output at ${output.path}.`);
      }
    }
  }
}

function proofOutputPath(bindingRoot: string, output: RenderingSamplesProofOutput): string {
  const path = resolve(bindingRoot, output.path);
  assertChildPath(bindingRoot, path, `proof output ${output.path}`);
  return path;
}

async function assertRegularJson(path: string, label: string): Promise<void> {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error(`${label} must be a regular JSON file.`);
  JSON.parse(await readFile(path, "utf8"));
}

async function jsonRecordsBelow(root: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      records.push(...await jsonRecordsBelow(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      try { records.push(readRecord(JSON.parse(await readFile(path, "utf8")), path)); } catch { /* non-receipt JSON is irrelevant */ }
    }
  }
  return records;
}

function parseProcessJsonRecords(stdout: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try { records.push(readRecord(JSON.parse(trimmed), "workflow stdout")); } catch { /* multi-line pretty JSON is captured below */ }
  }
  const firstJsonLine = stdout.search(/^\{/m);
  if (firstJsonLine >= 0) {
    try { records.push(readRecord(JSON.parse(stdout.slice(firstJsonLine)), "workflow stdout")); } catch { /* stdout may include pnpm diagnostics */ }
  }
  return records;
}

/** Only a terminal succeeded Motion receipt can close a declared workflow receipt obligation. */
export function succeededMotionReceiptOperations(values: unknown[]): string[] {
  const operations = new Set<string>();
  for (const value of values) collectReceiptOperationsFromValue(value, operations);
  return [...operations];
}

function collectReceiptOperationsFromValue(value: unknown, operations: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReceiptOperationsFromValue(item, operations);
  } else if (value && typeof value === "object") {
    const record = value as JsonRecord;
    if (record.schema === "shellx-motion/receipt@1" && (record.status === "passed" || record.status === "warning") && typeof record.operation === "string") {
      operations.add(record.operation);
    }
    for (const nested of Object.values(record)) collectReceiptOperationsFromValue(nested, operations);
  }
}

async function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    if (!child.stdout || !child.stderr) {
      reject(new Error(`${command} did not provide captured proof output streams.`));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}: ${stderr || stdout}`)));
  });
}

function readRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a non-empty string array.`);
  }
  return value as string[];
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function assertChildPath(root: string, candidate: string, label: string): void {
  const child = relative(root, candidate);
  if (!child || child === ".." || child.startsWith(`..${sep}`)) throw new Error(`${label} escapes its managed proof root.`);
}

function fileToken(value: string): string { return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runRenderingSamplesProof();
  process.stdout.write(`${JSON.stringify({ ok: true, command: "rendering-samples:proof", ...result }, null, 2)}\n`);
}
