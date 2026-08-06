import type { MotionAction } from "./catalog.js";

export const SCENE3D_ACTIONS: MotionAction[] = [{
  id: "motion.scene3d.gltf.import",
  aliases: [
    "import gltf model",
    "import glb model",
    "create motion package from 3d model",
    "add static 3d mesh",
    "render gltf in canvas",
    "send gltf render to cut",
  ],
  permission: "write_local",
  mutates: true,
  calls: [
    "motion.scene3d.gltf.import",
    "motion.capabilities.match",
    "motion.preview.frame",
    "motion.receipts.read",
  ],
  verify: [
    "Import preserves the original source, denies network and external buffers, lowers bounded static triangles, and emits provenance receipts.",
    "Preview verifies actual WebGL mesh pixels and resource evidence before Canvas editing or a rendered-media Cut handoff.",
  ],
  surfaces: ["scene3d", "prompt", "preview", "receipts", "canvas", "cut"],
}];
