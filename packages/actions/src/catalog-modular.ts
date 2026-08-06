/** Compose bounded feature catalogs without growing the legacy registry. */
import { COMPOSITING_ACTIONS } from "./catalog-compositing.js";
import { MEDIA_EFFECT_ACTIONS } from "./catalog-media-effects.js";
import { PROCEDURAL_ACTIONS } from "./catalog-procedural.js";
import { SCENE3D_ACTIONS } from "./catalog-scene3d.js";

export const MODULAR_ACTIONS = [
  ...MEDIA_EFFECT_ACTIONS,
  ...COMPOSITING_ACTIONS,
  ...PROCEDURAL_ACTIONS,
  ...SCENE3D_ACTIONS,
];
