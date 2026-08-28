#!/usr/bin/env node
/**
 * Generate a deterministic CycloneDX 1.6 SBOM from the committed pnpm lockfile
 * and workspace manifests. It deliberately uses only Node built-ins: no install,
 * network request, package lifecycle hook, node_modules scan, or host-binary
 * discovery is part of this inventory.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILE = join(ROOT, "pnpm-lock.yaml");
const DEFAULT_OUTPUT = join(ROOT, ".scratch", "sbom", "shellx-motion.cdx.json");
const SOURCE_PROPERTY = "shellx-motion:component-source";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`SBOM generation failed: ${message}`);
}

function parseArgs(argv) {
  let out = DEFAULT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" && index === 0) continue;
    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--out requires a file path");
      out = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/generate-sbom.mjs [--out <file>]");
      process.exit(0);
    }
    fail(`unknown argument ${JSON.stringify(arg)}`);
  }
  return out;
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  return trimmed.replace(/\s+#.*$/, "");
}

/**
 * Read the only lockfile area the SBOM needs: pnpm v9's resolved registry
 * packages and their SRI integrity strings. This is intentionally a narrow
 * structural reader, not a general YAML parser; a changed lockfile shape fails
 * closed rather than silently producing a partial inventory.
 */
function readLockfilePackages(lockfile) {
  const lines = lockfile.split(/\r?\n/);
  const records = [];
  let inPackages = false;
  let active;
  let inResolutionBlock = false;

  for (const line of lines) {
    if (!inPackages) {
      if (line === "packages:") inPackages = true;
      continue;
    }
    if (/^[^\s]/.test(line)) break;

    const packageKey = /^ {2}(\S.*):\s*$/.exec(line);
    if (packageKey) {
      active = { key: yamlScalar(packageKey[1]), integrity: undefined };
      records.push(active);
      inResolutionBlock = false;
      continue;
    }
    if (!active) continue;

    const inlineResolution = /^ {4}resolution:\s*\{(.+)\}\s*$/.exec(line);
    if (inlineResolution) {
      const integrity = /(?:^|,)\s*integrity:\s*([^,}\s]+)/.exec(inlineResolution[1]);
      if (integrity) active.integrity = yamlScalar(integrity[1]);
      inResolutionBlock = false;
      continue;
    }
    if (/^ {4}resolution:\s*$/.test(line)) {
      inResolutionBlock = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) inResolutionBlock = false;
    if (inResolutionBlock) {
      const integrity = /^ {6}integrity:\s*(.+)$/.exec(line);
      if (integrity) active.integrity = yamlScalar(integrity[1]);
    }
  }

  if (!inPackages || records.length === 0) fail("pnpm-lock.yaml does not contain a populated packages section");
  return records;
}

function parseNpmPackageKey(key) {
  const withoutPeerContext = key.split("(", 1)[0];
  const separator = withoutPeerContext.lastIndexOf("@");
  if (separator <= 0 || separator === withoutPeerContext.length - 1) return undefined;
  const name = withoutPeerContext.slice(0, separator);
  const version = withoutPeerContext.slice(separator + 1);
  if (!name || !version || /^(?:file:|link:|workspace:)/.test(version)) return undefined;
  return { name, version };
}

function packageUrl(name, version) {
  if (name.startsWith("@")) {
    const separator = name.indexOf("/");
    if (separator === -1) fail(`invalid scoped npm package name ${JSON.stringify(name)}`);
    return `pkg:npm/${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity, key) {
  const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) fail(`package ${JSON.stringify(key)} has no supported SRI integrity hash`);
  const algorithm = new Map([
    ["sha1", "SHA-1"],
    ["sha256", "SHA-256"],
    ["sha384", "SHA-384"],
    ["sha512", "SHA-512"]
  ]).get(match[1]);
  const content = Buffer.from(match[2], "base64").toString("hex");
  if (!content) fail(`package ${JSON.stringify(key)} has an empty integrity hash`);
  return { alg: algorithm, content };
}

function readWorkspaceManifests() {
  const manifestPaths = [join(ROOT, "package.json")];
  const packagesRoot = join(ROOT, "packages");
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json"))) {
      manifestPaths.push(join(packagesRoot, entry.name, "package.json"));
    }
  }

  return manifestPaths
    .sort(compareCodeUnits)
    .map((manifestPath) => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        fail(`${relative(ROOT, manifestPath)} must declare string name and version fields`);
      }
      return { name: manifest.name, version: manifest.version, path: manifestPath };
    });
}

function component(name, version, type, source, hashes) {
  const ref = packageUrl(name, version);
  return {
    "bom-ref": ref,
    type,
    name,
    version,
    purl: ref,
    ...(hashes ? { hashes: [hashes] } : {}),
    properties: [{ name: SOURCE_PROPERTY, value: source }]
  };
}

function buildBom() {
  const workspaces = readWorkspaceManifests();
  const rootWorkspace = workspaces.find((workspace) => workspace.path === join(ROOT, "package.json"));
  if (!rootWorkspace) fail("root package.json was not collected as a workspace manifest");

  const externalByRef = new Map();
  for (const record of readLockfilePackages(readFileSync(LOCKFILE, "utf8"))) {
    const parsed = parseNpmPackageKey(record.key);
    if (!parsed) fail(`unsupported pnpm lockfile package key ${JSON.stringify(record.key)}`);
    const ref = packageUrl(parsed.name, parsed.version);
    const hash = integrityHash(record.integrity, record.key);
    const existing = externalByRef.get(ref);
    if (existing && JSON.stringify(existing.hashes) !== JSON.stringify([hash])) {
      fail(`conflicting integrity hashes for ${ref}`);
    }
    externalByRef.set(ref, component(parsed.name, parsed.version, "library", "pnpm-lock.yaml", hash));
  }

  const workspaceComponents = workspaces
    .filter((workspace) => workspace !== rootWorkspace)
    .map((workspace) => component(workspace.name, workspace.version, "library", "workspace package.json"));
  const components = [...workspaceComponents, ...externalByRef.values()]
    .sort((left, right) => compareCodeUnits(left["bom-ref"], right["bom-ref"]));

  return {
    "$schema": "https://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: component(rootWorkspace.name, rootWorkspace.version, "application", "workspace package.json"),
      properties: [
        { name: "shellx-motion:inventory", value: "workspace manifests and resolved pnpm-lock.yaml packages" },
        { name: "shellx-motion:reproducible", value: "no timestamp, serial number, host path, or host binary discovery" }
      ]
    },
    components
  };
}

function main() {
  const out = parseArgs(process.argv.slice(2));
  const output = `${JSON.stringify(buildBom(), null, 2)}\n`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, output, "utf8");
  console.log(`Wrote deterministic CycloneDX 1.6 SBOM with ${JSON.parse(output).components.length} components to ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
