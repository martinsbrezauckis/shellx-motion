import { appendFileSync } from "node:fs";

const [outcome, logPath, label] = process.argv.slice(2);

if (!outcome || !logPath || !label) {
  process.stderr.write("fixture requires outcome, log path, and label\n");
  process.exitCode = 64;
} else {
  appendFileSync(logPath, `${label}\n`, "utf8");
  process.exitCode = outcome === "pass" ? 0 : outcome === "fail" ? 23 : 64;
}
