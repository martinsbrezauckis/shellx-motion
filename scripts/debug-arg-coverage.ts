/**
 * scripts/debug-arg-coverage.ts — every argument a debug handler READS must be DECLARED.
 *
 * ROLE
 * ----
 * `mcp-args-validation.ts` enforces `contract.argsSchema` literally, and every schema that sets
 * `additionalProperties: false` therefore REJECTS any argument it does not name. That turns an
 * omission in the published schema into a rejected-but-valid call: `motion.export.plan` honours
 * `out` as a synonym for `outputPath`, but until this gate existed the schema never said so, and
 * MCP `tools/call` answered "argument out is not declared by this command" for a call the raw
 * transport ran happily.
 *
 * Hand-listing the omissions fixes today's set and nothing else. What actually prevents recurrence
 * is a mechanical cross-check between the two artefacts that must agree:
 *
 *   what the HANDLERS read   (this file derives it, statically, from the domain sources)
 *   what the SCHEMAS declare (`DEBUG_COMMAND_CONTRACTS[].argsSchema`)
 *
 * Any read name that no schema property or alias covers is a failure. A new command whose handler
 * reads `foo` without declaring `foo` cannot reach a release.
 *
 * HOW THE READ SET IS DERIVED
 * ---------------------------
 * Raw `args` only ever enters the engine through `packages/debug-api/src/domains/**`; everything
 * deeper receives parsed values. So the analysis scope is exactly that directory.
 *
 *  1. Parse every non-test domain module and index its functions by name (declarations, and
 *     arrow/function expressions bound to a `const`). Relative imports are resolved by path, so a
 *     helper called across modules is followed.
 *  2. Find the argument-reader helpers by FIXPOINT rather than from a hard-coded list, so a new
 *     helper in any domain module is picked up automatically. A function reads its parameter `j` as
 *     a key on its parameter `i` when the body does `Object.hasOwn(p_i, p_j)` / `p_i[p_j]`, or
 *     forwards that pair to another known reader. `stringArg(args, key)` is discovered this way —
 *     it is not named anywhere in this file.
 *  3. Propagate "args-ness" only through identity and `objectArg(...)`. It deliberately does NOT
 *     propagate through an indexed read: `recordArg(args, "keying")` yields a NESTED object, and
 *     the fields read off that nested object (`keying.mode`) are not top-level arguments.
 *  4. Attribute the resulting literals to commands by walking each dispatcher and tracking which
 *     `command === "..."` branch each read sits under — including `if (command !== "a" && command
 *     !== "b") return null;` narrowing, and sub-dispatchers that forward `command` onward.
 *  5. Specialise a shared handler by the string literals its caller passes. `authoring-keying.ts`
 *     routes six commands into one `mutate(command, args, services, "roto.upsert")`, and only the
 *     `roto.*` operations read `mask`. Without this, `mask` would be attributed to every keying
 *     command and the fix would be to declare arguments those commands ignore — trading a contract
 *     that under-declares for one that over-declares.
 *
 * DELIBERATE CONSERVATISM: a read the analyser cannot attribute to a specific command is reported
 * as an `unattributed` failure rather than dropped. Silent under-reporting would make a green gate
 * meaningless, which is the exact failure mode this file exists to prevent.
 *
 * USAGE
 *   tsx scripts/debug-arg-coverage.ts            # gate: exit 1 on any undeclared read
 *   tsx scripts/debug-arg-coverage.ts --report   # also list declared-but-never-read properties
 *
 * WIRING: `pnpm run args:check`, part of `pnpm test`. Parse only — no build, no network.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DEBUG_COMMAND_CONTRACTS } from "../packages/debug-api/src/command-metadata.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOMAINS_DIR = join(ROOT, "packages/debug-api/src/domains");

/**
 * Argument names read off `args` that can never arrive from a caller, with the reason each is exempt.
 *
 * Keep this list short and justified — every entry is a place the mechanical proof stops.
 */
const NON_ARGUMENT_READS = new Map<string, string>([]);

interface FunctionFacts {
  /** Stable key: `<absolute file>#<function name>`. */
  id: string;
  file: string;
  name: string;
  parameterNames: string[];
  node: ts.FunctionLikeDeclaration;
  /** `"<argsParameterIndex>:<keyParameterIndex>"` pairs — this function is itself a reader helper. */
  readerPairs: Set<string>;
  /**
   * True when this function ROUTES: its first parameter is `command: MotionDebugCommand` (the full
   * union, so it may receive anything) AND its body branches on a command literal.
   *
   * Both halves are load-bearing. `authoring-keying.ts#mutate` takes `command: MotionDebugCommand`
   * purely to name itself in error messages and never branches on it — calling it a dispatcher
   * orphaned its `keying`/`mask` reads. `surface-package-panels.ts#mediaBase` does branch on
   * `command`, but its parameter is the two-member union `"motion.media.panel" |
   * "motion.audio.panel"`: it is a shared handler its dispatcher already narrowed, so its reads
   * belong to the caller's branch, not to a routing pass of its own.
   */
  dispatches: boolean;
}

interface AnalysisContext {
  functions: Map<string, FunctionFacts>;
  imports: Map<string, Map<string, string>>;
  /** Memo for the specialised walk, keyed by function + args parameter + start node + bindings. */
  memo: Map<string, Set<string>>;
}

/** Every `.ts` module under the domains directory that ships (tests excluded). */
function domainSources(): string[] {
  return readdirSync(DOMAINS_DIR)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(DOMAINS_DIR, entry))
    .sort();
}

/** `./authoring-keying.js` written in `fromFile` -> the absolute `.ts` path it means. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return `${resolve(dirname(fromFile), specifier.replace(/\.js$/, ""))}.ts`;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.text;
  }
  return null;
}

function functionBody(node: ts.Node): ts.FunctionLikeDeclaration | null {
  if (ts.isFunctionDeclaration(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer;
  }
  return null;
}

/** Whether a function routes: `command: MotionDebugCommand` first, and a branch on a command literal. */
function routesByCommand(body: ts.FunctionLikeDeclaration): boolean {
  const first = body.parameters[0];
  if (!first || !ts.isIdentifier(first.name) || first.name.text !== "command") return false;
  if (first.type?.getText() !== "MotionDebugCommand") return false;
  return branchesOnCommand(body);
}

/** Whether a body compares `command` against a command literal. */
function branchesOnCommand(body: ts.FunctionLikeDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const left = unwrap(node.left);
      const right = unwrap(node.right);
      if (ts.isIdentifier(left) && left.text === "command" && ts.isStringLiteral(right) && right.text.startsWith("motion.")) found = true;
    }
    ts.forEachChild(node, visit);
  };
  if (body.body) visit(body.body);
  return found;
}

/** Index every top-level function in every domain module, plus each module's import bindings. */
function indexFunctions(files: string[]): { functions: Map<string, FunctionFacts>; imports: Map<string, Map<string, string>> } {
  const functions = new Map<string, FunctionFacts>();
  const imports = new Map<string, Map<string, string>>();

  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const bindings = new Map<string, string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveRelative(file, statement.moduleSpecifier.text);
      const namedBindings = statement.importClause?.namedBindings;
      if (!target || !namedBindings || !ts.isNamedImports(namedBindings)) continue;
      for (const element of namedBindings.elements) {
        bindings.set(element.name.text, `${target}#${element.propertyName?.text ?? element.name.text}`);
      }
    }
    imports.set(file, bindings);

    const declare = (node: ts.Node): void => {
      const name = functionName(node);
      const body = functionBody(node);
      if (!name || !body) return;
      functions.set(`${file}#${name}`, {
        id: `${file}#${name}`,
        file,
        name,
        parameterNames: body.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : ""),
        node: body,
        readerPairs: new Set(),
        dispatches: routesByCommand(body)
      });
    };
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)) declare(statement);
      else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) declare(declaration);
    }
  }
  return { functions, imports };
}

/** The function id a call expression targets, if it is a plain named call this analysis knows. */
function calleeId(call: ts.CallExpression, file: string, context: AnalysisContext): string | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const local = `${file}#${call.expression.text}`;
  if (context.functions.has(local)) return local;
  return context.imports.get(file)?.get(call.expression.text) ?? null;
}

/**
 * Within one function, the local names that hold the args object of parameter `index`.
 *
 * Seeded with the parameter itself and grown through `const x = <argsish>` and
 * `const x = objectArg(<argsish>)`. Indexed reads are NOT included — their result is a nested
 * value, not the argument object.
 */
function argsAliases(fn: FunctionFacts, index: number): Set<string> {
  const aliases = new Set<string>([fn.parameterNames[index]].filter(Boolean));
  if (aliases.size === 0 || !fn.node.body) return aliases;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const isAlias = (ts.isIdentifier(initializer) && aliases.has(initializer.text))
        || (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === "objectArg" && initializer.arguments.length === 1
          && isArgsExpression(initializer.arguments[0], aliases));
      if (isAlias) aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  // Two passes so `const a = args; const b = objectArg(a);` resolves regardless of declaration order.
  visit(fn.node.body);
  visit(fn.node.body);
  return aliases;
}

function isArgsExpression(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrap(node);
  return ts.isIdentifier(expression) && aliases.has(expression.text);
}

/**
 * Discover which `(argsParameter, keyParameter)` pairs each function reads, to a fixpoint.
 *
 * Seeded from direct dynamic reads (`Object.hasOwn(p_i, p_j)`, `p_i[p_j]`) and grown across calls,
 * so `templateValuesArg(args, key)` inherits reader-ness from the `Object.hasOwn` inside it and
 * every wrapper of a wrapper is found without being listed.
 */
function findReaderPairs(context: AnalysisContext): void {
  for (let round = 0; round < 20; round += 1) {
    let changed = false;
    for (const fn of context.functions.values()) {
      if (!fn.node.body) continue;
      const before = fn.readerPairs.size;
      for (let index = 0; index < fn.parameterNames.length; index += 1) {
        const aliases = argsAliases(fn, index);
        if (aliases.size === 0) continue;

        const recordKeyParameter = (key: ts.Expression | undefined): void => {
          if (!key) return;
          const resolved = unwrap(key);
          if (!ts.isIdentifier(resolved)) return;
          const keyIndex = fn.parameterNames.indexOf(resolved.text);
          if (keyIndex >= 0) fn.readerPairs.add(`${index}:${keyIndex}`);
        };

        const visit = (node: ts.Node): void => {
          if (ts.isElementAccessExpression(node) && isArgsExpression(node.expression, aliases)) {
            recordKeyParameter(node.argumentExpression);
          }
          if (ts.isCallExpression(node)) {
            if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "hasOwn"
              && node.arguments.length >= 2 && isArgsExpression(node.arguments[0], aliases)) {
              recordKeyParameter(node.arguments[1]);
            }
            const callee = calleeId(node, fn.file, context);
            const target = callee ? context.functions.get(callee) : null;
            if (target) {
              for (let position = 0; position < node.arguments.length; position += 1) {
                if (!isArgsExpression(node.arguments[position], aliases)) continue;
                for (const pair of target.readerPairs) {
                  const [argsPosition, keyPosition] = pair.split(":").map(Number);
                  if (argsPosition === position) recordKeyParameter(node.arguments[keyPosition]);
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(fn.node.body);
      }
      if (fn.readerPairs.size !== before) changed = true;
    }
    if (!changed) return;
  }
}

/**
 * Evaluate a condition against the string literals bound to this function's parameters, and the
 * local booleans derived from them.
 *
 * `locals` is what makes `const isDotLottie = command === "motion.dotlottie.import";` followed by
 * `isDotLottie ? stringArg(args, "animationId") : undefined` decidable. Without it `animationId`
 * was attributed to `motion.lottie.import`, which does not accept it.
 */
function evaluate(expression: ts.Expression, bindings: Map<number, string>, parameterNames: string[], locals: Map<string, boolean>): boolean | null {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return locals.get(node.text) ?? null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evaluate(node.operand, bindings, parameterNames, locals);
    return inner === null ? null : !inner;
  }
  if (!ts.isBinaryExpression(node)) return null;
  const kind = node.operatorToken.kind;
  if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    const comparison = compareToBinding(node.left, node.right, bindings, parameterNames)
      ?? compareToBinding(node.right, node.left, bindings, parameterNames);
    if (comparison === null) return null;
    return kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? comparison : !comparison;
  }
  if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = evaluate(node.left, bindings, parameterNames, locals);
    if (left === false) return false;
    const right = evaluate(node.right, bindings, parameterNames, locals);
    if (right === false) return false;
    return left === true && right === true ? true : null;
  }
  if (kind === ts.SyntaxKind.BarBarToken) {
    const left = evaluate(node.left, bindings, parameterNames, locals);
    if (left === true) return true;
    const right = evaluate(node.right, bindings, parameterNames, locals);
    if (right === true) return true;
    return left === false && right === false ? false : null;
  }
  return null;
}

/** `<bound parameter> <op> "literal"` -> whether the two are equal, or null when not decidable. */
function compareToBinding(subject: ts.Expression, literal: ts.Expression, bindings: Map<number, string>, parameterNames: string[]): boolean | null {
  const identifier = unwrap(subject);
  const value = unwrap(literal);
  if (!ts.isIdentifier(identifier) || !ts.isStringLiteral(value)) return null;
  const bound = bindings.get(parameterNames.indexOf(identifier.text));
  return bound === undefined ? null : bound === value.text;
}

function bindingKey(bindings: Map<number, string>): string {
  return [...bindings.entries()].sort((left, right) => left[0] - right[0]).map(([index, value]) => `${index}=${value}`).join(",");
}

/**
 * Every argument name read off parameter `argsIndex`, walking from `start`, with branches that the
 * caller's string literals prove dead pruned away.
 *
 * @param bindings string literals known for this function's parameters, from the call site.
 * @param stack in-progress keys, so mutual recursion terminates instead of looping.
 */
function collectReads(
  fn: FunctionFacts,
  argsIndex: number,
  bindings: Map<number, string>,
  start: ts.Node,
  context: AnalysisContext,
  stack: Set<string>
): Set<string> {
  const key = `${fn.id}@${argsIndex}@${start.pos}@${bindingKey(bindings)}`;
  const cached = context.memo.get(key);
  if (cached) return cached;
  if (stack.has(key)) return new Set();
  stack.add(key);

  const reads = new Set<string>();
  const aliases = argsAliases(fn, argsIndex);
  const locals = new Map<string, boolean>();
  const truth = (expression: ts.Expression): boolean | null => evaluate(expression, bindings, fn.parameterNames, locals);
  if (fn.node.body) {
    const seed = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const verdict = truth(node.initializer);
        if (verdict !== null) locals.set(node.name.text, verdict);
      }
      ts.forEachChild(node, seed);
    };
    seed(fn.node.body);
  }

  /** A key expression in a reader position: a literal, or a parameter the call site pinned. */
  const addKey = (key_: ts.Expression | undefined): void => {
    if (!key_) return;
    const resolved = unwrap(key_);
    if (ts.isStringLiteral(resolved)) { reads.add(resolved.text); return; }
    if (!ts.isIdentifier(resolved)) return;
    const bound = bindings.get(fn.parameterNames.indexOf(resolved.text));
    if (bound !== undefined) reads.add(bound);
  };

  const visit = (node: ts.Node): void => {
    // ---- prune branches the bound literals decide ----
    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const verdict = truth(node.expression);
      if (verdict !== false) visit(node.thenStatement);
      if (verdict !== true && node.elseStatement) visit(node.elseStatement);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition);
      const verdict = truth(node.condition);
      if (verdict !== false) visit(node.whenTrue);
      if (verdict !== true) visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.left);
      if (truth(node.left) !== false) visit(node.right);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      visit(node.left);
      if (truth(node.left) !== true) visit(node.right);
      return;
    }
    if (ts.isSwitchStatement(node)) {
      visit(node.expression);
      const subject = unwrap(node.expression);
      const bound = ts.isIdentifier(subject) ? bindings.get(fn.parameterNames.indexOf(subject.text)) : undefined;
      for (const clause of node.caseBlock.clauses) {
        if (bound !== undefined && ts.isCaseClause(clause)) {
          const label = unwrap(clause.expression);
          if (ts.isStringLiteral(label) && label.text !== bound) continue;
        }
        for (const statement of clause.statements) visit(statement);
      }
      return;
    }

    // ---- reads ----
    if (ts.isPropertyAccessExpression(node) && isArgsExpression(node.expression, aliases)) reads.add(node.name.text);
    if (ts.isElementAccessExpression(node) && isArgsExpression(node.expression, aliases)) addKey(node.argumentExpression);
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "hasOwn"
        && node.arguments.length >= 2 && isArgsExpression(node.arguments[0], aliases)) {
        addKey(node.arguments[1]);
      }
      const callee = calleeId(node, fn.file, context);
      const target = callee ? context.functions.get(callee) : null;
      if (target) {
        const calleeBindings = new Map<number, string>();
        for (let position = 0; position < node.arguments.length; position += 1) {
          const argument = unwrap(node.arguments[position]);
          if (ts.isStringLiteral(argument)) calleeBindings.set(position, argument.text);
          else if (ts.isIdentifier(argument)) {
            const bound = bindings.get(fn.parameterNames.indexOf(argument.text));
            if (bound !== undefined) calleeBindings.set(position, bound);
          }
        }
        for (let position = 0; position < node.arguments.length; position += 1) {
          if (!isArgsExpression(node.arguments[position], aliases)) continue;
          // `stringArg(args, "layerId")` — the key literal lives at THIS call site.
          for (const pair of target.readerPairs) {
            const [argsPosition, keyPosition] = pair.split(":").map(Number);
            if (argsPosition === position) addKey(node.arguments[keyPosition]);
          }
          // A sub-dispatcher re-reads `command` and constrains itself; its own pass covers it.
          if (target.dispatches || !target.node.body) continue;
          for (const inherited of collectReads(target, position, calleeBindings, target.node.body, context, stack)) reads.add(inherited);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(start);

  stack.delete(key);
  context.memo.set(key, reads);
  return reads;
}

/** The commands a condition constrains `command` to, or null when it constrains nothing. */
function commandsInCondition(condition: ts.Expression): { equals: string[] } | { notEquals: string[] } | null {
  const expression = unwrap(condition);
  if (!ts.isBinaryExpression(expression)) return null;
  const operator = expression.operatorToken.kind;
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    const left = unwrap(expression.left);
    const right = unwrap(expression.right);
    if (ts.isIdentifier(left) && left.text === "command" && ts.isStringLiteral(right)) {
      return operator === ts.SyntaxKind.EqualsEqualsEqualsToken ? { equals: [right.text] } : { notEquals: [right.text] };
    }
    return null;
  }
  // `command === "a" || command === "b"` handles one branch for two commands;
  // `command !== "a" && command !== "b"` is the narrowing guard before a shared tail.
  if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = commandsInCondition(expression.left);
    const right = commandsInCondition(expression.right);
    if (!left || !right) return null;
    if (operator === ts.SyntaxKind.BarBarToken && "equals" in left && "equals" in right) {
      return { equals: [...left.equals, ...right.equals] };
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken && "notEquals" in left && "notEquals" in right) {
      return { notEquals: [...left.notEquals, ...right.notEquals] };
    }
  }
  return null;
}

function isReturn(node: ts.Statement): boolean {
  if (ts.isReturnStatement(node)) return true;
  return ts.isBlock(node) && node.statements.length > 0 && node.statements.every((inner) => ts.isReturnStatement(inner));
}

/**
 * Whether a branch always leaves the function, so the statements after it are unreachable for the
 * command that entered it.
 *
 * Dispatchers can narrow to several commands, return from one branch, and let the rest fall
 * through to a shared tail. The analyser must not attribute tail-only arguments to commands whose
 * branches already returned.
 */
function alwaysReturns(node: ts.Statement): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (!ts.isBlock(node) || node.statements.length === 0) return false;
  return alwaysReturns(node.statements[node.statements.length - 1]);
}

interface Attribution {
  /** command -> argument names its handler reads. */
  byCommand: Map<string, Set<string>>;
  /** Reads the analyser could not tie to a command — a hole in the proof, reported as a failure. */
  unattributed: string[];
}

/** Walk every dispatcher and attribute each args read to the command(s) whose branch it sits under. */
function attribute(context: AnalysisContext): Attribution {
  const byCommand = new Map<string, Set<string>>();
  const unattributed: string[] = [];

  for (const fn of context.functions.values()) {
    if (!fn.dispatches || !fn.node.body || !ts.isBlock(fn.node.body)) continue;
    const argsIndex = fn.parameterNames.indexOf("args");
    if (argsIndex < 0) continue;
    const commandIndex = fn.parameterNames.indexOf("command");

    const scan = (node: ts.Node, commands: string[] | null): void => {
      if (!commands) {
        const reads = collectReads(fn, argsIndex, new Map(), node, context, new Set());
        if (reads.size > 0) unattributed.push(`${fn.file.replace(`${ROOT}/`, "")}#${fn.name}: ${[...reads].sort().join(", ")}`);
        return;
      }
      // One walk PER command, with `command` pinned to that literal. A branch shared by several
      // commands almost always splits again inside — `return command === "motion.job.get" ? get(args)
      // : list(args)` — and walking it once for the whole set would attribute `limit` to job.get.
      for (const command of commands) {
        const bindings = new Map<number, string>();
        if (commandIndex >= 0) bindings.set(commandIndex, command);
        const reads = collectReads(fn, argsIndex, bindings, node, context, new Set());
        if (reads.size === 0) continue;
        const set = byCommand.get(command) ?? new Set<string>();
        for (const read of reads) set.add(read);
        byCommand.set(command, set);
      }
    };

    let constraint: string[] | null = null;
    for (const statement of fn.node.body.statements) {
      if (ts.isIfStatement(statement) && !statement.elseStatement) {
        const guard = commandsInCondition(statement.expression);
        // `if (command !== "a" && command !== "b") return null;` narrows everything that follows.
        if (guard && "notEquals" in guard && isReturn(statement.thenStatement)) {
          constraint = guard.notEquals;
          continue;
        }
        if (guard && "equals" in guard) {
          scan(statement.thenStatement, guard.equals);
          // Whatever follows is unreachable for a command this branch never returns from.
          if (constraint && alwaysReturns(statement.thenStatement)) {
            constraint = constraint.filter((command) => !guard.equals.includes(command));
          }
          continue;
        }
      }
      scan(statement, constraint);
    }
  }
  return { byCommand, unattributed };
}

/** Every argument name a command's published schema accepts: properties plus their aliases. */
function declaredNames(command: string): Set<string> | null {
  const contract = DEBUG_COMMAND_CONTRACTS.find((entry) => entry.command === command);
  if (!contract?.argsSchema) return null;
  const names = new Set<string>();
  for (const [name, property] of Object.entries(contract.argsSchema.properties)) {
    names.add(name);
    for (const alias of property.aliases ?? []) names.add(alias);
  }
  return names;
}

export interface CoverageFinding {
  command: string;
  undeclared: string[];
}

export interface CoverageReport {
  findings: CoverageFinding[];
  unattributed: string[];
  /** command -> declared properties no handler reads. Informational: over-declaring is not a gate. */
  unread: Map<string, string[]>;
  commandsAnalysed: number;
}

export function debugArgCoverage(): CoverageReport {
  const { functions, imports } = indexFunctions(domainSources());
  const context: AnalysisContext = { functions, imports, memo: new Map() };
  findReaderPairs(context);
  const { byCommand, unattributed } = attribute(context);

  const findings: CoverageFinding[] = [];
  const unread = new Map<string, string[]>();
  for (const [command, reads] of [...byCommand.entries()].sort()) {
    const declared = declaredNames(command);
    // A command with no published schema is not shape-checked by any transport, so an undeclared
    // read cannot be rejected there. `command-metadata.test.ts` gates that list from growing.
    if (!declared) continue;
    const undeclared = [...reads].filter((name) => !declared.has(name) && !NON_ARGUMENT_READS.has(name)).sort();
    if (undeclared.length > 0) findings.push({ command, undeclared });
    const never = [...declared].filter((name) => !reads.has(name)).sort();
    if (never.length > 0) unread.set(command, never);
  }
  return { findings, unattributed, unread, commandsAnalysed: byCommand.size };
}

const isEntryPoint = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const { findings, unattributed, unread, commandsAnalysed } = debugArgCoverage();
  if (process.argv.includes("--report")) {
    for (const [command, names] of [...unread.entries()].sort()) console.log(`declared-but-unread ${command}: ${names.join(", ")}`);
  }
  for (const finding of findings) console.error(`UNDECLARED ${finding.command}: ${finding.undeclared.join(", ")}`);
  for (const hole of unattributed) console.error(`UNATTRIBUTED ${hole}`);
  if (findings.length + unattributed.length > 0) {
    console.error(`\nFAIL debug-arg-coverage: ${findings.length} command(s) read arguments their schema does not declare, ${unattributed.length} read(s) could not be attributed.`);
    console.error("Every argument a handler reads must appear in that command's argsSchema (as a property or an alias),");
    console.error("because mcp-args-validation.ts rejects anything the schema does not name.");
    process.exit(1);
  }
  console.log(`PASS debug-arg-coverage: ${commandsAnalysed} commands, every argument read is declared.`);
}
