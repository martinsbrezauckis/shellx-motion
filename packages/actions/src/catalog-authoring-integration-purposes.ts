/**
 * Reviewed purposes for existing authoring and integration Debug/MCP commands.
 *
 * These are purpose descriptions only. They neither add Action entries nor broaden
 * CLI, connector, browser, renderer, or host authority.
 */
export const AUTHORING_INTEGRATION_PURPOSES: Readonly<Record<string, string>> = {
  "motion.keying.inspect": "Inspect one image or video layer's current chroma-key and roto-mask state without mutating the package.",
  "motion.keying.apply": "Apply bounded chroma-key and matte-cleanup controls to one image or video layer in a copy-on-write package, emitting a keying receipt.",
  "motion.keying.remove": "Remove one image or video layer's chroma-key controls in a copy-on-write package, emitting a keying receipt.",
  "motion.roto.upsert": "Upsert one bounded animated roto mask, including an optional tracking attachment, on an image or video layer in a copy-on-write package and emit a keying receipt.",
  "motion.roto.tracking.detach": "Detach a roto mask's tracking attachment while retaining the mask in a copy-on-write package and emit a keying receipt.",
  "motion.roto.remove": "Remove one image or video layer's roto mask in a copy-on-write package and emit a keying receipt.",
  "motion.compositing.graph.inspect": "Inspect the current data-only compositing graph, validation, deterministic fingerprint, and compile metadata without mutating the package.",
  "motion.compositing.graph.set": "Validate and compile one versioned acyclic data-only compositing graph into a copy-on-write package, retaining hidden round-trip source layers and emitting a graph receipt.",
  "motion.compositing.graph.remove": "Remove generated compositing output, restore source-layer visibility in a copy-on-write package, and emit a graph receipt.",
  "motion.procedural.inspect": "Inspect typed data-only scalar relationships and optionally evaluate their readable outputs at one timeline time without mutating the package.",
  "motion.procedural.relationship.set": "Set one data-only typed scalar relationship in a copy-on-write package; executable expressions are refused, and a relationship receipt is emitted.",
  "motion.procedural.relationship.enabled.set": "Enable or disable one typed scalar relationship in a copy-on-write package and emit a relationship receipt.",
  "motion.procedural.relationship.bake": "Bake selected enabled typed scalar relationships into ordinary keyframes in a copy-on-write package, with bounded samples and a relationship receipt.",
  "motion.procedural.relationship.detach": "Detach one typed scalar relationship without baking it in a copy-on-write package and emit a relationship receipt.",
  "motion.timeline.cutout.rig.bake": "Bake a bounded shellx-motion/cutout-rig@1 plan for one static PNG into flat image layers and sampled transform keyframes in a copy-on-write package, with a bake receipt; it is not a live rig.",
  "motion.scene3d.gltf.import": "Create a Motion package from a host-approved local .gltf or .glb within host-approved input and output roots, lowering only the bounded static glTF 2.0 subset with source and adapter-lowering receipts.",
  "motion.template.plan": "Read a compatible template plan for a request, declared controls or media slots, authoring loop, input readiness, and quality targets without applying values or rendering.",
  "motion.connector.catalog": "Return the canonical v2 connector catalog with immutable descriptor fingerprints and closed submit-preparation fields without reading a package, provider/authentication state, network, output, or host authority.",
  "motion.connector.submit": "Submit one exact discovered connector descriptor and closed request through the host's stable authenticated caller, caller-scoped opaque-reference authority, and immutable binding journal; filesystem paths and URLs are refused and a durable coordinator job is returned.",
  "motion.browser.workflow.capture": "Capture a package through deterministic browser workflow replay, writing a frame, receipt, and optional trace, catalog, or recording evidence only inside host-approved output roots; recording is capped at 240 rendered samples.",
};
