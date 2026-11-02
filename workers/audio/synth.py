"""REELFORGE procedural audio: a music bed and sound effects, made from code.

Nothing is sampled, so the output carries no third-party licence. Every
sound is a deterministic function of its parameters and seed.

    synth.py music out.wav --seconds 30 --mood calm --seed 1
    synth.py sfx whoosh out.wav
"""

import argparse
import sys
import wave

import numpy as np

RATE = 48000


def write_stereo(path: str, left: np.ndarray, right: np.ndarray, peak_db: float = -3.0) -> None:
    stereo = np.stack([left, right], axis=1)
    peak = np.max(np.abs(stereo)) or 1.0
    stereo = stereo / peak * (10 ** (peak_db / 20))
    pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def midi_hz(note: float) -> float:
    return 440.0 * 2 ** ((note - 69) / 12)


def envelope(n: int, attack: float, release: float) -> np.ndarray:
    env = np.ones(n)
    a = min(n, int(attack * RATE))
    r = min(n - a, int(release * RATE))
    if a:
        env[:a] = np.linspace(0, 1, a)
    if r:
        env[n - r:] = np.linspace(1, 0, r)
    return env


def tone(freq: float, n: int, harmonics: tuple[float, ...], detune: float = 0.0, phase: float = 0.0) -> np.ndarray:
    """Additive tone: a few soft harmonics only, so no filter is needed."""
    t = np.arange(n) / RATE
    out = np.zeros(n)
    for k, amp in enumerate(harmonics, start=1):
        out += amp * np.sin(2 * np.pi * freq * k * (1 + detune) * t + phase * k)
    return out


# Chord roots and qualities (semitones over the root), one chord per two bars.
PROGRESSIONS = {
    "calm": [(57, (0, 3, 7, 10)), (53, (0, 4, 7, 11)), (48, (0, 4, 7, 11)), (55, (0, 4, 7, 9))],     # Am7 Fmaj7 Cmaj7 G6
    "upbeat": [(48, (0, 4, 7)), (55, (0, 4, 7)), (57, (0, 3, 7)), (53, (0, 4, 7))],                 # C G Am F
    "tense": [(50, (0, 3, 7)), (46, (0, 4, 7)), (53, (0, 4, 7)), (52, (0, 4, 7, 10))],               # Dm Bb F E7
}
TEMPO = {"calm": 76, "upbeat": 112, "tense": 92}


def music(seconds: float, mood: str, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    n_total = int(seconds * RATE)
    left = np.zeros(n_total)
    right = np.zeros(n_total)
    beat = 60.0 / TEMPO[mood]
    chord_len = beat * 8
    progression = PROGRESSIONS[mood]
    t0 = 0.0
    i = 0
    while t0 < seconds:
        root, quality = progression[i % len(progression)]
        start = int(t0 * RATE)
        n = min(int(chord_len * RATE) + int(1.2 * RATE), n_total - start)  # overlap into the next chord
        if n <= 0:
            break
        # Pad: each chord note as a slow, slightly detuned pair, spread across the stereo field.
        for j, interval in enumerate(quality):
            f = midi_hz(root + 12 + interval)
            v = tone(f, n, (1.0, 0.35, 0.12), detune=0.0015, phase=rng.uniform(0, 6.28))
            v += tone(f, n, (1.0, 0.3, 0.1), detune=-0.0015, phase=rng.uniform(0, 6.28))
            v *= envelope(n, 0.9, 1.4) * 0.11
            pan = (j / max(1, len(quality) - 1)) * 0.6 - 0.3
            left[start:start + n] += v * (0.5 - pan)
            right[start:start + n] += v * (0.5 + pan)
        # Bass on beats 1 and 3 (every beat when upbeat), plucked.
        step = beat if mood == "upbeat" else beat * 2
        b = 0.0
        while b < chord_len:
            bs = start + int(b * RATE)
            bn = min(int(step * RATE), n_total - bs)
            if bn > 0:
                bass = tone(midi_hz(root - 12), bn, (1.0, 0.5, 0.2)) * np.exp(-np.arange(bn) / RATE * 3.0) * 0.32
                left[bs:bs + bn] += bass
                right[bs:bs + bn] += bass
            b += step
        # Light pulse for upbeat and tense: short filtered-noise ticks on eighth notes.
        if mood in ("upbeat", "tense"):
            e = 0.0
            while e < chord_len:
                es = start + int(e * RATE)
                en = min(int(0.05 * RATE), n_total - es)
                if en > 0:
                    noise = np.diff(rng.standard_normal(en + 1)) * np.exp(-np.arange(en) / RATE * 80) * 0.05
                    left[es:es + en] += noise
                    right[es:es + en] += noise
                e += beat / 2
        t0 += chord_len
        i += 1
    fade = envelope(n_total, 1.0, 2.0)
    return left * fade, right * fade


def sfx(kind: str, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    if kind == "whoosh":
        n = int(0.7 * RATE)
        noise = rng.standard_normal(n)
        # Time-varying one-pole low-pass sweeping up then down, under a swell.
        cutoff = 300 + 5000 * np.sin(np.linspace(0, np.pi, n)) ** 2
        alpha = 1 - np.exp(-2 * np.pi * cutoff / RATE)
        out = np.zeros(n)
        y = 0.0
        for k in range(n):
            y += alpha[k] * (noise[k] - y)
            out[k] = y
        out *= np.sin(np.linspace(0, np.pi, n)) ** 1.5
        pan = np.linspace(-0.6, 0.6, n)
        return out * (0.5 - pan / 2), out * (0.5 + pan / 2)
    if kind == "pop":
        n = int(0.14 * RATE)
        t = np.arange(n) / RATE
        freq = 900 * np.exp(-t * 18) + 220
        out = np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t * 30)
        return out, out
    if kind == "tick":
        n = int(0.03 * RATE)
        out = np.diff(rng.standard_normal(n + 1)) * np.exp(-np.arange(n) / RATE * 300)
        return out, out
    if kind == "rise":
        n = int(1.2 * RATE)
        t = np.arange(n) / RATE
        out = np.sin(2 * np.pi * np.cumsum(200 + 800 * (t / t[-1]) ** 2) / RATE) * (t / t[-1]) ** 2 * 0.6
        out += np.diff(rng.standard_normal(n + 1)) * (t / t[-1]) ** 3 * 0.15
        return out, out
    raise SystemExit(f"unknown sound {kind!r}; one of whoosh, pop, tick, rise")


def main() -> int:
    parser = argparse.ArgumentParser(description="Procedural music and sound effects")
    sub = parser.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("music")
    m.add_argument("out")
    m.add_argument("--seconds", type=float, required=True)
    m.add_argument("--mood", choices=sorted(PROGRESSIONS), default="calm")
    m.add_argument("--seed", type=int, default=1)
    s = sub.add_parser("sfx")
    s.add_argument("kind", choices=["whoosh", "pop", "tick", "rise"])
    s.add_argument("out")
    s.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    if args.cmd == "music":
        if not 1 <= args.seconds <= 600:
            raise SystemExit("--seconds must be between 1 and 600")
        write_stereo(args.out, *music(args.seconds, args.mood, args.seed))
    else:
        write_stereo(args.out, *sfx(args.kind, args.seed), peak_db=-1.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
