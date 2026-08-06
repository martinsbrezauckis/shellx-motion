# AGENTS.md — ShellX Motion

Scope: the whole ShellX Motion repository. If your environment supplies additional
organization or account rules, follow both and use the stricter one where they differ.

You are most likely here because someone downloaded this repository and handed it to
you. This file is the shortest correct path from that to a rendered video.

## Read these first

1. [`skill/shellx-motion/SKILL.md`](skill/shellx-motion/SKILL.md) — the operating
   contract: inspect before editing, use typed commands, verify with the receipt.
2. [`skill/shellx-motion/references/invocation-and-permissions.md`](skill/shellx-motion/references/invocation-and-permissions.md)
   — the two invocation forms and the permission tiers. Both have a trap; see below.
3. [`docs/public/quickstart.md`](docs/public/quickstart.md) — download to rendered video.
4. [`schemas/debug.json`](schemas/debug.json) — every callable command with its
   arguments and required permission. This is the contract; the prose describes it.
5. [`docs/public/DEBUG_API_COMMANDS.md`](docs/public/DEBUG_API_COMMANDS.md) — the same
   contract as a readable table. Generated from `schemas/debug.json`, never hand-edited.
6. [`docs/public/FEATURES.md`](docs/public/FEATURES.md) — what exists **and what does
   not**. The limits are documented deliberately; read them before promising a user
   something Motion does not do.

## Four things that will trip you up

**1. There are two invocation forms and the wrong one fails.**

| where you are | how to run a command |
|---|---|
| this source checkout | `pnpm --filter @shellx-motion/cli run cli -- <command>` |
| an installed build | `shellx-motion <command>` |

If you cloned this repository, you are in the first row. Nothing puts `shellx-motion`
on your `PATH` here. There is no `motion` binary in either form, and dotted names like
`motion.render.final` are Debug API / MCP command ids, **not** shell commands.

**2. `write_local` outranks `edit_motion`.** The intuitive reading is wrong:

```
read_motion < draft_motion < render_motion < edit_motion < write_local < push_remote
```

`edit_motion` mutates a package that already exists. **Creating a new package needs
`write_local`.** Also note `draft_motion` is not only "planning" — it covers playhead,
range and viewport operations, which look like reads but are not.

**3. Check what this machine can actually do before rendering.** Run `doctor` first. It
reports per-operation readiness, so you learn what is missing before a render fails
rather than after. Motion depends on external programs it does not ship.

**4. A success envelope is not a successful render.** `ok: true` means the command ran.
Verify the artifact: check the receipt, the output hash, the duration and the quality
result. `docs/public/receipts-and-trust.md` explains what each receipt proves.

## Working rules

- **Inspect before mutating.** `validate`, then `motion.state`, then action discovery
  (`actions find "<what you want>"`) — it returns a callable plan rather than making you
  guess at the surface.
- **Use typed commands.** Do not hand-edit package JSON when a command owns the
  operation, and do not hand-write a package directory to work around a permission
  refusal. The refusal is the design.
- **Preview after mutating**, then read the returned receipt.
- **Keep execution local.** Never infer permission for remote publish or hosted
  rendering. `push_remote` is reserved and requires an explicit host flag.
- **Never put the access key in agent configuration.** The MCP bridge reads the private
  key and live port per call. Writing it into a config file, shell history, a URL or a
  log is the one thing this project asks you not to do with it.
- **Do not report live progress from `motion.render.status` or `.queue`.** They are
  derived from receipt files on disk and cannot see a running process. Use
  `motion.job.get` / `motion.job.list` for that.

## If you are changing this repository

- Contracts are generated, not written: edit the TypeScript metadata, then run
  `pnpm run contracts:generate && pnpm run docs:debug-api`. Hand-editing
  `schemas/debug.json` or `docs/public/DEBUG_API_COMMANDS.md` fails `pnpm run docs:check`.
- Run `pnpm run docs:check` and `pnpm test` before claiming a change works. A passing
  build is not evidence that behavior is correct.
- Public documentation lives in `docs/public/`. Nothing outside the export allowlist in
  `scripts/public-export-manifest.json` reaches the published repository.
