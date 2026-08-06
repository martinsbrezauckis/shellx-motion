/** Headless Player controller that accepts only attested Motion artifact identities. */
import type { MotionSdkArtifactIdentity } from "./types";

export interface MotionPlayerSource {
  schema: "shellx-motion/player-source@1";
  uri: string;
  durationMs: number;
  artifact: MotionSdkArtifactIdentity;
}

export interface MotionPlayerMediaPort {
  load(source: { uri: string; mediaType: string; durationMs: number }): void | Promise<void>;
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  seek(timeMs: number): void | Promise<void>;
  unload(): void | Promise<void>;
}

export interface MotionPlayerState {
  status: "empty" | "ready" | "playing" | "paused" | "ended" | "disposed";
  source: MotionPlayerSource | null;
  currentTimeMs: number;
  durationMs: number;
}

export interface MotionPlayer {
  load(source: MotionPlayerSource): Promise<MotionPlayerState>;
  play(): Promise<MotionPlayerState>;
  pause(): Promise<MotionPlayerState>;
  seek(timeMs: number): Promise<MotionPlayerState>;
  sync(input: { currentTimeMs: number; playing?: boolean; ended?: boolean }): MotionPlayerState;
  snapshot(): MotionPlayerState;
  subscribe(listener: (state: MotionPlayerState) => void): () => void;
  dispose(): Promise<void>;
}

export function createMotionPlayer(port: MotionPlayerMediaPort): MotionPlayer {
  let state: MotionPlayerState = { status: "empty", source: null, currentTimeMs: 0, durationMs: 0 };
  const listeners = new Set<(state: MotionPlayerState) => void>();
  const publish = (next: MotionPlayerState): MotionPlayerState => {
    state = structuredClone(next);
    for (const listener of listeners) listener(structuredClone(state));
    return structuredClone(state);
  };
  const requireReady = (): MotionPlayerSource => {
    if (state.status === "disposed") throw new Error("Motion Player is disposed.");
    if (!state.source) throw new Error("Motion Player has no source.");
    return state.source;
  };
  return {
    async load(source) {
      validateSource(source);
      if (state.status === "disposed") throw new Error("Motion Player is disposed.");
      if (state.source) {
        await port.unload();
        publish({ status: "empty", source: null, currentTimeMs: 0, durationMs: 0 });
      }
      await port.load({ uri: source.uri, mediaType: source.artifact.mediaType, durationMs: source.durationMs });
      return publish({ status: "ready", source: structuredClone(source), currentTimeMs: 0, durationMs: source.durationMs });
    },
    async play() {
      requireReady();
      await port.play();
      return publish({ ...state, status: "playing" });
    },
    async pause() {
      requireReady();
      await port.pause();
      return publish({ ...state, status: "paused" });
    },
    async seek(timeMs) {
      requireReady();
      if (!Number.isFinite(timeMs)) throw new TypeError("Motion Player seek time must be finite.");
      const clamped = Math.max(0, Math.min(state.durationMs, timeMs));
      await port.seek(clamped);
      return publish({ ...state, currentTimeMs: clamped, status: clamped === state.durationMs ? "ended" : state.status === "ended" ? "paused" : state.status });
    },
    sync(input) {
      requireReady();
      if (!Number.isFinite(input.currentTimeMs)) throw new TypeError("Motion Player current time must be finite.");
      const currentTimeMs = Math.max(0, Math.min(state.durationMs, input.currentTimeMs));
      const status = input.ended || currentTimeMs === state.durationMs ? "ended" : input.playing === true ? "playing" : input.playing === false ? "paused" : state.status;
      return publish({ ...state, currentTimeMs, status });
    },
    snapshot: () => structuredClone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      try {
        if (state.status !== "disposed") await port.unload();
      } finally {
        publish({ status: "disposed", source: null, currentTimeMs: 0, durationMs: 0 });
        listeners.clear();
      }
    }
  };
}

function validateSource(source: MotionPlayerSource): void {
  if (source.schema !== "shellx-motion/player-source@1") throw new TypeError("Unsupported Motion Player source schema.");
  if (!/^https?:\/\//.test(source.uri) && !source.uri.startsWith("blob:")) throw new TypeError("Motion Player source URI must be HTTP(S) or blob-backed.");
  if (/^https?:\/\//.test(source.uri)) {
    const url = new URL(source.uri);
    if (url.username || url.password) throw new TypeError("Motion Player source URI must not contain credentials.");
  }
  if (!Number.isFinite(source.durationMs) || source.durationMs <= 0) throw new TypeError("Motion Player duration must be positive.");
  const artifact = source.artifact;
  if (artifact.schema !== "shellx-motion/artifact-handle@1" || !artifact.id || !artifact.packageId || !artifact.motionId
    || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^[a-f0-9]{64}$/.test(artifact.operationHash)
    || !Number.isFinite(artifact.byteLength) || artifact.byteLength <= 0 || !artifact.mediaType || !artifact.preset
    || !Number.isFinite(Date.parse(artifact.createdAt))) {
    throw new TypeError("Motion Player source requires a valid attested artifact identity.");
  }
}
