#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePrivateRepoScratch } from "./repo-scratch.mjs";

await preparePrivateRepoScratch(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
