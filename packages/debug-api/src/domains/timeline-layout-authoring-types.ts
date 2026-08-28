/** Internal mutation evidence for package-backed static layout commands. */
import type {
  MotionDocument,
  MotionLayoutDebugCompilation,
  MotionLayoutDebugRemoval,
} from "@shellx-motion/core";

export interface LayoutMutation {
  motion: MotionDocument;
  operation: "apply" | "remove";
  compilation: MotionLayoutDebugCompilation;
  removal: MotionLayoutDebugRemoval;
  application: LayoutApplicationFacts;
  outputMotionSha256: string;
  changedLayerIds: string[];
  receiptWarnings: string[];
  revertedAppliedFingerprint?: string;
}

export interface LayoutApplicationFacts {
  disposition: "applied" | "removed";
  id: string;
  fingerprint: string;
  groupId: string;
  sourceChildLayerIds: string[];
  materializedChildLayerIds: string[];
  generatedLayerIds: string[];
  trackOrders: Array<{ trackId: string; beforeLayerIds: string[]; afterLayerIds: string[] }>;
}
