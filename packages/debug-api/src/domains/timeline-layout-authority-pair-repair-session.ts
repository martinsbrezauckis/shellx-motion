/** Opaque cross-process repair-gate admission for the trusted embedding host. */
import {
  assertCurrentAuthorityDirectory,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  acquirePairRepairGate,
  assertPairRepairGate,
  readQuiescentPairRepairGate,
  releasePairRepairGate,
  type PairRepairGate,
} from "./timeline-layout-authority-pair-files.js";
import type { HostQuiescentPairRecoveryAdmission } from "./timeline-layout-authority-pair-types.js";

const admissions = new WeakMap<HostQuiescentPairRecoveryAdmission, {
  directory: TrustedAuthorityDirectory;
  gate: PairRepairGate;
}>();
const activeDirectories = new Set<string>();

export async function runHostQuiescentPairRecovery<T>(
  directory: TrustedAuthorityDirectory,
  repair: (admission: HostQuiescentPairRecoveryAdmission) => Promise<T>,
): Promise<T> {
  return await runHostRepair(directory, repair, false);
}

/**
 * Explicit crash-restart admission. A trusted embedding host may choose this only after proving
 * externally that every other repair process sharing the root is stopped; normal repair never
 * reclaims an existing root gate because that gate may still belong to a live process.
 */
export async function runHostQuiescentPairRecoveryAfterCrash<T>(
  directory: TrustedAuthorityDirectory,
  repair: (admission: HostQuiescentPairRecoveryAdmission) => Promise<T>,
): Promise<T> {
  return await runHostRepair(directory, repair, true);
}

async function runHostRepair<T>(
  directory: TrustedAuthorityDirectory,
  repair: (admission: HostQuiescentPairRecoveryAdmission) => Promise<T>,
  allowCrashGateTakeover: boolean,
): Promise<T> {
  await assertCurrentAuthorityDirectory(directory);
  if (activeDirectories.has(directory.path)) {
    throw new Error("Layout authority host repair is already active in this process.");
  }
  // Add before the first await: JavaScript turn atomicity makes this a per-root mutex covering
  // gate acquisition/takeover through release, while a concurrent contender fails rather than
  // queuing behind a repair it cannot independently prove quiescent.
  activeDirectories.add(directory.path);
  let gate: PairRepairGate;
  try {
    gate = await acquirePairRepairGate(directory);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !/host repair is already active/i.test(error.message)) {
      activeDirectories.delete(directory.path);
      throw error;
    }
    if (!allowCrashGateTakeover) {
      activeDirectories.delete(directory.path);
      throw error;
    }
    try {
      gate = await readQuiescentPairRepairGate(directory);
    } catch (takeoverError) {
      activeDirectories.delete(directory.path);
      throw takeoverError;
    }
  }
  const admission = Object.freeze({ kind: "host-operator-quiescent" as const });
  admissions.set(admission, { directory, gate });
  try {
    return await repair(admission);
  } finally {
    admissions.delete(admission);
    activeDirectories.delete(directory.path);
    await releasePairRepairGate(directory, gate);
  }
}

export async function assertHostQuiescentPairRecoveryAdmission(
  directory: TrustedAuthorityDirectory,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<void> {
  const state = admissions.get(admission);
  if (!state || state.directory.path !== directory.path
    || state.directory.root.path !== directory.root.path
    || state.directory.root.dev !== directory.root.dev
    || state.directory.root.ino !== directory.root.ino) {
    throw new Error("Layout authority pair recovery requires host operator quiescence admission.");
  }
  await assertPairRepairGate(directory, state.gate);
}
