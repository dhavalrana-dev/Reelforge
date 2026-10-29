---
name: reelforge-ai
description: Edit recorded videos into short-form Reels (silence removal, reframing to 9:16/16:9/1:1, validated MP4 export) using the local REELFORGE CLI. Use when the user asks to cut, tighten, reframe, or export a video file.
---

# REELFORGE AI

This skill is a thin layer over the `reelforge` CLI. Do the work with the CLI. Don't hand-write ffmpeg commands.

## Workflow

1. `reelforge doctor` checks the toolchain. If anything reports FAIL, stop and tell the user what to install.
2. `reelforge inspect <file>` reads the input. Mention any warnings, such as variable frame rate, rotation, or missing audio.
3. Optionally run `reelforge silence <file>` to preview what would be cut, and confirm with the user if more than about 30% of the duration would be removed.
4. Run `reelforge edit <file> -o <out.mp4> [--remove-silence] [--keep "a-b,c-d"] [--format 9:16|16:9|1:1] [--fps 30]`.
   - For subtitles, add `--captions [--caption-style clean-pro|bold-creator] [--language en]`.
   - For better sound, add `--enhance-audio`, which denoises, levels and normalises to -14 LUFS. Use `--denoise strong` for noisy rooms, and `--loudness -16` for podcasts or YouTube long-form.
   - To restyle or re-cut a video that already has captions, pass `--transcript <out>.transcript.json` so it isn't transcribed again.
5. Report the validation checks printed by `edit`, and point the user to the `.edl.json` file for reviewing the cuts.

## Motion graphics

For graphics over footage, or a video built only from graphics:

1. Write a project JSON file. Run `reelforge components` to see the components, themes and caption styles. Scene frames are output frames (after cuts).
2. Check the look with `reelforge still <project.json> --frame N -o check.png` and view the PNG before rendering the full video.
3. Run `reelforge render <project.json> -o <out.mp4>` and report its validation checks.

Prefer the built-in components. Don't write custom HTML or scripts into project files.

## Rules

- Never write the output over the source recording. The CLI refuses to do it, so don't work around that.
- Keep the output and the `.edl.json` file together, so cuts can be reviewed or redone.
- Times in `--keep` are seconds in the source recording.
