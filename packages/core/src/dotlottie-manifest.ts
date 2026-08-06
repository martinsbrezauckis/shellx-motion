import { parseBoundedJsonObject, readDotLottieRecord } from "./dotlottie-json";
import type {
  DotLottieManifestAnimation,
  DotLottieManifestInventory,
  DotLottieManifestResource,
  DotLottieSelection
} from "./dotlottie-types";

export interface ParsedDotLottieManifest {
  version: "1" | "2";
  raw: Record<string, unknown>;
  inventory: DotLottieManifestInventory;
  defaultAnimationId?: string;
  initialStateMachineId?: string;
}

export function parseDotLottieManifest(text: string): ParsedDotLottieManifest {
  const raw = parseBoundedJsonObject(text, "dotLottie manifest");
  if (raw.version !== "1" && raw.version !== "2") throw new Error("dotLottie manifest version must be 1 or 2.");
  if (!Array.isArray(raw.animations) || raw.animations.length === 0 || raw.animations.length > 256) {
    throw new Error("dotLottie manifest requires 1 to 256 animations.");
  }
  const themes = raw.version === "2" ? parseResources(raw.themes, "theme") : [];
  const stateMachines = raw.version === "2" ? parseResources(raw.stateMachines, "state machine") : [];
  const animations = parseAnimations(raw.animations, themes);
  const initial = readDotLottieRecord(raw.initial);
  const defaultAnimationId = raw.version === "2" ? optionalId(initial?.animation, "initial animation") : optionalId(raw.activeAnimationId, "default animation");
  const initialStateMachineId = raw.version === "2" ? optionalId(initial?.stateMachine, "initial state machine") : undefined;
  if (defaultAnimationId && !animations.some((item) => item.id === defaultAnimationId)) {
    throw new Error("dotLottie manifest default animation must reference an animation id.");
  }
  if (initialStateMachineId && !stateMachines.some((item) => item.id === initialStateMachineId)) {
    throw new Error("dotLottie manifest initial state machine must reference a state machine id.");
  }
  const inventory: DotLottieManifestInventory = {
    animations,
    themes,
    stateMachines,
    ...(defaultAnimationId || initialStateMachineId
      ? { initial: {
          ...(defaultAnimationId ? { animation: defaultAnimationId } : {}),
          ...(initialStateMachineId ? { stateMachine: initialStateMachineId } : {})
        } }
      : {})
  };
  return {
    version: raw.version,
    raw,
    inventory,
    ...(defaultAnimationId ? { defaultAnimationId } : {}),
    ...(initialStateMachineId ? { initialStateMachineId } : {})
  };
}

export function selectDotLottieAnimationId(
  manifest: ParsedDotLottieManifest,
  explicitId: string | undefined
): { id: string; source: DotLottieSelection["selectionSource"] } {
  if (explicitId !== undefined) {
    if (!manifest.inventory.animations.some((item) => item.id === explicitId)) {
      throw new Error(`dotLottie animation selection ${explicitId} is not declared in the manifest.`);
    }
    return { id: explicitId, source: "explicit" };
  }
  if (manifest.defaultAnimationId) return { id: manifest.defaultAnimationId, source: "manifest-default" };
  if (manifest.initialStateMachineId) {
    throw new Error(`dotLottie initial state machine ${manifest.initialStateMachineId} requires an explicit animationId for deterministic video import.`);
  }
  if (manifest.inventory.animations.length === 1) return { id: manifest.inventory.animations[0].id, source: "single-animation" };
  if (manifest.version === "2") return { id: manifest.inventory.animations[0].id, source: "manifest-first" };
  throw new Error("dotLottie v1 archives with multiple animations require an explicit animationId or manifest default.");
}

function parseAnimations(values: unknown[], resources: DotLottieManifestResource[]): DotLottieManifestAnimation[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const animation = readDotLottieRecord(value);
    const id = requiredId(animation?.id, `animation ${index}`);
    assertUniqueId(id, seen, "animation");
    const initialTheme = optionalId(animation?.initialTheme, `animation ${id} initialTheme`);
    const themes = parseThemeScope(animation?.themes, id);
    for (const themeId of [...themes, ...(initialTheme ? [initialTheme] : [])]) {
      if (!resources.some((resource) => resource.id === themeId)) {
        throw new Error(`dotLottie manifest animation ${id} references undeclared theme ${themeId}.`);
      }
    }
    if (initialTheme && themes.length > 0 && !themes.includes(initialTheme)) {
      throw new Error(`dotLottie manifest animation ${id} initialTheme must be included in its themes list.`);
    }
    const background = animation?.background;
    if (background !== undefined && (!Number.isInteger(background) || Number(background) < 0 || Number(background) > 0xffffffff)) {
      throw new Error(`dotLottie manifest animation ${id} background must be a u32 RGBA value.`);
    }
    return {
      id,
      ...(initialTheme ? { initialTheme } : {}),
      ...(background !== undefined ? { background: Number(background) } : {}),
      ...(themes.length > 0 ? { themes } : {})
    };
  });
}

function parseResources(value: unknown, label: "theme" | "state machine"): DotLottieManifestResource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error(`dotLottie manifest ${label}s must be an array of at most 256 entries.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const resource = readDotLottieRecord(item);
    const id = requiredId(resource?.id, `${label} ${index}`);
    assertUniqueId(id, seen, label);
    const name = resource?.name;
    if (name !== undefined && (typeof name !== "string" || name.length > 256)) {
      throw new Error(`dotLottie manifest ${label} ${id} name must be a string no longer than 256 characters.`);
    }
    return { id, ...(typeof name === "string" ? { name } : {}) };
  });
}

function parseThemeScope(value: unknown, animationId: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error(`dotLottie manifest animation ${animationId} themes must be an array.`);
  const themes = value.map((item, index) => requiredId(item, `animation ${animationId} theme ${index}`));
  if (new Set(themes).size !== themes.length) throw new Error(`dotLottie manifest animation ${animationId} contains duplicate theme ids.`);
  return themes;
}

function optionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredId(value, label);
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || value.trim() !== value || !/^[A-Za-z0-9._ -]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`dotLottie manifest ${label} has an unsafe id.`);
  }
  return value;
}

function assertUniqueId(id: string, seen: Set<string>, label: string): void {
  const duplicate = id.normalize("NFC").toLocaleLowerCase("en-US");
  if (seen.has(duplicate)) throw new Error(`dotLottie manifest contains duplicate ${label} id ${id}.`);
  seen.add(duplicate);
}
