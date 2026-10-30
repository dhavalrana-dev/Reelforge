---
name: reelforge-ai
description: Edit recorded videos into short-form Reels (silence removal, captions, audio clean-up, motion graphics, validated MP4 export), or create motion-graphics videos from a prompt, using the local REELFORGE CLI. Use when the user asks to cut, caption, reframe or export a video file, or to make an animated explainer video.
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

1. For footage, start with `reelforge plan <file> -o <project.json> [--remove-silence] [--captions] [--enhance-audio] [--title "..."] [--lower-third "Name|Role"]`. It writes the project with cuts, transcript and audio settings. To place a scene when something is said, look up the word in `<project>.transcript.json`. Its times are in the source recording; convert them to output frames through the keep ranges. Without footage, write the project JSON yourself. Run `reelforge components` to see the components, themes and caption styles. Scene frames are output frames (after cuts).
2. Check the look with `reelforge still <project.json> --frame N -o check.png` and view the PNG before rendering the full video.
3. Run `reelforge render <project.json> -o <out.mp4>` and report its validation checks.

Prefer the built-in components. Don't write custom HTML or scripts into project files.

## Prompt to video

When the user describes a video instead of supplying footage:

1. Write a short storyboard first: one line per scene with its purpose, the component, and its length in seconds. At 30 fps, frames = seconds × 30. A 30 s Reel is about 6–8 scenes, and each needs time to read: 3–7 s.
2. Get the exact props with `reelforge schema -o project.schema.json`. `examples/prompt-to-video/how-websites-load.json` is a complete 30 s example to start from.
3. Write the project. Put a full-length `backdrop` scene first, then the content scenes; scenes listed later draw on top. Use `"transition": "cut"` only when a hard cut is intended.
4. Run `reelforge project-validate <project.json>` and fix every error it names.
5. Render a still from the middle of each scene and view them. Check that text is readable and nothing collides. In portrait, keep content above 68% of the height when captions will be added.
6. Run `reelforge render <project.json> -o <out.mp4>` and report the checks.

Keep on-screen text short (under about 8 words per line) and use the `highlight` options for the key word.

## Generative apps (optional)

Only when `reelforge doctor` reports a generative backend as OK:

1. Run `reelforge gen apps` to find an app, then `reelforge gen info <app>` for its inputs and model licences.
2. If the app shows "licence review", tell the user which models and licences are involved and get their decision before passing `--accept-license`. Never pass it on their behalf without asking.
3. Never pass `--allow-sensitive` unless the user confirms they have consent from everyone whose face, body or voice is altered.
4. Run `reelforge gen run <app> --file <input>=<path> --set <key>=<value> -o <dir>`, then use the output files like any other footage.

## Rules

- Never write the output over the source recording. The CLI refuses to do it, so don't work around that.
- Keep the output and the `.edl.json` file together, so cuts can be reviewed or redone.
- Times in `--keep` are seconds in the source recording.
