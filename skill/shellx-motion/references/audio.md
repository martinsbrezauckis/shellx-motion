# ShellX Motion document audio

Set one bounded document master through a copied package revision; `--master-json` is data, not an
FFmpeg filter or plugin declaration. A loudness target runs fixed post-mix **single-pass** loudnorm,
then final-video delivery must pass final-file readback. It is deterministic delivery control, not
two-pass/broadcast mastering:

```bash
shellx-motion debug audio-master-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/mastered \
  --master-json '{"volume":0.9,"fadeInMs":250,"fadeOutMs":400,"fadeCurve":"equal-power","loudness":{"integratedLufs":-16,"toleranceLufs":1,"maxTruePeakDbtp":-1,"maxLoudnessRangeLu":12}}'

shellx-motion debug audio-master-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/mastered --out /path/to/no-master --clear
```

Master fades must not exceed the document duration. A master with no resolved audio or an audio-less
preset is refused. A target miss yields materialized failed-receipt evidence or streamed bounded
partial-output readback evidence; do not treat its artifact as accepted delivery.

Create a crossfade only for clips that already overlap by exactly the requested duration; this sets
matched fades and never moves timing:

```bash
shellx-motion debug audio-crossfade-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/mastered --out /path/to/crossfaded \
  --from-layer music-out --to-layer music-in --duration-ms 750 --curve equal-power
```

Produce data-only RMS samples for an existing audio-envelope node from one trusted local source.
v0.2 refuses muted/unresolved, trimmed, looped, or playback-rate-adjusted sources rather than
approximating source time. The normal CLI/Debug/MCP/local-SDK route uses the caller-bound
governed decoder; its `resources` receipt evidence appears only when the runner actually reports it:

```bash
shellx-motion debug audio-envelope-produce \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/crossfaded --out /path/to/enveloped \
  --source-layer voiceover --envelope-id voice-rms --sample-every-ms 50 --channel mix
```

The producer imports no scripts, filters, or third-party DSP. Read its receipt and inspect the
stored graph before connecting the envelope to a bounded procedural relationship.
