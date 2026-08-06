interface MotionEnvironmentExtensionFields {
  [key: `x-${string}`]: unknown;
}

export type MotionEnvironmentQuality = "preview" | "balanced" | "cinematic";

export interface MotionRainGround {
  horizon: number;
  wetness: number;
  roughness: number;
  rippleAmount: number;
  splashAmount: number;
  reflectionStrength: number;
}

export interface MotionRainAtmosphere { mist: number; lensDroplets: number }

export interface MotionWaterSurface {
  horizon: number;
  waveScale: number;
  waveHeight: number;
  waveSpeed: number;
  direction: number;
  choppiness: number;
  waveOctaves: number;
}

export interface MotionWaterOptics {
  reflectionStrength: number;
  refractionStrength: number;
  fresnel: number;
  caustics: number;
  clarity: number;
  foam: number;
}

export interface MotionSnowFall {
  intensity: number;
  speed: number;
  wind: number;
  turbulence: number;
  flakeSize: number;
  depthLayers: number;
  focusFalloff: number;
}

export interface MotionSnowGround { horizon: number; accumulation: number; drift: number; contactAmount: number }
export interface MotionSnowAtmosphere { haze: number; depthFade: number }

interface MotionEnvironmentBase extends MotionEnvironmentExtensionFields {
  schema: "shellx-motion/environment@1";
  seed: number;
  quality: MotionEnvironmentQuality;
  mode: "scene" | "overlay";
  sceneSourceLayerId?: string;
  effectMaskLayerId?: string;
}

export interface MotionRainEnvironment extends MotionEnvironmentBase {
  kind: "rain";
  intensity: number;
  wind: number;
  dropSpeed: number;
  dropLength: number;
  depthLayers: number;
  color: string;
  backgroundColor: string;
  lightColor: string;
  accentColor: string;
  ground: MotionRainGround;
  atmosphere: MotionRainAtmosphere;
}

export interface MotionWaterEnvironment extends MotionEnvironmentBase {
  kind: "water";
  backgroundColor: string;
  shallowColor: string;
  deepColor: string;
  reflectionColor: string;
  foamColor: string;
  surface: MotionWaterSurface;
  optics: MotionWaterOptics;
}

export interface MotionSnowEnvironment extends MotionEnvironmentBase {
  kind: "snow";
  backgroundColor: string;
  snowColor: string;
  shadowColor: string;
  lightColor: string;
  fall: MotionSnowFall;
  ground: MotionSnowGround;
  atmosphere: MotionSnowAtmosphere;
}

export interface MotionFogParameters {
  density: number;
  speed: number;
  scale: number;
  turbulence: number;
  height: number;
  depthLayers: number;
  lightStrength: number;
}

export interface MotionFogEnvironment extends MotionEnvironmentBase {
  kind: "fog";
  backgroundColor: string;
  fogColor: string;
  lightColor: string;
  fog: MotionFogParameters;
}

export type MotionEnvironment = MotionRainEnvironment | MotionWaterEnvironment | MotionSnowEnvironment | MotionFogEnvironment;
