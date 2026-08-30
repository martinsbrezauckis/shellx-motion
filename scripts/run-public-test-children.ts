/**
 * Runs the public-source test ladder as individually reported child commands.
 *
 * `pnpm test` remains the comprehensive public suite. This runner deliberately
 * owns only its fixed child argv declarations: no caller input can become a
 * child command, and an ordinary child failure does not hide later independent
 * failures.
 */
import { spawn } from "node:child_process";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHILD_RESULT_PATH_ENV = "RELEASE_STUDIO_CHILD_RESULT_PATH";
export const CHILD_RESULT_SCHEMA_VERSION = "release-studio.gate-child-results.v1" as const;
export const PUBLIC_TEST_SUITE = "shellx-motion/test-public" as const;

type ChildStatus = "pass" | "fail";

export interface PublicTestChild {
  readonly id: string;
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
}

export interface PublicTestChildResult {
  readonly id: string;
  readonly command: string;
  readonly status: ChildStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

export interface PublicTestChildEnvelope {
  readonly schemaVersion: typeof CHILD_RESULT_SCHEMA_VERSION;
  readonly suite: typeof PUBLIC_TEST_SUITE;
  readonly status: ChildStatus;
  readonly children: readonly PublicTestChildResult[];
}

function pnpmChild(id: string, args: readonly string[]): PublicTestChild {
  const command = ["pnpm", ...args].join(" ");
  // pnpm's Windows shim is a .cmd file. The cmd invocation is entirely static:
  // values come only from this source file, never arguments or the environment.
  if (process.platform === "win32") {
    return { id, command, executable: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { id, command, executable: "pnpm", args };
}

/** This is the former package.json && chain, in its declared execution order. */
export const PUBLIC_TEST_CHILDREN: readonly PublicTestChild[] = [
  pnpmChild("source-hygiene-public", ["run", "source-hygiene:public"]),
  pnpmChild("docs-check", ["docs:check"]),
  pnpmChild("args-check", ["run", "args:check"]),
  pnpmChild("version-check", ["run", "version:check"]),
  pnpmChild("architecture-check", ["run", "architecture:check"]),
  pnpmChild("corpus-check", ["run", "corpus:check"]),
  pnpmChild("script-tests", ["run", "test:scripts"]),
  pnpmChild("workspace-tests", ["-r", "--no-bail", "--workspace-concurrency=1", "--if-present", "run", "test", "--pool=forks", "--maxWorkers=1", "--no-file-parallelism"]),
];

export function assertNoRunnerArguments(argv: readonly string[]): void {
  if (argv.length !== 0) {
    throw new Error(`test:public child runner accepts no arguments; received ${JSON.stringify(argv)}`);
  }
}

/**
 * Validates a receipt destination without creating it. Release Studio owns the
 * parent directory and opts in by setting the environment variable.
 */
export function assertSafeChildResultPath(destination: string): string {
  if (!destination || destination.includes("\0") || !isAbsolute(destination) || resolve(destination) !== destination) {
    throw new Error(`${CHILD_RESULT_PATH_ENV} must be a normalized absolute path`);
  }

  assertSafeDirectoryHierarchy(dirname(destination));
  assertAbsentRegularFileDestination(destination);
  return destination;
}

function assertSafeDirectoryHierarchy(directory: string): void {
  let current = directory;
  for (;;) {
    let facts: ReturnType<typeof lstatSync>;
    try {
      facts = lstatSync(current);
    } catch (error) {
      throw new Error(`${CHILD_RESULT_PATH_ENV} parent is unavailable: ${current}`, { cause: error });
    }
    if (facts.isSymbolicLink()) throw new Error(`${CHILD_RESULT_PATH_ENV} parent is symlinked: ${current}`);
    if (!facts.isDirectory()) throw new Error(`${CHILD_RESULT_PATH_ENV} parent is not a directory: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertAbsentRegularFileDestination(destination: string): void {
  try {
    const facts = lstatSync(destination);
    if (facts.isSymbolicLink()) throw new Error(`${CHILD_RESULT_PATH_ENV} destination is a symlink: ${destination}`);
    if (!facts.isFile()) throw new Error(`${CHILD_RESULT_PATH_ENV} destination is not a regular file: ${destination}`);
    throw new Error(`${CHILD_RESULT_PATH_ENV} destination already exists: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function runPublicTestChildren(
  children: readonly PublicTestChild[] = PUBLIC_TEST_CHILDREN,
  cwd = process.cwd(),
): Promise<PublicTestChildEnvelope> {
  const results: PublicTestChildResult[] = [];
  for (const child of children) results.push(await runChild(child, cwd));
  return {
    schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
    suite: PUBLIC_TEST_SUITE,
    status: results.every((result) => result.status === "pass") ? "pass" : "fail",
    children: results,
  };
}

async function runChild(child: PublicTestChild, cwd: string): Promise<PublicTestChildResult> {
  const startedAtMs = Date.now();
  const inheritedEnvironment = { ...process.env };
  // This runner is the only consumer of the receipt destination. Do not let a
  // nested package invocation accidentally contend for the same create-only file.
  delete inheritedEnvironment[CHILD_RESULT_PATH_ENV];

  return await new Promise((resolveResult) => {
    let settled = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      resolveResult({
        id: child.id,
        command: child.command,
        status: exitCode === 0 && signal === null ? "pass" : "fail",
        exitCode,
        signal,
        durationMs,
      });
    };

    let processChild;
    try {
      processChild = spawn(child.executable, [...child.args], {
        cwd,
        env: inheritedEnvironment,
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      });
    } catch {
      settle(null, null);
      return;
    }
    processChild.once("error", () => settle(null, null));
    processChild.once("close", (exitCode, signal) => settle(exitCode, signal));
  });
}

/** JSON.stringify preserves this object property's declared insertion order. */
export function formatChildResultSummary(envelope: PublicTestChildEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Publishes a fully written envelope at one new destination name. A temp file
 * is fsynced, then hard-linked into place: the final path is never partially
 * written and an existing path can never be replaced.
 */
export function writeChildResultEnvelope(destination: string, envelope: PublicTestChildEnvelope): void {
  const checkedDestination = assertSafeChildResultPath(destination);
  const temporary = `${checkedDestination}.tmp-${process.pid}-${randomUUID()}`;
  const content = `${formatChildResultSummary(envelope)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, checkedDestination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function main(argv = process.argv.slice(2), receiptPath = process.env[CHILD_RESULT_PATH_ENV]): Promise<number> {
  try {
    assertNoRunnerArguments(argv);
    const checkedReceiptPath = receiptPath === undefined ? undefined : assertSafeChildResultPath(receiptPath);
    const envelope = await runPublicTestChildren();
    let receiptError: unknown;
    if (checkedReceiptPath) {
      try {
        writeChildResultEnvelope(checkedReceiptPath, envelope);
      } catch (error) {
        receiptError = error;
      }
    }
    process.stdout.write(`${formatChildResultSummary(envelope)}\n`);
    if (receiptError) throw receiptError;
    return envelope.status === "pass" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`test:public child runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
