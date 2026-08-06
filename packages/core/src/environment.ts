export const ENVIRONMENT_SCHEMA = "shellx-motion/environment@1" as const;
export const ENVIRONMENT_KINDS = ["rain", "water", "snow", "fog"] as const;
export const ENVIRONMENT_QUALITY_TIERS = ["preview", "balanced", "cinematic"] as const;
export const MAX_ENVIRONMENT_LAYERS = 4;
export const MAX_RAIN_DEPTH_LAYERS = 4;
export const MAX_WATER_WAVE_OCTAVES = 4;
export const MAX_SNOW_DEPTH_LAYERS = 4;
export const MAX_FOG_DEPTH_LAYERS = 4;

export type MotionEnvironmentKind = typeof ENVIRONMENT_KINDS[number];
