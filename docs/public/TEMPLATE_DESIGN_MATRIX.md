# ShellX Motion Template Design Matrix

Status: active design-variety contract for the ShellX product starter pack.

This matrix prevents the starter catalog from becoming one narrow visual theme. A template family can share ShellX product language, but it should have a distinct use case, composition rhythm, motion vocabulary, and proof bundle before catalog promotion.

## Required Starter Families

| Family | Primary Job | Visual Direction | Motion Language | Required Proof |
| --- | --- | --- | --- | --- |
| SaaS launch bumper | Introduce a product, release, or campaign in 5-8 seconds. | Product-name first frame, strong logo or wordmark placement, crisp feature badges, high contrast. | Fast title entrance, accent wipe, compact feature beat, final CTA hold. | FHD MP4, text-fit receipt, Cut rendered-media receipt. |
| Product feature announcement | Show one feature with a short benefit arc. | UI or product screenshot, generated hero asset, supporting callouts, visible next-step signal. | Media reveal, callout stagger, soft zoom or scan-sweep highlight. | FHD MP4, generated/source asset receipt, Design Studio MP4 export receipt. |
| Modern lower third | Identify a person, app state, or segment without covering timeline content. | Compact lower safe-area composition, restrained accent, transparent or alpha-capable variant later. | Slide-cover or soft-fade in/out, subtitle stagger. | Safe-area receipt, Cut overlay/lowering receipt. |
| Social stat card | Make one metric memorable for social sharing. | Big number, small context, icon/image slot, square and vertical crops. | Count-up, emphasis pulse, final card stack. | FHD and social MP4s, text-fit receipt, batch row receipt. |
| Data/report brief | Summarize multiple product metrics or timeline steps. | Dense but readable table/list/chart, muted background, strong hierarchy. | Row reveals, timeline progress strip, subtle chart transitions. | CSV/JSON batch receipt, localized number-format receipt. |
| Tutorial overlay | Explain a workflow step over a UI capture or Design Studio frame. | Screen/media first, restrained overlay labels, cursor/callout affordances. | Browser/source capture reveal, callout pulse, step markers. | Browser workflow receipt, preview/final parity receipt. |
| Editorial explainer | Tell a short concept story without requiring Cut timeline editing. | Alternating text/media beats, wider margins, clear chapter rhythm. | Split reveal, punch-in, rhythm-matched typography. | Contact sheet, contrast receipt, FHD MP4. |
| Audio-backed release bumper | Prove audio-enabled Motion packages. | Simple but polished visual bed that lets audio proof stay visible in receipts. | Timed title beats, fade/duck transitions, final hold. | ffprobe audio stream receipt, loudness receipt, FHD MP4. |

## Design Rules

- Use varied layout families: full-bleed media, compact lower-third, dense report view, social card, and editorial sequence.
- Do not let the catalog collapse into one hue family. Each family should define primary, neutral, and accent roles with enough contrast for text and controls.
- Keep text inside safe areas for 16:9, 1:1, 9:16, and 4:5 where advertised.
- Real product or generated media should be visible in media-rich templates; do not rely on blurred abstract backgrounds as the main content.
- Motion must serve readability. Every transition preset should leave a stable final frame for review and Cut timeline insertion.
- Generated image or video assets must be imported under package-local `assets/` paths and linked to generated-asset receipts before render.

## Review Bundle

Each family review bundle should use this shape under `.scratch/template-quality/<template-id>/`:

```text
contact-sheet.png
fhd.mp4
social.mp4
text-fit.receipt.json
safe-area.receipt.json
asset-provenance.receipt.json
connector-cut.receipt.json
connector-canvas.receipt.json
```

Only templates with the required proof for their advertised hosts should appear as promoted catalog entries.
