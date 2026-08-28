# V25-B1 exact scrub trace — Scrub the Signal

This is the fixture’s fixed playhead request contract. The only dynamic source is
`signal-footage`; it is visual-only and has no audio interpretation.

| field | exact value |
| --- | --- |
| composition | 1920x1080, 30 fps, 6400 ms |
| video timeline interval | `[480, 6080)` ms (start 480 ms, duration 5600 ms) |
| source trim interval | `[720, 1620)` ms (start 720 ms, duration 900 ms) |
| loop | `true` |
| playback rate | `1.25` |

For each request in the active interval, the required source time is:

```text
sourceAtUs = 720000 + (((playheadUs - 480000) * 1.25) mod 900000)
```

The provider must quantize the playhead once to integer microseconds, preserve the half-open trim
interval, and bind that exact source time to the immutable source snapshot and decoded RGBA frame.
The following values are part of the fixture contract.

## Forward

| playhead ms | expected source ms | expected source us |
| ---: | ---: | ---: |
| 480 | 720 | 720000 |
| 960 | 1320 | 1320000 |
| 1560 | 1170 | 1170000 |
| 2040 | 870 | 870000 |

## Backward

| playhead ms | expected source ms | expected source us |
| ---: | ---: | ---: |
| 2040 | 870 | 870000 |
| 1560 | 1170 | 1170000 |
| 960 | 1320 | 1320000 |
| 480 | 720 | 720000 |

## Random

| playhead ms | expected source ms | expected source us |
| ---: | ---: | ---: |
| 960 | 1320 | 1320000 |
| 2373 | 1286.25 | 1286250 |
| 480 | 720 | 720000 |
| 2891 | 1033.75 | 1033750 |
| 1560 | 1170 | 1170000 |

This trace covers ordering and source-time identity only. Successful native decoding, source and
RGBA receipt evidence, bounded retained-resource measurements, and human visual review remain
separate V25-B1 acceptance work.
