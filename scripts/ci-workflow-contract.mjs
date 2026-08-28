/**
 * Deterministic contract for the CI files that actionlint/YAML parsing alone cannot prove:
 * every action ref is immutable, fork PRs do not use pull_request_target, and the new host and
 * security lanes retain their deliberately narrow scopes.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = new Map([
  ["verify", ".github/workflows/verify.yml"],
  ["host verification", ".github/workflows/host-verify.yml"],
  ["dependency review", ".github/workflows/dependency-review.yml"],
  ["CodeQL", ".github/workflows/codeql.yml"],
  ["SBOM", ".github/workflows/sbom.yml"]
]);
const expectedActionPins = new Map([
  ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
  ["pnpm/action-setup", "b906affcce14559ad1aafd4ab0e942779e9f58b1"],
  ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["actions/upload-artifact", "b7c566a772e6b6bfb58ed0dc250532a479d7789f"],
  ["actions/dependency-review-action", "a1d282b36b6f3519aa1f3fc636f609c47dddb294"],
  ["github/codeql-action/init", "d1ba80a13dd99fba24a470575428917156a28b43"],
  ["github/codeql-action/analyze", "d1ba80a13dd99fba24a470575428917156a28b43"]
]);

const failures = [];
const contents = new Map([...workflows].map(([name, file]) => [name, readFileSync(resolve(root, file), "utf8")]));

function requireText(name, text, expected) {
  if (!text.includes(expected)) failures.push(`${name}: missing ${JSON.stringify(expected)}`);
}

function forbidText(name, text, forbidden) {
  if (text.includes(forbidden)) failures.push(`${name}: must not contain ${JSON.stringify(forbidden)}`);
}

function forbidWorkflowKey(name, text, key) {
  if (new RegExp(`^\\s*${key}:`, "m").test(text)) failures.push(`${name}: must not declare ${key}`);
}

function requireOnlyTopLevelPermissions(name, text, expected) {
  const block = /^permissions:\n((?: {2}[a-z-]+:\s*[^\n]+\n?)*)/m.exec(text)?.[1];
  if (!block) {
    failures.push(`${name}: must declare top-level permissions`);
    return;
  }
  const actual = [...block.matchAll(/^ {2}([a-z-]+):\s*(\S+)\s*$/gm)].map((match) => `${match[1]}:${match[2]}`);
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    failures.push(`${name}: top-level permissions must be exactly ${expected.join(", ")}`);
  }
  if (/^ {4}permissions:/m.test(text)) failures.push(`${name}: must not widen permissions at job level`);
}

for (const [name, text] of contents) {
  forbidWorkflowKey(name, text, "pull_request_target");
  for (const reference of text.matchAll(/\buses:\s*([^\s#]+)/g)) {
    const [action, ref] = reference[1].split("@");
    if (!/^[a-f0-9]{40}$/.test(ref ?? "")) {
      failures.push(`${name}: ${action} must use a 40-character immutable SHA`);
      continue;
    }
    const expected = expectedActionPins.get(action);
    if (expected !== ref) failures.push(`${name}: ${action} must use the reviewed SHA`);
  }
}

for (const [name, text] of contents) {
  if (text.includes("actions/checkout@")) requireText(name, text, "persist-credentials: false");
}

const host = contents.get("host verification");
requireText("host verification", host, "os: windows-latest");
requireText("host verification", host, "os: macos-latest");
requireText("host verification", host, "pnpm run typecheck");
requireText("host verification", host, "pnpm run build");
requireText("host verification", host, "pnpm run contracts:check");
requireText("host verification", host, "pnpm --filter @shellx-motion/core exec vitest run");
requireText("host verification", host, "src/windows-job-object.test.ts");
requireText("host verification", host, "src/path-contract.test.ts");
forbidText("host verification", host, "SHELLX_MOTION_BROWSER");

const dependencyReview = contents.get("dependency review");
requireText("dependency review", dependencyReview, "contents: read");
requireText("dependency review", dependencyReview, "fail-on-severity: high");

const codeql = contents.get("CodeQL");
requireText("CodeQL", codeql, "actions: read");
requireText("CodeQL", codeql, "contents: read");
requireText("CodeQL", codeql, "security-events: write");
requireText("CodeQL", codeql, "languages: javascript-typescript");
requireText("CodeQL", codeql, "build-mode: none");
requireText("CodeQL", codeql, "queries: security-extended");

const sbom = contents.get("SBOM");
requireText("SBOM", sbom, "contents: read");
requireOnlyTopLevelPermissions("SBOM", sbom, ["contents:read"]);
requireText("SBOM", sbom, "pnpm run sbom:check");
requireText("SBOM", sbom, "pnpm run sbom:generate -- --out \"$RUNNER_TEMP/shellx-motion.cdx.json\"");
requireText("SBOM", sbom, "if-no-files-found: error");
requireText("SBOM", sbom, "include-hidden-files: false");
requireText("SBOM", sbom, "retention-days: 14");
forbidText("SBOM", sbom, "pnpm install");

const dependabot = readFileSync(resolve(root, ".github/dependabot.yml"), "utf8");
requireText("Dependabot", dependabot, "package-ecosystem: npm");
requireText("Dependabot", dependabot, "package-ecosystem: github-actions");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PASS CI workflow contract: ${workflows.size} workflows and Dependabot are pinned and scoped`);
}
