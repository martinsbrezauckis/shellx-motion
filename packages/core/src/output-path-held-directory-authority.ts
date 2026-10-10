/** Opaque, process-local descriptor authority for the V1 retained-output lane. */
import type { Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";

type HeldDirectoryState = Readonly<{
  rootPath: string;
  bindingRootPath: string;
  assertCurrent(): Promise<void>;
  readFacts(): Promise<Stats>;
  syncParent(): Promise<void>;
}>;

export interface HeldOutputDirectoryAuthority { readonly __heldOutputDirectoryAuthority?: never; }

const states = new WeakMap<object, HeldDirectoryState>();

export function createHeldOutputDirectoryAuthority(state: HeldDirectoryState): HeldOutputDirectoryAuthority {
  const authority = Object.freeze({}) as HeldOutputDirectoryAuthority;
  states.set(authority, state);
  return authority;
}

export function heldOutputDirectoryState(value: unknown): HeldDirectoryState | undefined {
  return value && typeof value === "object" ? states.get(value) : undefined;
}

export function heldOutputDirectoryAllowsPath(value: unknown, path: string): boolean {
  const state = heldOutputDirectoryState(value);
  if (!state) return false;
  const relation = relative(state.rootPath, resolve(path));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

export function heldOutputDirectoryChildPath(value: unknown, name: string): string {
  const state = heldOutputDirectoryState(value);
  if (!state || (name !== "." && (!/^[a-z0-9][a-z0-9.-]{0,191}$/u.test(name) || name.includes("..")))) {
    throw new Error("Held output directory authority cannot resolve that direct child.");
  }
  return `${state.rootPath}/${name}`;
}

export function heldOutputDirectoryBindingPath(value: unknown, name: string): string {
  const state = heldOutputDirectoryState(value);
  if (!state || !/^[a-z0-9][a-z0-9.-]{0,191}$/u.test(name) || name.includes("..")) throw new Error("Held output directory authority cannot bind that direct child.");
  return `${state.bindingRootPath}/${name}`;
}
