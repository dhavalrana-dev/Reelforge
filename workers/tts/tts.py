"""REELFORGE narration worker.

Speaks each line of a script with Kokoro (local, offline) and, with --verify,
transcribes every line back with faster-whisper to catch misreadings. Word
timestamps from that check are kept for captions and scene timing.

Runs in the same Python environment as the transcription worker.
Result JSON goes to --out; progress to stderr.
"""

import argparse
import difflib
import json
import os
import re
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("REELFORGE_TTS_MODELS", os.path.join(HERE, "models"))
SAMPLE_RATE = 24000
ASR_RATE = 16000


def words_of(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def trim(samples: np.ndarray, threshold: float = 0.01, keep: float = 0.06) -> np.ndarray:
    """Cuts leading and trailing silence, keeping a short natural margin."""
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return samples
    pad = int(keep * SAMPLE_RATE)
    return samples[max(0, loud[0] - pad): min(len(samples), loud[-1] + pad)]


def write_wav(path: str, samples: np.ndarray) -> None:
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())


def to_asr_rate(samples: np.ndarray) -> np.ndarray:
    n = int(len(samples) * ASR_RATE / SAMPLE_RATE)
    return np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples).astype(np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description="Narration with Kokoro TTS")
    parser.add_argument("lines", help='JSON: [{"id", "text", "voice"?, "speed"?}]')
    parser.add_argument("out_dir")
    parser.add_argument("--out", required=True, help="result JSON")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--verify", action="store_true", help="transcribe every line back and compare")
    parser.add_argument("--whisper-model", default="base.en")
    parser.add_argument("--threshold", type=float, default=0.9, help="minimum word similarity for --verify")
    parser.add_argument("--list-voices", action="store_true")
    args = parser.parse_args()

    try:
        from kokoro_onnx import Kokoro
    except ImportError:
        print("kokoro-onnx is not installed in this Python environment", file=sys.stderr)
        return 3
    model = os.path.join(MODELS, "kokoro-v1.0.onnx")
    voices = os.path.join(MODELS, "voices-v1.0.bin")
    if not (os.path.exists(model) and os.path.exists(voices)):
        print(f"Kokoro model files missing in {MODELS} (kokoro-v1.0.onnx, voices-v1.0.bin)", file=sys.stderr)
        return 4
    kokoro = Kokoro(model, voices)
    available = sorted(kokoro.get_voices())
    if args.list_voices:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"voices": available}, f)
        return 0

    with open(args.lines, encoding="utf-8") as f:
        lines = json.load(f)
    os.makedirs(args.out_dir, exist_ok=True)

    asr = None
    if args.verify:
        from faster_whisper import WhisperModel
        asr = WhisperModel(args.whisper_model, device="auto", compute_type="default", download_root=os.environ.get("REELFORGE_MODELS"))

    results = []
    for line in lines:
        voice = line.get("voice", args.voice)
        if voice not in available:
            print(f"unknown voice {voice!r}; available: {', '.join(available)}", file=sys.stderr)
            return 5
        samples, rate = kokoro.create(line["text"], voice=voice, speed=float(line.get("speed", args.speed)), lang=args.lang)
        assert rate == SAMPLE_RATE, rate
        samples = trim(np.asarray(samples, dtype=np.float32))
        path = os.path.join(args.out_dir, f"{line['id']}.wav")
        write_wav(path, samples)
        entry = {"id": line["id"], "text": line["text"], "voice": voice, "file": path, "duration": round(len(samples) / SAMPLE_RATE, 3)}

        if asr is not None:
            segments, _ = asr.transcribe(to_asr_rate(samples), language=args.lang.split("-")[0], word_timestamps=True, condition_on_previous_text=False)
            heard_words = []
            for seg in segments:
                for w in seg.words or []:
                    if w.word.strip() and w.end > w.start:
                        heard_words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
            heard = " ".join(w["text"] for w in heard_words)
            similarity = difflib.SequenceMatcher(None, words_of(line.get("asr", line["text"])), words_of(heard)).ratio()
            entry.update({"heard": heard, "similarity": round(similarity, 3), "ok": similarity >= args.threshold, "words": heard_words})
        print(f"[{line['id']}] {entry['duration']:.2f}s {line['text'][:60]}", file=sys.stderr, flush=True)
        results.append(entry)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"sampleRate": SAMPLE_RATE, "lines": results}, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
