/**
 * scripts/version-parity.ts — one engine, one version number.
 *
 * ROLE
 * ----
 * ShellX Motion reports its version on six surfaces: the workspace manifests, the CLI
 * (`shellx-motion --version`), the local SDK capability contract, the loopback debug server
 * (`GET /health`, `GET /debug/contracts`), the MCP handshake (`serverInfo.version`, which also
 * drives the Engine Room update comparison against the GitHub release feed), and the published
 * docs. Before this script existed the manifests said `0.1.0` while the engine constant said
 * `0.0.0`, so `shellx-motion --version` and `/health` disagreed about the same build.
 *
 * That split was documented as deliberate ("pre-release builds report 0.0.0 until a tagged
 * release"), but the rationale did not survive contact with the tree: the doc comment claimed
 * `0.0.0` "matches every workspace package.json" and every workspace package.json said `0.1.0`.
 * It was a stale literal left behind by the manifest bump, not a design. An update check that
 * compares a hardcoded `0.0.0` against the release feed is not "honestly behind" either — it
 * reports every build, including a tagged one, as out of date forever.
 *
 * SOURCE OF TRUTH: the root `package.json` `version` field. Every other surface is generated
 * from it or asserted against it here. Bump it in one place, run `pnpm run version:sync`.
 *
 * MODES
 *   pnpm run version:sync    write the generated surfaces (packages/debug-api/src/version.ts and
 *                            every workspace manifest version) from the root manifest
 *   pnpm run version:check   fail on any disagreement — wired into `pnpm test`
 *
 * WHAT `--check` PROVES (each one a live value, not a grep, except where noted)
 *   1. the root version is valid semver
 *   2. every `packages/<pkg>/package.json` version equals it
 *   3. `packages/debug-api/src/version.ts` is byte-identical to what this script generates
 *   4. the imported `MOTION_ENGINE_VERSION` constant equals it
 *   5. `runCli(["--version"])` reports it
 *   6. the local SDK capability contract reports it
 *   7. a real loopback debug server reports it on `GET /health` and in the MCP `serverInfo`
 *      handshake over `POST /rpc`
 *   8. the documented version claims match it (static, one registered claim per doc file)
 *   9. no shipping source outside the generated file hardcodes a version-shaped literal into a
 *      version-reporting field — the static scan that stops surface #7 drifting again
 *
 * DEPENDENCIES: the workspace packages themselves (imported from source, as the other tsx gates
 * do), plus node built-ins. No network: step 7 binds an ephemeral loopback port and closes it.
 *
 * CALLERS: root `pnpm run version:sync` / `pnpm run version:check`; `pnpm test`.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";
import { MOTION_ENGINE_VERSION } from "../packages/debug-api/src/version";
import { startMotionDebugServer } from "../packages/debug-server/src/index";
import { createLocalMotionSdk } from "../packages/sdk/src/local";
import { compareCodeUnits } from "../packages/core/src/canonical-json";
import { isNonShippingSource } from "./source-modules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const GENERATED_VERSION_MODULE = join(PACKAGES_DIR, "debug-api", "src", "version.ts");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Documented version claims. Each entry names a file and a regex whose first capture group must
 * equal the source-of-truth version. A registry rather than a scan: a bare "look for a semver in
 * the docs" check would fire on `127.0.0.1`, Node version floors and MCP protocol dates.
 *
 * Add an entry whenever a doc states the engine version. `pnpm run version:sync` rewrites the
 * captured group, so a bump does not mean hand-editing prose.
 */
const DOC_CLAIMS: Array<{ file: string; pattern: RegExp; label: string }> = [
  {
    file: "docs/public/host-integration.md",
    pattern: /`serverInfo\.version` reports `(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`/,
    label: "serverInfo.version claim"
  }
];

/**
 * Fields whose value is a version string. A literal assigned to one of these outside the
 * generated module is the exact defect this gate exists to prevent, so the scan is by field
 * name rather than by file: it catches the next hardcode wherever someone puts it.
 */
const VERSION_FIELD_PATTERN =
  /\b(?:MOTION_ENGINE_VERSION|sdkVersion|engineVersion|currentVersion|latestVersion)\b\s*[:=]\s*"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)"/g;

/** Version-shaped literals that are not the engine version and are legitimately hardcoded. */
const VERSION_LITERAL_EXEMPT_FILES = new Set<string>([
  relative(ROOT, GENERATED_VERSION_MODULE).replaceAll("\\", "/")
]);

/** The generated body of `packages/debug-api/src/version.ts` for a given version. */
function generatedVersionModule(version: string): string {
  return `/**
 * version.ts — canonical ShellX Motion engine version.
 *
 * GENERATED FILE — do not edit by hand. Generated by \`scripts/version-parity.ts\` from the
 * \`version\` field of the repository root \`package.json\`, which is the single source of truth
 * for every version ShellX Motion reports. Regenerate with \`pnpm run version:sync\`;
 * \`pnpm run version:check\` (part of \`pnpm test\`) fails when this file, the workspace
 * manifests, the CLI, the SDK, the debug server or the docs disagree.
 *
 * Role: the constant every runtime surface reads, so a version reported to a user or an agent
 * can never differ between transports — the CLI banner, \`GET /health\`, \`GET /debug/contracts\`,
 * the MCP \`serverInfo\` handshake, the local SDK capability contract, and the Engine Room
 * update comparison against the GitHub release feed all resolve to this one string.
 *
 * Dependencies: none (a leaf constant module, safe to import anywhere).
 *
 * Primary callers: \`@shellx-motion/debug-server\` (transport payloads and the
 * \`/workbench/update-check\` / \`/workbench/update-apply\` comparison), \`@shellx-motion/sdk\`
 * (\`createLocalMotionSdk().capabilities().sdkVersion\`).
 *
 * Releasing: bump the root \`package.json\` version, run \`pnpm run version:sync\`, commit the
 * regenerated manifests and this file together.
 */
export const MOTION_ENGINE_VERSION = ${JSON.stringify(version)};
`;
}

/** Read and parse a JSON file. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

/** Every workspace package manifest path, sorted. `packages/fixtures` has none and is skipped. */
async function packageManifestPaths(): Promise<string[]> {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => compareCodeUnits(a.name, b.name))) {
    const manifest = join(PACKAGES_DIR, entry.name, "package.json");
    try {
      await readFile(manifest, "utf8");
      paths.push(manifest);
    } catch {
      // No manifest — not a publishable package (packages/fixtures).
    }
  }
  return paths;
}

/** The source of truth. */
async function sourceOfTruth(): Promise<string> {
  const root = await readJson(join(ROOT, "package.json"));
  const version = root.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Root package.json version must be semver, found ${JSON.stringify(version)}.`);
  }
  return version;
}

/**
 * Every shipping source file under `packages/<pkg>/src`, as repo-relative posix paths. Test
 * scaffolding is skipped through the shared convention (`scripts/source-modules.mjs`) so this
 * scan and the build agree on what "shipping" means.
 */
async function shippingSources(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relativePath = relative(ROOT, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        if (isNonShippingSource(relativePath)) continue;
        await walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !isNonShippingSource(relativePath)) {
        found.push(relativePath);
      }
    }
  };
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    await walk(join(PACKAGES_DIR, entry.name, "src"));
  }
  return found.sort();
}

/** Write every generated version surface from the source of truth. */
async function sync(): Promise<string[]> {
  const version = await sourceOfTruth();
  const written: string[] = [];

  for (const manifestPath of await packageManifestPaths()) {
    const text = await readFile(manifestPath, "utf8");
    const current = (JSON.parse(text) as { version?: unknown }).version;
    if (current === version) continue;
    // Rewrite the top-level key in place rather than re-serialising the manifest: JSON.stringify
    // would reformat the whole file. The pattern is anchored to a top-level (two-space indented)
    // `"version"` entry carrying the value the parse just read, so a nested `version` field
    // elsewhere in the manifest can never be the one that gets rewritten.
    const anchored = new RegExp(`^(  "version"\\s*:\\s*)${JSON.stringify(String(current)).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    const updated = text.replace(anchored, `$1${JSON.stringify(version)}`);
    if (updated === text) {
      throw new Error(`Could not rewrite the version in ${relative(ROOT, manifestPath)}; expected a top-level "version": ${JSON.stringify(current)} entry.`);
    }
    await writeFile(manifestPath, updated, "utf8");
    written.push(relative(ROOT, manifestPath));
  }

  const generated = generatedVersionModule(version);
  if ((await readFile(GENERATED_VERSION_MODULE, "utf8").catch(() => "")) !== generated) {
    await writeFile(GENERATED_VERSION_MODULE, generated, "utf8");
    written.push(relative(ROOT, GENERATED_VERSION_MODULE));
  }

  for (const claim of DOC_CLAIMS) {
    const path = join(ROOT, claim.file);
    const text = await readFile(path, "utf8");
    const updated = text.replace(
      new RegExp(claim.pattern.source, "g"),
      (match, captured: string) => match.replace(captured, version)
    );
    if (updated !== text) {
      await writeFile(path, updated, "utf8");
      written.push(claim.file);
    }
  }

  return written;
}

/** Every parity assertion. Returns one line per disagreement; empty means the engine agrees. */
async function check(): Promise<string[]> {
  const version = await sourceOfTruth();
  const problems: string[] = [];

  // 1-2. Workspace manifests.
  for (const manifestPath of await packageManifestPaths()) {
    const manifest = await readJson(manifestPath);
    if (manifest.version !== version) {
      problems.push(`${relative(ROOT, manifestPath)} version is ${JSON.stringify(manifest.version)}, root package.json says ${version}.`);
    }
  }

  // 3. The generated constant module is exactly what this script would write.
  const generated = generatedVersionModule(version);
  const onDisk = await readFile(GENERATED_VERSION_MODULE, "utf8").catch(() => "");
  if (onDisk !== generated) {
    problems.push(`${relative(ROOT, GENERATED_VERSION_MODULE)} is stale or hand-edited. Run pnpm run version:sync.`);
  }

  // 4. The constant as imported by every runtime surface.
  if (MOTION_ENGINE_VERSION !== version) {
    problems.push(`MOTION_ENGINE_VERSION is ${MOTION_ENGINE_VERSION}, root package.json says ${version}.`);
  }

  // 5. The CLI banner — the surface a host probes with `shellx-motion --version`.
  const cliVersion = (await runCli(["--version"])).version as unknown;
  if (cliVersion !== version) {
    problems.push(`CLI --version reports ${JSON.stringify(cliVersion)}, root package.json says ${version}.`);
  }

  // 6. The local SDK capability contract.
  const capabilities = await createLocalMotionSdk().capabilities();
  if (capabilities.sdkVersion !== version) {
    problems.push(`Local SDK capabilities sdkVersion is ${JSON.stringify(capabilities.sdkVersion)}, root package.json says ${version}.`);
  }

  // 7. A real loopback debug server: unauthenticated /health and the MCP handshake.
  const server = await startMotionDebugServer({ port: 0, defaultTier: "read_motion" });
  try {
    const health = await fetch(new URL("/health", server.url));
    const healthBody = await health.json() as { engineVersion?: unknown };
    if (healthBody.engineVersion !== version) {
      problems.push(`Debug server GET /health engineVersion is ${JSON.stringify(healthBody.engineVersion)}, root package.json says ${version}.`);
    }

    const rpc = await fetch(new URL("/rpc", server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${server.capabilityToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "version-parity",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "shellx-motion-version-parity", version }
        }
      })
    });
    const rpcBody = await rpc.json() as { result?: { serverInfo?: { version?: unknown } } };
    const serverInfoVersion = rpcBody.result?.serverInfo?.version;
    if (serverInfoVersion !== version) {
      problems.push(`MCP serverInfo.version is ${JSON.stringify(serverInfoVersion)}, root package.json says ${version}.`);
    }

    // `GET /debug/contracts` carries the canonical engine version to the workbench, and this file's
    // own header listed it as a version surface, so this gate must query it. A constant can evade
    // the static literal scan below and make
    // /health and /debug/contracts of the SAME RUNNING SERVER report different versions while this
    // gate reported PASS. A surface that is only checked by a text scan is not checked: the scan
    // proves what a file says, and a live fetch proves what the server answers.
    const contracts = await fetch(new URL("/debug/contracts", server.url), {
      headers: { authorization: `Bearer ${server.capabilityToken}` }
    });
    const contractsBody = await contracts.json() as { engineVersion?: unknown };
    if (contractsBody.engineVersion !== version) {
      problems.push(`Debug server GET /debug/contracts engineVersion is ${JSON.stringify(contractsBody.engineVersion)}, root package.json says ${version}.`);
    }
  } finally {
    await server.close();
  }

  // 8. Documented version claims.
  for (const claim of DOC_CLAIMS) {
    const text = await readFile(join(ROOT, claim.file), "utf8").catch(() => null);
    if (text === null) {
      problems.push(`${claim.file} is missing but registered as carrying the ${claim.label}.`);
      continue;
    }
    const match = claim.pattern.exec(text);
    if (match === null) {
      problems.push(`${claim.file} no longer states the ${claim.label}; update DOC_CLAIMS in scripts/version-parity.ts.`);
    } else if (match[1] !== version) {
      problems.push(`${claim.file} ${claim.label} says ${match[1]}, root package.json says ${version}.`);
    }
  }

  // 9. No second hardcoded literal anywhere in shipping source.
  for (const file of await shippingSources()) {
    if (VERSION_LITERAL_EXEMPT_FILES.has(file)) continue;
    const text = await readFile(join(ROOT, file), "utf8");
    for (const match of text.matchAll(VERSION_FIELD_PATTERN)) {
      problems.push(
        `${file} hardcodes a version literal (${match[0].trim()}). Import MOTION_ENGINE_VERSION from @shellx-motion/debug-api instead.`
      );
    }
  }

  return problems;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const problems = await check();
    if (problems.length > 0) {
      console.error(`version:check FAIL — ${problems.length} disagreement(s) about the engine version:`);
      for (const problem of problems) console.error(`  ${problem}`);
      console.error("\nSource of truth is the root package.json version. Run pnpm run version:sync after bumping it.");
      process.exit(1);
    }
    console.log(`version:check PASS — every surface reports ${await sourceOfTruth()}.`);
    return;
  }

  const written = await sync();
  const version = await sourceOfTruth();
  if (written.length === 0) {
    console.log(`version:sync — already at ${version}, nothing to write.`);
    return;
  }
  console.log(`version:sync — wrote ${version} to ${written.length} file(s):`);
  for (const file of written) console.log(`  ${file}`);
}

await main();
