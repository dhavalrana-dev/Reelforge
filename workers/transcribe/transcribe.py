"""REELFORGE transcription worker.

Transcribes a media file with faster-whisper and writes word-level timestamps
as UTF-8 JSON. Progress goes to stderr; the result only ever goes to --out, so
console encoding can't corrupt it.
"""

import argparse
import json
import os
import subprocess
import sys
import time

SAMPLE_RATE = 16000


def decode_audio(path: str):
    """Decodes to 16 kHz mono float32 with the same FFmpeg the renderer uses."""
    import numpy as np

    ffmpeg = os.environ.get("REELFORGE_FFMPEG", "ffmpeg")
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode audio: {proc.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(proc.stdout, dtype=np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description="Word-level transcription with faster-whisper")
    parser.add_argument("input")
    parser.add_argument("--out", required=True, help="path of the JSON file to write")
    parser.add_argument("--model", default="base", help="tiny, base, small, medium, large-v3, or a local model path")
    parser.add_argument("--language", default=None, help="ISO code; omit to auto-detect")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--vad", action="store_true", help="skip non-speech with Silero VAD")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed in this Python environment", file=sys.stderr)
        return 3

    started = time.time()
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=os.environ.get("REELFORGE_MODELS"),
    )
    try:
        audio = decode_audio(args.input)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 4

    segments, info = model.transcribe(
        audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=args.vad,
        condition_on_previous_text=False,
    )

    out_segments = []
    words = []
    for seg in segments:
        out_segments.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()})
        for w in seg.words or []:
            text = w.word.strip()
            if not text or w.end <= w.start:
                continue
            words.append({
                "text": text,
                "start": round(w.start, 3),
                "end": round(w.end, 3),
                "probability": round(w.probability, 3),
            })
        print(f"[{seg.end:7.2f}s / {info.duration:.2f}s] {seg.text.strip()}", file=sys.stderr, flush=True)

    result = {
        "schemaVersion": "1.0",
        "source": os.path.abspath(args.input),
        "model": args.model,
        "language": info.language,
        "languageProbability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "processingSeconds": round(time.time() - started, 2),
        "segments": out_segments,
        "words": words,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
