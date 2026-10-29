# REELFORGE AI (working name)

Video editing and programmatic video for AI coding agents. This is the start of the
first 30-day sprint from the product blueprint: a deterministic, tested foundation for
the recorded-video workflow.

## Status

| Area | State |
| --- | --- |
| Monorepo (npm workspaces, TypeScript, Vitest) | Done |
| `@reelforge/core` project schema (Zod) + semantic validation | Done |
| `@reelforge/core` timeline: frame-snapped cuts, source↔output mapping, caption remapping | Done |
| `@reelforge/core` animation: easings, cubic-bezier, mapRange, closed-form spring, keyframes | Done |
| `@reelforge/media` FFprobe ingestion (rotation, VFR, orientation warnings) | Done |
| `@reelforge/media` silence detection, cut rendering with reframing, output validation | Done |
| CLI: `doctor`, `inspect`, `silence`, `transcribe`, `edit`, `validate`, `project-validate` | Done |
| Transcription worker (faster-whisper, audio decoded by our FFmpeg) | Done |
| Word-highlighted captions remapped through cuts, burned in via libass (`clean-pro`, `bold-creator`) | Done |
| `@reelforge/motion` components: `kinetic-text`, `lower-third`, `network-diagram`, `counter`, `rect`, `backdrop`; themes `dark-tech`, `clean-pro` | Done |
| `@reelforge/renderer` Chromium frame renderer, streamed into FFmpeg over footage or a background | Done |
| CLI: `render`, `still`, `components` | Done |
| Audio clean-up: high-pass, denoise, noise-floor-driven expander, compression, loudness target with peak limiting; loudness and clipping checks | Done |
| Audio enhancement (loudness normalisation, denoise) | Not started |

## Usage

Requires Node.js 20+ and FFmpeg/FFprobe on `PATH` (or `REELFORGE_FFMPEG` / `REELFORGE_FFPROBE`).
Captions also need FFmpeg built with libass, and the transcription worker:

```bash
python -m venv workers/transcribe/.venv
workers/transcribe/.venv/Scripts/python -m pip install -r workers/transcribe/requirements.txt
```

The CLI finds that venv automatically (override with `REELFORGE_PYTHON`). Whisper models download on first use
(set `REELFORGE_MODELS` to choose the cache folder).

```bash
npm install
npm test
npm run reelforge -- doctor
npm run reelforge -- inspect recording.mp4
npm run reelforge -- edit recording.mp4 -o reel.mp4 --remove-silence --format 9:16
npm run reelforge -- edit recording.mp4 -o reel.mp4 --remove-silence --captions --caption-style bold-creator
```

`edit` never touches the source. It writes the MP4, plus a `.edl.json` edit decision list
(detected silences, the resolved timeline and the caption pages) next to it, and then validates the export.
With `--captions` it also keeps the source-time `.transcript.json` and the `.captions.ass` file. Pass
`--transcript` to re-cut or restyle without transcribing again. The checks cover resolution, frame rate, duration, A/V length, and a full decode.

## Plan, review, render

`edit` is the one-step path. For anything with graphics, `plan` writes a reviewable project file
first (the edit plan from blueprint §7, stage B). An agent or a person can adjust it, preview single
frames, then render:

```bash
npm run reelforge -- plan recording.mp4 -o reel.json --remove-silence --captions --enhance-audio \
  --title "How a website loads" --lower-third "Ada Lovelace|Systems engineer"
npm run reelforge -- still reel.json --frame 30 -o check.png
npm run reelforge -- render reel.json -o reel.mp4
```

The project holds frame-snapped keep ranges, a link to the saved transcript, audio settings and
starter scenes. Paths in it are relative to the project file.

### Repeatable demo

```bash
npm run demo                        # synthesises a talking-head recording (Windows TTS + room noise)
npm run demo -- path/to/video.mp4   # or uses yours
```

The demo plans the recording, adds a diagram timed to the moment the speaker says "browser",
renders preview stills, then renders and validates the Reel. Output goes to `out/demo/`. On this
machine, a 26.6 s recording becomes a 13.6 s Reel in about 45 s end to end.

## Audio clean-up

```bash
npm run reelforge -- edit recording.mp4 -o reel.mp4 --remove-silence --enhance-audio
npm run reelforge -- edit recording.mp4 -o reel.mp4 --enhance-audio --loudness -16 --denoise strong
```

In a project file, add `"audio": { "loudness": -14, "denoise": "light" }`. All fields are optional:
`truePeak`, `highpass`, `compress` and `expand` are the others.

The chain is a high-pass filter (80 Hz), spectral denoising, a soft expander, a 3:1 compressor,
make-up gain and a peak limiter. Everything is measured on the edited audio (cuts applied), in fast
audio-only passes:

1. Noise profile: the 10th and 50th percentiles of 100 ms RMS windows, after denoising.
2. The expander threshold is set 10 dB above the noise floor, never above -30 dBFS. The expander is
   skipped when that would come within 6 dB of typical speech, so words are never attenuated. Pauses
   are lowered by at most 18 dB rather than muted.
3. Loudness is measured, gain is applied with the limiter, loudness is measured again, and the gain
   is corrected once.

With audio enhancement on, silence detection also runs on the denoised signal, so hiss doesn't hide
pauses. Every export is checked for clipping (true peak above 0 dBTP, or above the target ceiling);
enhanced exports are also checked against the loudness target (±1 LU).

Findings that shaped this:
- FFmpeg's `afftdn` removes only about 5 dB of broadband noise, even with a sampled noise profile.
  The expander does the heavy lifting in pauses: about 16 dB more on the test fixture.
- `loudnorm` falls back to dynamic mode when the gain a quiet clip needs would exceed the peak
  ceiling, and then undershoots on short clips (-15.4 LUFS for a -14 target).
- `anlmdn` crashed in this FFmpeg build and isn't used.

## Motion graphics

A project file describes scenes on the output timeline (in frames). With an `edit`, the graphics are
composited over the cut footage; without one, over the `background` colour. Captions come from
`captions.transcript`.

```json
{
  "schemaVersion": "1.0",
  "project": { "name": "Demo", "width": 1080, "height": 1920, "fps": 30 },
  "theme": "dark-tech",
  "sources": [{ "id": "cam", "path": "recording.mp4" }],
  "edit": { "sourceId": "cam", "keep": [{ "start": 0, "end": 12.4 }, { "start": 14.1, "end": 30 }] },
  "captions": { "transcript": "recording.transcript.json", "style": "clean-pro" },
  "scenes": [
    { "id": "name", "startFrame": 15, "durationFrames": 90,
      "components": [{ "type": "lower-third", "title": "Ada Lovelace", "subtitle": "Systems engineer" }] }
  ]
}
```

```bash
npm run reelforge -- components
npm run reelforge -- still project.json --frame 60 -o check.png
npm run reelforge -- render project.json -o reel.mp4
```

Components are React functions of the frame number. They're rendered to HTML in Node, so the
browser only lays out and rasterises. Frames are captured as PNGs over CDP, decoded to raw RGBA by
a separate FFmpeg stage, and streamed into the compositor. Memory stays bounded and frames are
never written to disk. Frames where nothing has changed (static holds, gaps between scenes) are
painted once and reused.

## Design rules

- All timeline positions are integer frames at the project fps. Cuts are snapped to that grid,
  and video is resampled to the output fps *before* trimming, so the rendered cuts land exactly
  where the timeline says.
- Animation functions are pure functions of the frame number (no wall clock, no simulation
  state), so frames can render in any order or in parallel.
- Every ffmpeg call goes through `spawn` without a shell.
- Overlay frames reach the compositor as raw RGBA. Chromium encodes fully opaque frames as RGB
  PNGs, and that mid-stream format change made FFmpeg rebuild the graph and drop everything after
  the next cut. `packages/renderer/test` covers this.

## Notes

- Use `base` or larger Whisper models. `tiny` dropped words in testing. Whisper word starts can drift early after
  a pause; removing the silence trims them back to where speech resumes.
- Captions use system fonts (Arial, Arial Black) for now. Bundled fonts need a license review first.
- Rendering uses the system Edge or Chrome unless `REELFORGE_CHROMIUM` is set. The installer should
  ship a pinned Chromium (plus licensed fonts) so frames are identical on every machine.
- Rendering speed on this machine (1080x1920): about 15 fps for a 9 s full-screen explainer with 4
  workers. Each worker is a separate browser process, because pages inside one browser share a
  capture pipeline. Full-frame animated backgrounds are the slowest case, since gradient dithering
  compresses badly.
- `still` doesn't draw captions yet.
- In portrait frames, components keep their content above `CAPTION_ZONE_TOP` (68% of the height),
  so burned-in captions never cover them.
- Packages export TypeScript sources directly (run via `tsx`/Vitest). A compiled build step
  is needed before packaging the installer.
- The blueprint specified pnpm. npm workspaces are used for now because pnpm isn't installed.
  Switching later is a small change.
- `reelforge doctor` reports the FFmpeg license configuration. The FFmpeg build found on this
  machine is GPL (libx264). That is fine for development but must be resolved before
  redistribution (blueprint §12).
