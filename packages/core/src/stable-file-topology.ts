import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import {
  assertOutputDirectoryIdentity,
  captureOutputDirectoryIdentity,
  OutputPathTopology,
  OutputPathTopologyError,
  type OutputPathIdentity,
} from "./output-path-topology";

/** Retains the authority-bearing root/route for one stable file operation. */
export class StableFileRootTopology {
  private constructor(
    readonly rootPath: string,
    private readonly rootIdentity: OutputPathIdentity,
    private readonly rootRequiresChildWrite: boolean,
    private readonly route: OutputPathTopology,
    private readonly label: string
  ) {}

  static async acquire(
    path: string,
    withinRoot: string | undefined,
    label: string,
    options: { createParents: boolean; allowRootAlias?: boolean }
  ): Promise<StableFileRootTopology> {
    const lexicalPath = resolve(path);
    const requestedRootPath = resolve(withinRoot ?? parse(lexicalPath).root);
    if (!inside(requestedRootPath, lexicalPath)) throw new Error(`${label} escapes its approved root`);

    const rootPath = !options.createParents && options.allowRootAlias
      ? await realpath(requestedRootPath)
      : requestedRootPath;
    const routePath = !options.createParents && options.allowRootAlias
      ? resolve(rootPath, relative(requestedRootPath, lexicalPath))
      : lexicalPath;
    if (!inside(rootPath, routePath)) throw new Error(`${label} escapes its approved root`);

    const rootRequiresChildWrite = dirname(routePath) === rootPath;
    let route: OutputPathTopology;
    let rootIdentity: OutputPathIdentity;
    try {
      route = options.createParents
        ? await OutputPathTopology.acquire(routePath)
        : await OutputPathTopology.inspect(routePath);
      rootIdentity = await captureOutputDirectoryIdentity(rootPath, `${label} approved root`, {
        requiresChildWrite: rootRequiresChildWrite
      });
    } catch (error) {
      rethrowStableTopologyRefusal(error, rootPath, label);
    }
    const topology = new StableFileRootTopology(rootPath, rootIdentity, rootRequiresChildWrite, route, label);
    await topology.assertCurrent();
    return topology;
  }

  async assertCurrent(): Promise<void> {
    await this.route.assertCurrent();
    await assertOutputDirectoryIdentity(this.rootPath, this.rootIdentity, `${this.label} approved root`, {
      requiresChildWrite: this.rootRequiresChildWrite
    });
  }
}

function rethrowStableTopologyRefusal(error: unknown, rootPath: string, label: string): never {
  if (error instanceof OutputPathTopologyError && error.message === "Output parent must be a canonical non-symlink directory.") {
    const component = error.path === rootPath ? "root" : "parent";
    throw new Error(`${label} has a symlinked or non-directory ${component}: ${error.path}`);
  }
  throw error;
}

function inside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}
