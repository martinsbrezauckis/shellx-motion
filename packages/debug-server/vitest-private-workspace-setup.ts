import { afterAll } from "vitest";

// Private Debug Server fixtures intentionally create trusted host-workspace anchors.
// Keep their implicit POSIX descendants private under ordinary developer umasks;
// topology-negative cases request unsafe modes explicitly.
const inheritedUmask = process.platform === "win32" ? undefined : process.umask(0o077);

afterAll(() => {
  if (inheritedUmask !== undefined) process.umask(inheritedUmask);
});
