/**
 * Coverage for grading a successful encode's stderr.
 *
 * The fixture below is real captured output from `ffmpeg 6.1.1` encoding a testsrc pattern to
 * H.264 — not an invented string — because the whole point of the classifier is that it matches
 * what ffmpeg actually prints, including the merged progress/muxing-overhead line that appears
 * when stderr is not a TTY.
 */
import { describe, expect, it } from "vitest";
import { summarizeSuccessfulEncodeStderr } from "./index";

const CLEAN_ENCODE_STDERR = [
  "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
  "  built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)",
  "  configuration: --prefix=/usr --enable-gpl --enable-libx264 --enable-shared",
  "  libavutil      58. 29.100 / 58. 29.100",
  "  libavcodec     60. 31.102 / 60. 31.102",
  "  libswresample   4. 12.100 /  4. 12.100",
  "Input #0, lavfi, from 'testsrc=size=64x36:rate=10:duration=1':",
  "  Duration: N/A, start: 0.000000, bitrate: N/A",
  "  Stream #0:0: Video: wrapped_avframe, rgb24, 64x36 [SAR 1:1 DAR 16:9], 10 fps, 10 tbr, 10 tbn",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (wrapped_avframe (native) -> h264 (libx264))",
  "Press [q] to stop, [?] for help",
  "[libx264 @ 0x5f0ad7226400] using SAR=1/1",
  "[libx264 @ 0x5f0ad7226400] using cpu capabilities: MMX2 SSE2Fast SSSE3 SSE4.2 AVX FMA3 BMI2 AVX2",
  "[libx264 @ 0x5f0ad7226400] profile High, level 1.0, 4:2:0, 8-bit",
  "[libx264 @ 0x5f0ad7226400] 264 - core 164 r3108 31e19f9 - H.264/MPEG-4 AVC codec - Copyleft 2003-2023",
  "Output #0, mp4, to 'out.mp4':",
  "  Metadata:",
  "    encoder         : Lavf60.16.100",
  "  Stream #0:0: Video: h264 (avc1 / 0x31637661), yuv420p(tv, progressive), 64x36, q=2-31, 10 fps",
  "    Metadata:",
  "      encoder         : Lavc60.31.102 libx264",
  "    Side data:",
  "      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "frame=    0 fps=0.0 q=0.0 size=       0kB time=N/A bitrate=N/A speed=N/A    [out#0/mp4 @ 0x5f0ad7224bc0] video:2kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 48.940678%",
  "frame=   10 fps=0.0 q=25.0 Lsize=       3kB time=00:00:00.70 bitrate=  32.1kbits/s speed= 115x    ",
  "[libx264 @ 0x5f0ad7226400] frame I:1     Avg QP:25.83  size:   560",
  "[libx264 @ 0x5f0ad7226400] frame P:9     Avg QP:28.04  size:    71",
  "[libx264 @ 0x5f0ad7226400] mb I  I16..4:  0.0%  0.0% 100.0%",
  "[libx264 @ 0x5f0ad7226400] mb P  I16..4:  0.0%  0.0%  0.0%  P16..4: 32.4%  skip:66.7%",
  "[libx264 @ 0x5f0ad7226400] 8x8 transform intra:0.0% inter:51.4%",
  "[libx264 @ 0x5f0ad7226400] coded y,uvDC,uvAC intra: 56.2% 100.0% 83.3% inter: 15.0% 33.3% 30.6%",
  "[libx264 @ 0x5f0ad7226400] i4 v,h,dc,ddl,ddr,vr,hd,vl,hu: 63%  9% 21%  2%  1%  1%  1%  1%  1%",
  "[libx264 @ 0x5f0ad7226400] i8c dc,h,v,p: 83%  8%  8%  0%",
  "[libx264 @ 0x5f0ad7226400] Weighted P-Frames: Y:0.0% UV:0.0%",
  "[libx264 @ 0x5f0ad7226400] kb/s:9.59"
].join("\n");

describe("summarizeSuccessfulEncodeStderr", () => {
  it("reports nothing for a clean encode", () => {
    // Before this classifier the receipt recorded the last two lines — always the progress and
    // muxing-overhead summary — so every successful render appeared to have warned.
    expect(summarizeSuccessfulEncodeStderr(CLEAN_ENCODE_STDERR)).toBe("");
  });

  it("keeps a real diagnostic that appears among routine output", () => {
    const withProblem = `${CLEAN_ENCODE_STDERR}\n[mp4 @ 0x55f] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;`;
    expect(summarizeSuccessfulEncodeStderr(withProblem)).toContain("Non-monotonous DTS");
  });

  it("keeps a diagnostic after FFmpeg's bare-carriage-return progress update", () => {
    const withProblem = "frame=   10 fps=0.0 q=25.0 size=3kB time=00:00:00.70 bitrate=32.1kbits/s speed=115x\r"
      + "[mp4 @ 0x55f] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;";
    expect(summarizeSuccessfulEncodeStderr(withProblem))
      .toBe("[mp4 @ [address]] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;");
  });

  it("keeps an unrecognised line rather than hiding it", () => {
    // The classifier is a denylist on purpose: a line it has never seen must survive.
    const surprising = `${CLEAN_ENCODE_STDERR}\nsomething nobody anticipated happened here`;
    expect(summarizeSuccessfulEncodeStderr(surprising)).toBe("something nobody anticipated happened here");
  });

  it("collapses a repeated complaint and bounds the total", () => {
    const repeated = Array.from({ length: 400 }, () => "[mp4 @ 0x1] Past duration 0.999992 too large").join("\n");
    const distinct = Array.from({ length: 9 }, (_, index) => `[mp4 @ 0x1] problem number ${index}`).join("\n");

    expect(summarizeSuccessfulEncodeStderr(repeated)).toBe("[mp4 @ [address]] Past duration 0.999992 too large");
    // Bounded so a pathological encode cannot fill the receipt.
    expect(summarizeSuccessfulEncodeStderr(distinct).split("problem number").length - 1).toBe(5);
  });

  it("redacts secrets that reached the command line", () => {
    const leaked = "AWS_SECRET_ACCESS_KEY=abc123 could not open output";
    expect(summarizeSuccessfulEncodeStderr(leaked)).toContain("[redacted]");
    expect(summarizeSuccessfulEncodeStderr(leaked)).not.toContain("abc123");
  });

  it("reports nothing for empty stderr", () => {
    expect(summarizeSuccessfulEncodeStderr("")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("   \n  \n")).toBe("");
  });
});

/**
 * Real captured stderr from `ffmpeg 6.1.1` muxing a PNG image sequence with a normalized WAV track
 * — the exact shape of a Motion audio render. Every line here is ROUTINE: the loudnorm block is a
 * measurement Motion asked for and records on the receipt as `output.audio.loudness`, the channel
 * layout line reports a successful inference from raw PCM, and the thread-queue line is a tuning
 * suggestion about back-pressure that costs nothing.
 *
 * Before the success-status invariant these survived into the receipt, so the `audio-launch` product-pack
 * family shipped a perfectly good MP4 carrying an encoder-chatter "warning".
 */
const CLEAN_AUDIO_ENCODE_STDERR = [
  "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
  "  built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)",
  "  configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --disable-omx --enable-gnutls --enable-libaom --enable-libass --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libharfbuzz --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-openal --enable-opencl --enable-opengl --disable-sndio --enable-libvpl --disable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-ladspa --enable-libbluray --enable-libjack --enable-libpulse --enable-librabbitmq --enable-librist --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libx264 --enable-libzmq --enable-libzvbi --enable-lv2 --enable-sdl2 --enable-libplacebo --enable-librav1e --enable-pocketsphinx --enable-librsvg --enable-libjxl --enable-shared",
  "  libavutil      58. 29.100 / 58. 29.100",
  "  libavcodec     60. 31.102 / 60. 31.102",
  "  libavformat    60. 16.100 / 60. 16.100",
  "  libavdevice    60.  3.100 / 60.  3.100",
  "  libavfilter     9. 12.100 /  9. 12.100",
  "  libswscale      7.  5.100 /  7.  5.100",
  "  libswresample   4. 12.100 /  4. 12.100",
  "  libpostproc    57.  3.100 / 57.  3.100",
  "Input #0, image2, from 'frame-%06d.png':",
  "  Duration: 00:00:02.00, start: 0.000000, bitrate: N/A",
  "  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 320x180 [SAR 1:1 DAR 16:9], 8 fps, 8 tbr, 8 tbn",
  "[aist#1:0/pcm_s16le @ 0x63f01ba910c0] Guessed Channel Layout: mono",
  "Input #1, wav, from 'tone.wav':",
  "  Metadata:",
  "    encoder         : Lavf60.16.100",
  "  Duration: 00:00:02.00, bitrate: 705 kb/s",
  "  Stream #1:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, 1 channels, s16, 705 kb/s",
  "Stream mapping:",
  "  Stream #1:0 (pcm_s16le) -> loudnorm:default (graph 0)",
  "  Stream #0:0 -> #0:0 (png (native) -> h264 (libx264))",
  "  loudnorm:default (graph 0) -> Stream #0:1 (aac)",
  "Press [q] to stop, [?] for help",
  "[in#0/image2 @ 0x63f01ba8a400] Thread message queue blocking; consider raising the thread_queue_size option (current value: 8)",
  "[libx264 @ 0x63f01bad80c0] using SAR=1/1",
  "[libx264 @ 0x63f01bad80c0] using cpu capabilities: MMX2 SSE2Fast SSSE3 SSE4.2 AVX FMA3 BMI2 AVX2",
  "[libx264 @ 0x63f01bad80c0] profile High, level 1.2, 4:2:0, 8-bit",
  "[libx264 @ 0x63f01bad80c0] 264 - core 164 r3108 31e19f9 - H.264/MPEG-4 AVC codec - Copyleft 2003-2023 - http://www.videolan.org/x264.html - options: cabac=1 ref=3 deblock=1:0:0 analyse=0x3:0x113 me=hex subme=7 psy=1 psy_rd=1.00:0.00 mixed_ref=1 me_range=16 chroma_me=1 trellis=1 8x8dct=1 cqm=0 deadzone=21,11 fast_pskip=1 chroma_qp_offset=-2 threads=6 lookahead_threads=1 sliced_threads=0 nr=0 decimate=1 interlaced=0 bluray_compat=0 constrained_intra=0 bframes=3 b_pyramid=2 b_adapt=1 b_bias=0 direct=1 weightb=1 open_gop=0 weightp=2 keyint=250 keyint_min=8 scenecut=40 intra_refresh=0 rc_lookahead=40 rc=crf mbtree=1 crf=23.0 qcomp=0.60 qpmin=0 qpmax=69 qpstep=4 ip_ratio=1.40 aq=1:1.00",
  "Output #0, mp4, to 'out2.mp4':",
  "  Metadata:",
  "    encoder         : Lavf60.16.100",
  "  Stream #0:0: Video: h264 (avc1 / 0x31637661), yuv420p(tv, progressive), 320x180 [SAR 1:1 DAR 16:9], q=2-31, 8 fps, 16384 tbn",
  "    Metadata:",
  "      encoder         : Lavc60.31.102 libx264",
  "    Side data:",
  "      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "  Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 96000 Hz, mono, fltp, 69 kb/s",
  "    Metadata:",
  "      encoder         : Lavc60.31.102 aac",
  "frame=    0 fps=0.0 q=0.0 size=       0kB time=00:00:00.08 bitrate=   4.5kbits/s speed=2.46x",
  "[out#0/mp4 @ 0x63f01bad7200] video:8kB audio:17kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 10.247336%",
  "frame=   16 fps=0.0 q=-1.0 Lsize=      27kB time=00:00:01.99 bitrate= 112.4kbits/s speed=29.6x",
  "[Parsed_loudnorm_0 @ 0x63f01be891c0]",
  "Input Integrated:    -21.8 LUFS",
  "Input True Peak:     -18.1 dBTP",
  "Input LRA:             0.0 LU",
  "Input Threshold:     -31.8 LUFS",
  "Output Integrated:   -16.1 LUFS",
  "Output True Peak:    -12.3 dBTP",
  "Output LRA:            0.0 LU",
  "Output Threshold:    -26.1 LUFS",
  "Normalization Type:   Linear",
  "Target Offset:        +0.1 LU",
  "[libx264 @ 0x63f01bad80c0] frame I:1     Avg QP:12.82  size:  2951",
  "[libx264 @ 0x63f01bad80c0] frame P:4     Avg QP:15.10  size:   757",
  "[libx264 @ 0x63f01bad80c0] frame B:11    Avg QP:12.80  size:   101",
  "[libx264 @ 0x63f01bad80c0] consecutive B-frames:  6.2%  0.0% 18.8% 75.0%",
  "[libx264 @ 0x63f01bad80c0] mb I  I16..4: 68.3%  2.9% 28.8%",
  "[libx264 @ 0x63f01bad80c0] mb P  I16..4:  3.1%  2.4%  4.3%  P16..4:  5.3%  4.7%  2.8%  0.0%  0.0%    skip:77.4%",
  "[libx264 @ 0x63f01bad80c0] mb B  I16..4:  0.2%  0.0%  0.0%  B16..8:  9.6%  1.4%  0.6%  direct: 0.5%  skip:87.8%  L0:59.2% L1:37.7% BI: 3.1%",
  "[libx264 @ 0x63f01bad80c0] 8x8 transform intra:9.1% inter:78.0%",
  "[libx264 @ 0x63f01bad80c0] coded y,uvDC,uvAC intra: 22.4% 49.4% 43.5% inter: 1.1% 4.6% 2.4%",
  "[libx264 @ 0x63f01bad80c0] i16 v,h,dc,p: 78% 14%  8%  0%",
  "[libx264 @ 0x63f01bad80c0] i8 v,h,dc,ddl,ddr,vr,hd,vl,hu: 33% 43% 17%  2%  0%  2%  2%  1%  0%",
  "[libx264 @ 0x63f01bad80c0] i4 v,h,dc,ddl,ddr,vr,hd,vl,hu: 58% 26% 12%  1%  1%  1%  0%  1%  0%",
  "[libx264 @ 0x63f01bad80c0] i8c dc,h,v,p: 41% 33% 24%  1%",
  "[libx264 @ 0x63f01bad80c0] Weighted P-Frames: Y:0.0% UV:0.0%",
  "[libx264 @ 0x63f01bad80c0] ref P L0: 70.5%  8.3% 13.4%  7.7%",
  "[libx264 @ 0x63f01bad80c0] ref B L0: 83.3% 13.0%  3.6%",
  "[libx264 @ 0x63f01bad80c0] ref B L1: 97.8%  2.2%",
  "[libx264 @ 0x63f01bad80c0] kb/s:28.38",
  "[aac @ 0x63f01bb0e7c0] Qavg: 104.948"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on a real audio render", () => {
  it("reports nothing for a successful loudness-normalized audio mux", () => {
    expect(summarizeSuccessfulEncodeStderr(CLEAN_AUDIO_ENCODE_STDERR)).toBe("");
  });

  it("still surfaces a genuine loudnorm failure among the measurement block", () => {
    // The measurement labels are matched exactly, so an actual filter error — which does not use
    // that vocabulary — cannot hide inside the block that was filtered.
    const broken = `${CLEAN_AUDIO_ENCODE_STDERR}\n[Parsed_loudnorm_0 @ 0x1] Invalid loudness target`;
    expect(summarizeSuccessfulEncodeStderr(broken)).toBe("[Parsed_loudnorm_0 @ [address]] Invalid loudness target");
  });

  it("treats the whole x264 statistics block as routine, including the ref/consecutive lines", () => {
    const stats = [
      "[libx264 @ 0x1] consecutive B-frames:  6.2%  0.0% 18.8% 75.0%",
      "[libx264 @ 0x1] ref P L0: 70.5%  8.3% 13.4%  7.7%",
      "[libx264 @ 0x1] ref B L0: 83.3% 13.0%  3.6%",
      "[libx264 @ 0x1] ref B L1: 97.8%  2.2%",
      "[aac @ 0x1] Qavg: 104.948"
    ].join("\n");
    expect(summarizeSuccessfulEncodeStderr(stats)).toBe("");
  });
});

/**
 * Real captured stderr from `ffmpeg 6.1.1` encoding the `keyframed-lower-third` fixture's rendered
 * PNG sequence to VP9/WebM with Motion's exact `webm-vp9` preset arguments (`-c:v libvpx-vp9 -b:v 0
 * -crf 32 -pix_fmt yuv420p` plus the BT.709 tail). Captured, not invented — the whole reason this
 * fixture exists is that the success-status invariant was caused by a line nobody had predicted.
 *
 * The only non-x264-shaped line in it is libvpx's version banner, `[libvpx-vp9 @ 0x...] v1.14.0`.
 * ffmpeg's libvpx wrapper prints that at INFO on EVERY libvpx encode, so before the fix a clean,
 * successful WebM render carried an encoder version number as a receipt "warning" — warning
 * fatigue on the surface an agent reads to decide what happened.
 */
const CLEAN_WEBM_VP9_ENCODE_STDERR = [
  "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
  "  built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)",
  "  configuration: --prefix=/usr --extra-version=3ubuntu5 --toolchain=hardened --libdir=/usr/lib/x86_64-linux-gnu --incdir=/usr/include/x86_64-linux-gnu --arch=amd64 --enable-gpl --disable-stripping --disable-omx --enable-gnutls --enable-libaom --enable-libass --enable-libbs2b --enable-libcaca --enable-libcdio --enable-libcodec2 --enable-libdav1d --enable-libflite --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libglslang --enable-libgme --enable-libgsm --enable-libharfbuzz --enable-libmp3lame --enable-libmysofa --enable-libopenjpeg --enable-libopenmpt --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx265 --enable-libxml2 --enable-libxvid --enable-libzimg --enable-openal --enable-opencl --enable-opengl --disable-sndio --enable-libvpl --disable-libmfx --enable-libdc1394 --enable-libdrm --enable-libiec61883 --enable-chromaprint --enable-frei0r --enable-ladspa --enable-libbluray --enable-libjack --enable-libpulse --enable-librabbitmq --enable-librist --enable-libsrt --enable-libssh --enable-libsvtav1 --enable-libx264 --enable-libzmq --enable-libzvbi --enable-lv2 --enable-sdl2 --enable-libplacebo --enable-librav1e --enable-pocketsphinx --enable-librsvg --enable-libjxl --enable-shared",
  "  libavutil      58. 29.100 / 58. 29.100",
  "  libavcodec     60. 31.102 / 60. 31.102",
  "  libavformat    60. 16.100 / 60. 16.100",
  "  libavdevice    60.  3.100 / 60.  3.100",
  "  libavfilter     9. 12.100 /  9. 12.100",
  "  libswscale      7.  5.100 /  7.  5.100",
  "  libswresample   4. 12.100 /  4. 12.100",
  "  libpostproc    57.  3.100 / 57.  3.100",
  "Input #0, image2, from 'frames/pkg_keyframed_lower_third/%06d.png':",
  "  Duration: 00:00:03.00, start: 0.000000, bitrate: N/A",
  "  Stream #0:0: Video: png, rgb24(pc, gbr/unknown/unknown), 1280x720, 30 fps, 30 tbr, 30 tbn",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (png (native) -> vp9 (libvpx-vp9))",
  "Press [q] to stop, [?] for help",
  "[libvpx-vp9 @ 0x5b15e8932f00] v1.14.0",
  "Output #0, webm, to 'keyframed-lower-third.webm':",
  "  Metadata:",
  "    encoder         : Lavf60.16.100",
  "  Stream #0:0: Video: vp9, yuv420p(tv, bt709, progressive), 1280x720, q=2-31, 30 fps, 1k tbn",
  "    Metadata:",
  "      encoder         : Lavc60.31.102 libvpx-vp9",
  "    Side data:",
  "      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "frame=    0 fps=0.0 q=0.0 size=       0kB time=N/A bitrate=N/A speed=N/A    frame=   35 fps=0.0 q=32.0 size=       0kB time=00:00:01.16 bitrate=   3.4kbits/s speed=2.24x    [out#0/webm @ 0x5b15e886a440] video:44kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 2.432087%",
  "frame=   90 fps= 81 q=32.0 Lsize=      45kB time=00:00:02.96 bitrate= 125.3kbits/s speed=2.67x"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on a real WebM VP9 render", () => {
  it("reports nothing for a successful VP9 encode", () => {
    // Before the fix this returned "[libvpx-vp9 @ 0x5b15e8932f00] v1.14.0", which downgraded a
    // clean WebM receipt to `warning` and devalued every other warning an agent reads.
    expect(summarizeSuccessfulEncodeStderr(CLEAN_WEBM_VP9_ENCODE_STDERR)).toBe("");
  });

  it("still surfaces a genuine libvpx warning from the same encoder instance", () => {
    // Also real captured output: `ffmpeg -c:v libvpx-vp9 -crf 32` with no `-b:v` succeeds AND
    // warns. The filter is anchored to a bare version token, so this prose diagnostic — printed by
    // the same `[libvpx-vp9 @ ...]` instance whose banner was filtered — survives into the receipt.
    const warned = [
      CLEAN_WEBM_VP9_ENCODE_STDERR,
      "[libvpx-vp9 @ 0x5d6a81ccce40] Neither bitrate nor constrained quality specified, using default CRF of 32"
    ].join("\n");
    expect(summarizeSuccessfulEncodeStderr(warned))
      .toBe("[libvpx-vp9 @ [address]] Neither bitrate nor constrained quality specified, using default CRF of 32");
  });

  it("filters the VP8 spelling of the banner and nothing that merely starts like it", () => {
    // VP8 encodes print the same banner as "[libvpx @ ...]" (captured from a real `-c:v libvpx`
    // run). Anything with text after the version token is NOT the banner and must survive.
    expect(summarizeSuccessfulEncodeStderr("[libvpx @ 0x5fb62f501e40] v1.14.0")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("[libvpx-vp9 @ 0x1] v1.14.0 is too old for this stream"))
      .toBe("[libvpx-vp9 @ [address]] v1.14.0 is too old for this stream");
  });

  it("keeps libvpx diagnostics that are not a version banner", () => {
    // Real captured libvpx errors, plus the general shape of an unknown libvpx complaint. None of
    // them is a bare version token, so none of them can be hidden by the banner pattern.
    const diagnostics = [
      "[libvpx-vp9 @ 0x5e9e3e3cbe80] CQ level 32 must be between minimum and maximum quantizer value (40-20)",
      "[libvpx-vp9 @ 0x1] Failed to initialize encoder: Invalid parameter",
      "[libvpx-vp9 @ 0x1] v1.14.0 build is missing VP9 support"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(diagnostics);
    expect(summary).toContain("CQ level 32 must be between minimum and maximum quantizer value");
    expect(summary).toContain("Failed to initialize encoder: Invalid parameter");
    expect(summary).toContain("build is missing VP9 support");
  });

  it("filters libvpx development-build version strings without loosening the anchor", () => {
    // libvpx reports non-release builds as "v1.14.0-rc1" / "v1.14.0-172-g0e0e5d7d1".
    expect(summarizeSuccessfulEncodeStderr("[libvpx-vp9 @ 0x1] v1.14.0-rc1")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("[libvpx-vp9 @ 0x1] v1.14.0-172-g0e0e5d7d1")).toBe("");
    // A different encoder announcing a version is not covered by this pattern and still surfaces,
    // because the denylist stays per-encoder rather than becoming "any line ending in a version".
    expect(summarizeSuccessfulEncodeStderr("[libaom-av1 @ 0x1] v3.8.0")).toBe("[libaom-av1 @ [address]] v3.8.0");
  });
});

/**
 * Real captured stderr from `ffmpeg 6.1.1` encoding the `procedural-relationships` fixture's
 * rendered PNG sequence with Motion's exact `gif` preset arguments (the
 * `split -> palettegen=stats_mode=full -> paletteuse=dither=bayer:...` filtergraph plus `-loop 0`).
 * Captured by re-running the encode the `render-gif:smoke` gate performs, not invented.
 *
 * Two lines here were leaking into every GIF receipt, reopening the success-status invariant on a
 * different preset:
 *
 *   - `  paletteuse:default -> Stream #0:0 (gif)` — the filtergraph half of the stream-mapping
 *     banner. The audio path prints the same block as `loudnorm:default (graph 0) -> ...`, and
 *     only that graph-numbered spelling was filtered.
 *   - `[Parsed_palettegen_1 @ 0x...] 2(+1) colors generated out of 2 colors; ratio=1.000000` —
 *     palettegen's palette-size report, logged at AV_LOG_INFO, carrying a heap pointer that
 *     CHANGES BETWEEN RUNS. Two renders of the same package produced different receipt text.
 */
const CLEAN_GIF_ENCODE_STDERR = [
  "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers",
  "  built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)",
  "  libavutil      58. 29.100 / 58. 29.100",
  "  libavcodec     60. 31.102 / 60. 31.102",
  "  libavfilter     9. 12.100 /  9. 12.100",
  "Input #0, image2, from 'native-frames/pkg_procedural_relationships/%06d.png':",
  "  Duration: 00:00:02.00, start: 0.000000, bitrate: N/A",
  "  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 320x180, 30 fps, 30 tbr, 30 tbn",
  "Stream mapping:",
  "  Stream #0:0 (png) -> split:default",
  "  paletteuse:default -> Stream #0:0 (gif)",
  "Press [q] to stop, [?] for help",
  "[Parsed_palettegen_1 @ 0x639c648dce80] 2(+1) colors generated out of 2 colors; ratio=1.000000",
  "Output #0, gif, to 'procedural-relationships.gif':",
  "  Metadata:",
  "    encoder         : Lavf60.16.100",
  "  Stream #0:0: Video: gif, pal8(pc, gbr/unknown/unknown, progressive), 320x180, q=2-31, 200 kb/s, 30 fps, 100 tbn",
  "    Metadata:",
  "      encoder         : Lavc60.31.102 gif",
  "frame=    1 fps=0.0 q=-0.0 size=       0kB time=00:00:00.03 bitrate=   0.0kbits/s speed=0.387x    [out#0/gif @ 0x639c64913a00] video:27kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.072767%",
  "frame=   60 fps=0.0 q=-0.0 Lsize=      27kB time=00:00:01.96 bitrate= 111.9kbits/s speed=21.2x"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on a real GIF render", () => {
  it("reports nothing for a successful palettegen/paletteuse GIF encode", () => {
    // Before the fix this returned the mapping line plus the palette-size report, so the ONE
    // fixture in the whole render-smoke suite that is supposed to prove an unwarned `passed`
    // shipped a receipt warning that was really the encoder narrating itself.
    expect(summarizeSuccessfulEncodeStderr(CLEAN_GIF_ENCODE_STDERR)).toBe("");
  });

  it("produces identical output for two runs that differ only in the heap pointer", () => {
    // The determinism half of the defect, stated as an assertion: the SAME package rendered twice
    // gave two different receipts because `@ 0x...` is a heap address. Both captures below are
    // real — 0x639c648dce80 and 0x5fed52372e80 are the tags from two consecutive smoke runs.
    const secondRun = CLEAN_GIF_ENCODE_STDERR.replaceAll("0x639c648dce80", "0x5fed52372e80");
    expect(secondRun).not.toBe(CLEAN_GIF_ENCODE_STDERR);
    expect(summarizeSuccessfulEncodeStderr(secondRun)).toBe(summarizeSuccessfulEncodeStderr(CLEAN_GIF_ENCODE_STDERR));
  });

  it("still surfaces a genuine palettegen warning printed by the filtered instance", () => {
    // `Duped color` is real captured output from the 1280x720 browser-lane GIF render, and it is a
    // genuine AV_LOG_WARNING: re-running that encode with `-loglevel warning` drops the palette-size
    // report and KEEPS this line, which is how the two were told apart rather than by opinion.
    // It comes from the same `[Parsed_palettegen_1 @ ...]` instance whose INFO line is filtered.
    const warned = `${CLEAN_GIF_ENCODE_STDERR}\n[Parsed_palettegen_1 @ 0x5a5ce1edee80] Duped color: FFDCDDE0`;
    expect(summarizeSuccessfulEncodeStderr(warned)).toBe("[Parsed_palettegen_1 @ [address]] Duped color: FFDCDDE0");
  });

  it("still surfaces genuine palettegen and paletteuse errors", () => {
    // All three are real captured output, provoked on purpose: `palettegen=max_colors=2` (which
    // conflicts with the reserved transparent slot) and a `paletteuse` fed an 8x8 palette instead
    // of a 256-pixel one. None of them is the palette-size report, so none can be filtered.
    const broken = [
      CLEAN_GIF_ENCODE_STDERR,
      "[Parsed_palettegen_1 @ 0x604698757b80] max_colors=2 is only allowed without reserving a transparent color slot",
      "[Parsed_paletteuse_0 @ 0x5615af6b0b40] Palette input must contain exactly 256 pixels. Specified input has 8x8=64 pixels",
      "[Parsed_paletteuse_0 @ 0x5615af6b0b40] Failed to configure input pad on Parsed_paletteuse_0"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(broken);
    expect(summary).toContain("max_colors=2 is only allowed without reserving a transparent color slot");
    expect(summary).toContain("Palette input must contain exactly 256 pixels");
    expect(summary).toContain("Failed to configure input pad on Parsed_paletteuse_0");
  });

  it("keeps a palette-size report that carries anything extra", () => {
    // The anchor runs to end-of-line, so a hypothetical future ffmpeg that appends a complaint to
    // the same line is not silently swallowed by the pattern that hides the clean form.
    expect(summarizeSuccessfulEncodeStderr("[Parsed_palettegen_1 @ 0x1] 255(+1) colors generated out of 19505 colors; ratio=0.013074 (palette truncated)"))
      .toBe("[Parsed_palettegen_1 @ [address]] 255(+1) colors generated out of 19505 colors; ratio=0.013074 (palette truncated)");
    // And the vocabulary is per-filter: a different filter reporting colours is not this banner.
    expect(summarizeSuccessfulEncodeStderr("[Parsed_showpalette_0 @ 0x1] 255(+1) colors generated out of 19505 colors; ratio=0.013074"))
      .toBe("[Parsed_showpalette_0 @ [address]] 255(+1) colors generated out of 19505 colors; ratio=0.013074");
  });

  it("filters the filtergraph mapping line without swallowing indented prose", () => {
    // The mapping pattern now accepts both spellings of the same banner block.
    expect(summarizeSuccessfulEncodeStderr("  paletteuse:default -> Stream #0:0 (gif)")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("  loudnorm:default (graph 0) -> Stream #0:1 (aac)")).toBe("");
    // ffmpeg diagnostics start at column 0 with a `[tag @ addr]` prefix, never as an indented
    // `label -> Stream #n:m` mapping, so a real complaint cannot take this shape.
    expect(summarizeSuccessfulEncodeStderr("[fc#0 @ 0x1] Error reinitializing filters!"))
      .toBe("[fc#0 @ [address]] Error reinitializing filters!");
    // (leading indentation is preserved verbatim; the summarizer only trims line ENDS)
    expect(summarizeSuccessfulEncodeStderr("  paletteuse could not map -> Stream is broken"))
      .toBe("  paletteuse could not map -> Stream is broken");
  });
});

/**
 * The Windows half of the same class: two routine lines that FFmpeg 6.1.1 either spells differently
 * or hides inside the progress line, and that FFmpeg N-125773 (8.x dev) prints plainly.
 *
 * Captured verbatim from a real `connector:script-cut-smoke` run on the Windows rig, where the two
 * lines arrived concatenated into ONE receipt warning and turned four connector smokes from
 * `passed` into `warning` — while the identical package stayed `passed` on Linux. A cross-platform
 * difference invented entirely by unfiltered encoder noise is the strongest possible argument for
 * this classifier existing at all.
 *
 * Note the pointer format: Windows prints instance addresses WITHOUT the `0x` prefix.
 */
const WINDOWS_FASTSTART_CHATTER = [
  "      CPB properties: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "[mp4 @ 000001dbec2dbb00] Starting second pass: moving the moov atom to the beginning of the file"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on newer-FFmpeg MP4 chatter", () => {
  it("reports nothing for the Windows CPB + faststart pair that failed four connector smokes", () => {
    expect(summarizeSuccessfulEncodeStderr(WINDOWS_FASTSTART_CHATTER)).toBe("");
  });

  it("filters both spellings of the same CPB side-data line", () => {
    // 6.1.1 spelling (real captured output) and the 8.x spelling of the identical side data.
    expect(summarizeSuccessfulEncodeStderr("      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("      CPB properties: bitrate max/min/avg: 800000/0/400000 buffer size: 2000000 vbv_delay: 0")).toBe("");
  });

  it("keeps a genuine bitrate or buffering diagnostic that merely mentions CPB", () => {
    // The anchor is the exact HRD field sequence, so prose about the same subject survives.
    const diagnostics = [
      "[libx264 @ 0x1] CPB properties are inconsistent with the requested level",
      "[mp4 @ 0x1] Buffer underflow: VBV buffer size 0 is too small for bitrate 8000000",
      "      CPB properties: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A but the stream is non-conformant"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(diagnostics);
    expect(summary).toContain("CPB properties are inconsistent with the requested level");
    expect(summary).toContain("Buffer underflow");
    expect(summary).toContain("but the stream is non-conformant");
  });

  it("keeps a genuine mp4-muxer diagnostic from the instance whose faststart line is filtered", () => {
    // Same `[mp4 @ ...]` tag, same run, real muxer complaints. None is the faststart banner.
    const warned = [
      WINDOWS_FASTSTART_CHATTER,
      "[mp4 @ 000001dbec2dbb00] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;",
      "[mp4 @ 000001dbec2dbb00] Starting second pass failed: could not seek in the output file"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(warned);
    expect(summary).toContain("Non-monotonous DTS");
    expect(summary).toContain("Starting second pass failed: could not seek in the output file");
  });

  it("stays scoped to the ISOBMFF muxers that implement faststart", () => {
    expect(summarizeSuccessfulEncodeStderr("[mov @ 0x1] Starting second pass: moving the moov atom to the beginning of the file")).toBe("");
    // A different muxer claiming the same sentence is not this banner and is not hidden.
    expect(summarizeSuccessfulEncodeStderr("[matroska @ 0x1] Starting second pass: moving the moov atom to the beginning of the file"))
      .toBe("[matroska @ [address]] Starting second pass: moving the moov atom to the beginning of the file");
  });

  it("produces identical output for two faststart runs that differ only in the instance pointer", () => {
    const secondRun = WINDOWS_FASTSTART_CHATTER.replaceAll("000001dbec2dbb00", "0000027fa41c9200");
    expect(secondRun).not.toBe(WINDOWS_FASTSTART_CHATTER);
    expect(summarizeSuccessfulEncodeStderr(secondRun)).toBe(summarizeSuccessfulEncodeStderr(WINDOWS_FASTSTART_CHATTER));
  });
});

describe("summarizeSuccessfulEncodeStderr on Matroska stream metadata", () => {
  const MATROSKA_STREAM_METADATA = [
    "      ENCODER         : Lavc60.31.102 ffv1",
    "      DURATION        : 00:00:01.500000000"
  ].join("\n");

  it("filters uppercase encoder and duration tags from a successful FFV1 segment", () => {
    expect(summarizeSuccessfulEncodeStderr(MATROSKA_STREAM_METADATA)).toBe("");
  });

  it("keeps a real Matroska muxer diagnostic beside routine stream metadata", () => {
    const warned = [
      MATROSKA_STREAM_METADATA,
      "[matroska @ 0x1] Error writing trailer: Invalid argument"
    ].join("\n");
    expect(summarizeSuccessfulEncodeStderr(warned))
      .toBe("[matroska @ [address]] Error writing trailer: Invalid argument");
  });
});
