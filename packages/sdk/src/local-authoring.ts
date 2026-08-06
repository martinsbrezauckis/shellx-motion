import type { MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugContext, MotionDebugResult } from "@shellx-motion/debug-api";
import { createLocalCompositingOperations } from "./local-compositing.js";
import { createLocalGltfOperations } from "./local-gltf.js";
import { createLocalKeyingOperations } from "./local-keying.js";
import { createLocalProceduralOperations } from "./local-procedural.js";
import type { MotionSdkPackageIdentity } from "./types.js";

interface LocalAuthoringRuntime {
  executeDebug(
    command: MotionDebugCommand,
    args: Record<string, unknown>,
    tier: MotionDebugContext["tier"],
  ): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

/** Compose modular authoring domains without growing the legacy local transport. */
export function createLocalAuthoringOperations(runtime: LocalAuthoringRuntime) {
  return {
    keying: createLocalKeyingOperations(runtime),
    compositing: createLocalCompositingOperations(runtime),
    gltf: createLocalGltfOperations(runtime),
    procedural: createLocalProceduralOperations(runtime),
  };
}
