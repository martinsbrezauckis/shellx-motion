/**
 * Opt in to Debug's blocking v2 content-bound artifact reuse. It has no caller cache root or key;
 * omit legacy artifactRoot/idempotencyKey when true. Those remain ordinary-path compatibility only.
 */
export type MotionSdkAttestedReuse = boolean;

/**
 * A completed GPU result may expose this versioned, path-free identity after the local host has
 * verified its persisted passed receipt and retained artifact. It is evidence only: GPU cache
 * planning and `reuseAttested` remain refused because those routes run before execution evidence
 * exists.
 */
export interface MotionSdkGpuPostRenderReuseIdentity {
  schema: "shellx-motion/gpu-post-render-reuse-identity@1";
  mode: "post-render-only";
  source: { receiptId: string; receiptSha256: string };
  artifact: { sha256: string; byteLength: number; authoritySha256: string };
  loadedInputsSha256: string;
  staticScene: {
    pipelineCatalogSha256: string;
    staticPlanFingerprint: string;
    documentFingerprint: string;
    resourceReferencesSha256: string;
    staticSceneSha256: string;
    resourceBudgetSha256: string;
  };
  frameTransport: { transportSha256: string; frameSequenceSha256: string; framePlanSequenceSha256: string };
  runtime: { adapterFingerprint: string; runtimeProfileSha256: string; sessionResourcesSha256: string; containmentProfileSha256: string };
  video: { stagingLedgerSha256: string; pcmSha256: string } | null;
  quality: { closureSha256: string; exactSourceInputsSha256: string | null };
  identitySha256: string;
}
