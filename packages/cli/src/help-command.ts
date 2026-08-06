/**
 * `shellx-motion help` command output for the ShellX Motion CLI.
 *
 * Role: returns the static command catalog printed by `shellx-motion help` (and `--help`). Extracted
 * verbatim from `main.ts` so the CLI entry file stays under the module-size gate. Pure static data —
 * no argument parsing, no side effects, behavior unchanged.
 *
 * Dependencies: the `CliResult` shape from `./main` (type-only import).
 *
 * Primary callers: `packages/cli/src/main.ts` (runCli dispatch and preview `--help`).
 */
import type { CliResult } from "./main";

export function helpCommand(): CliResult {
  return {
    ok: true,
    command: "help",
    usage: "shellx-motion <command> [args]",
    commands: [
      {
        name: "integration-capabilities",
        usage: "shellx-motion integration-capabilities [--peer <capabilities.json>] [--require-mode <mode>]",
        purpose: "Publish or negotiate the versioned Motion/Cut/Canvas integration contract."
      },
      {
        name: "validate",
        usage: "shellx-motion validate <package>",
        purpose: "Validate a Motion package through the core loader."
      },
      {
        name: "inspect",
        usage: "shellx-motion inspect <package>",
        purpose: "Inspect package metadata, layers, assets, and timeline facts."
      },
      {
        name: "actions",
        usage: "shellx-motion actions find|guide|plan <request>",
        purpose: "Discover action/debug calls from natural prompt wording."
      },
      {
        name: "debug",
        usage: "shellx-motion debug <surface-command> [options]",
        purpose: "Call the same typed debug API used by Motion UI and ShellX hosts."
      },
      {
        name: "template",
        usage: "shellx-motion template controls|apply|media-replace <package> [options] [--force]",
        purpose: "Inspect and apply TemplateIR controls through declared bindings. --force replaces a non-empty --out directory."
      },
      {
        name: "agent",
        usage: "shellx-motion agent health --adapter codex|claude-code|grok|antigravity|auto",
        purpose: "Probe local CLI subscription agent readiness."
      },
      {
        name: "prompt",
        usage: "shellx-motion prompt run <request> [--retain-raw-prompt --raw-prompt-delete-after <ISO> --raw-prompt-purpose debugging|user_requested_replay]",
        purpose: "Route prompts through the local agent/action receipt contract."
      },
      {
        name: "preview",
        usage: "shellx-motion preview <package> --lane native|browser --out <dir>",
        purpose: "Render a deterministic preview frame and receipt."
      },
      {
        name: "capture-browser",
        usage: "shellx-motion capture-browser <package> --out <dir> [--workflow <json>]",
        purpose: "Capture deterministic browser-lane frames and workflow traces."
      },
      {
        name: "package-create",
        usage: "shellx-motion package-create <dir> [--name N] [--width W] [--height H] [--fps F] [--duration-ms MS] [--empty]",
        purpose: "Create a new, valid, renderable package from nothing. The first step when building something original rather than importing it."
      },
      {
        name: "doctor",
        usage: "shellx-motion doctor [--json]",
        purpose: "Check the external tools Motion needs (FFmpeg) and print how to install anything missing. Run this first if rendering fails."
      },
      {
        name: "job",
        usage: "shellx-motion job get <jobId> --caller-id <id> | job list --caller-id <id> [--limit N]",
        purpose: "Ask what a render is doing, from any process. Name the job with `render --job-id` to watch it live."
      },
      {
        name: "render",
        usage: "shellx-motion render <package> --lane ffmpeg|native --out <file-or-dir> [--force] [--job-id <id>] [--caller-id <id>]",
        purpose: "Render final media, image sequences, or still frames. --force replaces a non-empty image-sequence --out directory."
      },
      {
        name: "html-snippet-import",
        usage: "shellx-motion html-snippet-import <index.html> --out <package-dir>",
        purpose: "Import a ShellX/HyperFrames-style HTML composition into a Motion package."
      },
      {
        name: "render-batch",
        usage: "shellx-motion render-batch <package> --out <dir>",
        purpose: "Render package data rows with per-row receipts and idempotency keys."
      },
      {
        name: "quality-check",
        usage: "shellx-motion quality-check <media> [quality options]",
        purpose: "Validate rendered media facts, audio, visual samples, and alpha coverage."
      },
      {
        name: "connector",
        usage: "shellx-motion connector canvas-bridge-export|canvas-to-cut|canvas-to-mp4|script-to-cut|source-to-cut|cut-generate-to-cut|template-to-cut <input> --out <dir>",
        purpose: "Run Design Studio, Cut Generate, TemplateIR, and Cut handoff connectors."
      },
      {
        name: "plan-import",
        usage: "shellx-motion plan-import <package> --target cut",
        purpose: "Plan how a Motion package maps into a ShellX Cut import."
      },
      {
        name: "export-presets",
        usage: "shellx-motion export-presets",
        purpose: "List supported export presets with codec, audio, and alpha metadata."
      },
      {
        name: "review-html-bundle",
        usage: "shellx-motion review-html-bundle <package> --out <dir>",
        purpose: "Collect local review evidence into a portable HTML bundle."
      },
      {
        name: "html-snippet-export",
        usage: "shellx-motion html-snippet-export <package> --out <dir>",
        purpose: "Export a standalone HTML/CSS composition snippet with timing metadata and lossiness receipt evidence."
      },
      {
        name: "otio-export",
        usage: "shellx-motion otio-export <package> --out <timeline.otio>",
        purpose: "Export a Motion package as an OpenTimelineIO editorial interchange timeline."
      },
      {
        name: "otio-import",
        usage: "shellx-motion otio-import <timeline.otio> --out <package-dir>",
        purpose: "Import an OpenTimelineIO timeline into a local Motion package."
      },
      {
        name: "package-archive",
        usage: "shellx-motion package-archive <package> --out <archive.shellxmotion>",
        purpose: "Write a deterministic portable Motion package archive."
      },
      {
        name: "package-extract",
        usage: "shellx-motion package-extract <archive.shellxmotion> --out <package-dir>",
        purpose: "Extract a portable Motion package archive into a package directory."
      }
    ],
    agentFirst: {
      defaultAgentRoute: "local-cli-subscription",
      discovery: ["actions find", "actions guide", "actions plan", "debug actions-panel"],
      evidence: ["receipts", "debug state", "debug receipts-panel", "debug render-queue"]
    },
    examples: [
      "shellx-motion actions plan \"render this lower third as mp4\"",
      "shellx-motion debug state --package fixtures/packages/lower-third",
      "shellx-motion debug prompt-run --tier edit_motion --trusted-local-tier --request \"edit title and preview\" --execute-agent-commands --receipts-root .scratch/receipts",
      "shellx-motion prompt run \"edit title and preview\" --tier edit_motion --trusted-local-tier --execute-agent-commands --receipts-root .scratch/receipts",
      "shellx-motion connector canvas-to-cut fixtures/canvas/shape-text-frame-selection.json --out .scratch/connectors/canvas-story-hero --dry-run-render",
      "shellx-motion render-batch fixtures/packages/batch-card --out .scratch/batch-card-real"
    ]
  };
}
