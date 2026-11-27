#!/usr/bin/env python3
"""Renders the music engine's named instruments and drum kits into multisample sets.

    build_content.py <music-content.json> <out-dir> [--probe-kits]

For each SoundFont instrument in music-content.json: FluidSynth plays every zone (a note every
`step` semitones from `low` to `high`, at each of `velocities`) and the result is cut into one
FLAC per zone. Decaying sounds run until they fall 70 dB under their peak (at most
`max_seconds`); sustained sounds are held and get a loop with a baked crossfade, so the engine's
sampler can hold them for any length. Drum kits render every pitch in their `pitches` list and
fail the build if one comes out silent. kit_909 is synthesised here; kit_lofi is kit_acoustic
through a lo-fi chain. Each folder gets zones.json, which cf-music reads.

--probe-kits prints which GM drum pitches (35-81) each SoundFont kit sounds, for filling in
`pitches`.

Runs at image build on the build machine's own architecture; nothing here runs at render time.
"""
import hashlib
import json
import math
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
from scipy.signal import lfilter

SR = 48000
GAP_SECONDS = 0.5
FLOOR_DB = -70.0


def midi_file(events, path):
    """events: [(seconds, bytes)], one track at 1000 ticks per second (tempo 1 s per beat)."""
    events = sorted(events, key=lambda e: e[0])
    track = bytearray()
    # 1,000,000 us per quarter at 1000 ticks per quarter: one tick is one millisecond.
    track += b"\x00\xff\x51\x03" + (1_000_000).to_bytes(3, "big")
    last = 0
    for t, msg in events:
        tick = int(round(t * 1000))
        delta = tick - last
        last = tick
        out = [delta & 0x7F]
        delta >>= 7
        while delta:
            out.insert(0, 0x80 | (delta & 0x7F))
            delta >>= 7
        track += bytes(out) + msg
    track += b"\x00\xff\x2f\x00"
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, 1000))
        f.write(b"MTrk" + struct.pack(">I", len(track)) + track)


def fluid_render(sf2, events, seconds):
    """Plays events through FluidSynth with no reverb or chorus; returns float32 [n, 2]."""
    with tempfile.TemporaryDirectory() as tmp:
        mid = os.path.join(tmp, "in.mid")
        raw = os.path.join(tmp, "out.raw")
        # A final event keeps the file running past the last note.
        midi_file(events + [(seconds, b"\xb0\x79\x00")], mid)
        subprocess.run(
            ["fluidsynth", "-ni", "-q", "-g", "1.0", "-R", "0", "-C", "0", "-r", str(SR),
             "-o", "synth.polyphony=1024", "-o", "synth.cpu-cores=1",
             "-F", raw, "-T", "raw", "-O", "float", "-E", "little", sf2, mid],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        data = np.fromfile(raw, dtype="<f4").reshape(-1, 2)
    return data.astype(np.float64)


def select(channel, bank, program):
    return [(0.0, bytes([0xB0 | channel, 0x00, bank >> 7 & 0x7F])),
            (0.0, bytes([0xB0 | channel, 0x20, bank & 0x7F])),
            (0.0, bytes([0xC0 | channel, program]))]


def slots(sf2, source, notes, hold, channel=0):
    """Each (pitch, velocity) in its own slot: note on, held `hold` s, then all sound off.
    Returns the audio of each slot from its note on."""
    bank, program = source["bank"], source["program"]
    events = select(channel, bank, program)
    slot = hold + GAP_SECONDS
    starts = []
    for i, (pitch, vel) in enumerate(notes):
        t = 0.25 + i * slot
        starts.append(t)
        events.append((t, bytes([0x90 | channel, pitch, vel])))
        events.append((t + hold, bytes([0x80 | channel, pitch, 0])))
        # All sound off: no release tail runs into the next slot.
        events.append((t + hold + 0.001, bytes([0xB0 | channel, 0x78, 0])))
    audio = fluid_render(sf2, events, 0.25 + len(notes) * slot + 0.5)
    out = []
    for t in starts:
        a = int(round(t * SR))
        out.append(audio[a:a + int(round(hold * SR))].copy())
    return out


def trim_start(x):
    """Drops what comes before the first sample above -100 dBFS (FluidSynth starts notes on its
    64-sample blocks, so a slot can open with a little silence)."""
    loud = np.nonzero(np.abs(x).max(axis=1) > 1e-5)[0]
    return x[loud[0]:] if len(loud) else x[:0]


def fade_out(x, seconds):
    n = min(len(x), int(seconds * SR))
    if n > 0:
        x[-n:] *= np.linspace(1.0, 0.0, n)[:, None]
    return x


def decay_cut(x, max_seconds):
    """Cut where the sound has fallen 70 dB under its peak for good, with a 10 ms fade; at most
    max_seconds (then a 300 ms fade)."""
    if not len(x):
        return x
    level = np.abs(x).max(axis=1)
    peak = level.max()
    if peak <= 0:
        return x[:0]
    above = np.nonzero(level > peak * 10 ** (FLOOR_DB / 20))[0]
    end = min(above[-1] + 1, int(max_seconds * SR))
    x = x[:end].copy()
    return fade_out(x, 0.3 if end >= int(max_seconds * SR) else 0.01)


def loop_bake(x, loop_start, loop_end, xfade):
    """Bakes a crossfade into the samples before loop_end so that jumping from loop_end back to
    loop_start continues smoothly; returns x cut at loop_end."""
    a, b, n = int(loop_start * SR), int(loop_end * SR), int(xfade * SR)
    x = x[:b].copy()
    w = np.sin(np.linspace(0, math.pi / 2, n))[:, None]
    x[b - n:b] = x[b - n:b] * np.cos(np.linspace(0, math.pi / 2, n))[:, None] + x[a - n:a] * w
    return x, a, b


def write_flac(path, x):
    """24-bit FLAC; mono when both channels are the same."""
    mono = np.max(np.abs(x[:, 0] - x[:, 1])) <= 1e-6 * max(1e-9, np.max(np.abs(x)))
    data = x[:, :1] if mono else x
    pcm = np.clip(np.round(data * 8388608.0), -8388608, 8388607).astype("<i4")
    # Little-endian 24-bit: drop each int32's top byte.
    raw = pcm.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    subprocess.run(
        ["flac", "-s", "-8", "-f", "--force-raw-format", "--endian=little", "--sign=signed",
         f"--channels={data.shape[1]}", "--bps=24", f"--sample-rate={SR}", "--no-seektable",
         "-o", path, "-"],
        input=raw, check=True)
    return 1 if mono else 2


# The content file's peak_db: the level every instrument's and kit's loudest note is recorded at.
# -12 dBFS leaves room for chords and for several parts at gain 0 before anything goes over full
# scale: an agent cannot hear clipping, and a render that clipped cannot be turned back down.
PEAK_DB = -12.0


def normalise(zones, peak_db=None):
    """One gain for the whole instrument so that its loudest zone peaks at peak_db: instruments
    sit at comparable levels and keep the SoundFont's balance between their own notes."""
    if peak_db is None:
        peak_db = PEAK_DB
    peak = max(float(np.max(np.abs(z["audio"]))) for z in zones if len(z["audio"]))
    gain = 10 ** (peak_db / 20) / peak
    for z in zones:
        z["audio"] = z["audio"] * gain
    return 20 * math.log10(gain)


def velocity_ranges(velocities):
    """Each layer covers the velocities nearest to it."""
    out = []
    for i, v in enumerate(velocities):
        lo = 1 if i == 0 else (velocities[i - 1] + v) // 2 + 1
        hi = 127 if i == len(velocities) - 1 else (v + velocities[i + 1]) // 2
        out.append((v, lo, hi))
    return out


def save(out_dir, name, zones, extra):
    folder = os.path.join(out_dir, name)
    os.makedirs(folder, exist_ok=True)
    listed = []
    for z in zones:
        file = f"{z['root']:03d}-{z['vel']:03d}.flac"
        channels = write_flac(os.path.join(folder, file), z["audio"])
        entry = {k: z[k] for k in ("root", "lo", "hi", "vel", "vlo", "vhi")}
        entry.update(file=file, channels=channels, frames=len(z["audio"]))
        if z.get("loop"):
            entry["loop"] = z["loop"]
        listed.append(entry)
    doc = {"name": name, "sample_rate": SR, "zones": listed, **extra}
    with open(os.path.join(folder, "zones.json"), "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    size = sum(os.path.getsize(os.path.join(folder, e["file"])) for e in listed)
    print(f"{name}: {len(listed)} zones, {size / 1e6:.1f} MB", flush=True)


def instrument(sf2, name, spec, out_dir):
    roots = list(range(spec["low"], spec["high"] + 1, spec["step"]))
    if roots[-1] != spec["high"]:
        roots.append(spec["high"])
    hold = spec["max_seconds"] + (1.0 if spec["sustain"] else 0.0)
    notes = [(r, v) for r in roots for (v, _, _) in velocity_ranges(spec["velocities"])]
    audio = slots(sf2, spec["source"], notes, hold)
    zones = []
    layers = {v: (lo, hi) for (v, lo, hi) in velocity_ranges(spec["velocities"])}
    for i, ((root, vel), x) in enumerate(zip(notes, audio)):
        x = trim_start(x)
        k = roots.index(root)
        lo = spec["low"] if k == 0 else (roots[k - 1] + root) // 2 + 1
        hi = spec["high"] if k == len(roots) - 1 else (root + roots[k + 1]) // 2
        zone = {"root": root, "lo": lo, "hi": hi, "vel": vel, "vlo": layers[vel][0],
                "vhi": layers[vel][1]}
        if spec["sustain"]:
            # Loop the steady part: from 1.5 s to the end, with a 250 ms crossfade.
            end = min(len(x), int(spec["max_seconds"] * SR)) / SR
            x, a, b = loop_bake(x, 1.5, end, 0.25)
            zone["loop"] = [a, b]
        else:
            x = decay_cut(x, spec["max_seconds"])
        if not len(x) or np.max(np.abs(x)) < 1e-4:
            sys.exit(f"{name}: zone {root} at velocity {vel} is silent")
        zone["audio"] = x
        zones.append(zone)
    gain = normalise(zones)
    save(out_dir, name, zones, {"kind": "instrument", "gain_db": round(gain, 3)})


def kit_hits(sf2, spec, pitches):
    notes = [(p, v) for p in pitches for v in spec["velocities"]]
    audio = slots(sf2, spec["source"], notes, spec["max_seconds"] + 0.5, channel=9)
    out = {}
    for (p, v), x in zip(notes, audio):
        out[(p, v)] = decay_cut(trim_start(x), spec["max_seconds"])
    return out


def kit_zones(hits, spec):
    layers = velocity_ranges(spec["velocities"])
    zones = []
    for (p, v), x in sorted(hits.items()):
        _, vlo, vhi = next(layer for layer in layers if layer[0] == v)
        if not len(x) or np.max(np.abs(x)) < 1e-4:
            sys.exit(f"kit pitch {p} at velocity {v} is silent")
        zones.append({"root": p, "lo": p, "hi": p, "vel": v, "vlo": vlo, "vhi": vhi,
                      "audio": x})
    return zones


def probe_kits(sf2, content):
    for name, spec in content["kits"].items():
        if "source" not in spec:
            continue
        hits = kit_hits(sf2, {**spec, "velocities": [100], "max_seconds": 1.0}, range(35, 82))
        found = [p for (p, _), x in sorted(hits.items()) if len(x) and np.max(np.abs(x)) > 1e-3]
        print(name, found)


# kit_909: synthesis -----------------------------------------------------------------------

def env_exp(n, seconds):
    t = np.arange(n) / SR
    return np.exp(-t / seconds)


def osc_sine(freq_curve):
    return np.sin(2 * np.pi * np.cumsum(freq_curve) / SR)


def onepole_hp(x, hz):
    a = math.exp(-2 * math.pi * hz / SR)
    return lfilter([a, -a], [1, -a], x)


def biquad(x, kind, hz, q):
    w = 2 * math.pi * hz / SR
    alpha = math.sin(w) / (2 * q)
    c = math.cos(w)
    if kind == "bp":
        b = [alpha, 0, -alpha]
    elif kind == "hp":
        b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    else:
        b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
    a = [1 + alpha, -2 * c, 1 - alpha]
    return lfilter(b, a, x)


def metal(n, rng):
    """The 808/909 metallic source: six detuned square waves."""
    t = np.arange(n) / SR
    freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]
    return sum(np.sign(np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))) for f in freqs) / 6


def synth_909(pitch, rng):
    n = int(1.2 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)

    def tom(f0, f1, decay):
        freq = f1 + (f0 - f1) * np.exp(-t / 0.05)
        return osc_sine(freq) * env_exp(n, decay) + 0.05 * biquad(noise, "lp", 3000, 0.7) * env_exp(n, 0.02)

    if pitch in (35, 36):
        base = 50 if pitch == 35 else 55
        freq = base + 190 * np.exp(-t / 0.035)
        body = osc_sine(freq) * env_exp(n, 0.32)
        click = biquad(noise, "hp", 1200, 0.7) * env_exp(n, 0.004) * 0.5
        return np.tanh(1.6 * (body + click))
    if pitch == 37:
        x = biquad(noise, "bp", 1700, 4) * env_exp(n, 0.012) * 3 + osc_sine(np.full(n, 500.0)) * env_exp(n, 0.01)
        return x
    if pitch in (38, 40):
        tone = (osc_sine(np.full(n, 180.0)) * 0.6 + osc_sine(np.full(n, 330.0)) * 0.4) * env_exp(n, 0.08)
        snappy = biquad(noise, "hp", 1800 if pitch == 38 else 2500, 0.7) * env_exp(n, 0.13 if pitch == 38 else 0.09)
        return 0.7 * tone + 0.6 * snappy
    if pitch == 39:
        bursts = np.zeros(n)
        for k, start in enumerate((0.0, 0.011, 0.022, 0.032)):
            s = int(start * SR)
            decay = 0.006 if k < 3 else 0.12
            bursts[s:] += env_exp(n - s, decay)
        return biquad(noise, "bp", 1100, 1.6) * bursts * 1.6
    if pitch in (42, 44):
        x = biquad(onepole_hp(metal(n, rng) + 0.3 * noise, 6000), "bp", 10000, 1.0)
        return x * env_exp(n, 0.035 if pitch == 42 else 0.05) * 2.5
    if pitch == 46:
        x = biquad(onepole_hp(metal(n, rng) + 0.3 * noise, 6000), "bp", 10000, 1.0)
        return x * env_exp(n, 0.32) * 2.5
    if pitch in (49, 57):
        m = int(2.5 * SR)
        noise2 = rng.standard_normal(m)
        x = onepole_hp(metal(m, rng) * 0.6 + noise2 * 0.6, 4500)
        return biquad(x, "lp", 14000, 0.7) * env_exp(m, 0.9 if pitch == 49 else 0.7)
    if pitch in (51, 59):
        m = int(2.5 * SR)
        x = biquad(onepole_hp(metal(m, rng) + 0.15 * rng.standard_normal(m), 3000), "bp", 7000, 1.2)
        return x * env_exp(m, 0.8) * 1.5
    toms = {41: (180, 70, 0.32), 43: (200, 85, 0.3), 45: (230, 100, 0.28), 47: (260, 120, 0.26),
            48: (300, 140, 0.24), 50: (340, 165, 0.22)}
    if pitch in toms:
        return tom(*toms[pitch])
    raise ValueError(pitch)


def kit_909(spec):
    rng = np.random.default_rng(909)
    zones = []
    for p in spec["pitches"]:
        x = synth_909(p, rng)
        stereo = np.stack([x, x], axis=1)
        zones.append({"root": p, "lo": p, "hi": p, "vel": 127, "vlo": 1, "vhi": 127,
                      "audio": decay_cut(stereo, spec["max_seconds"])})
    return zones


def lofi(x):
    """26.04 kHz sample-and-hold, 12 bits, tanh saturation, one-pole 9 kHz low-pass."""
    n = len(x)
    held = np.floor(np.arange(n) * 26040 / SR) * SR / 26040
    idx = np.minimum(np.round(held).astype(int), n - 1)
    y = x[idx]
    y = np.round(y * 2047) / 2047
    y = np.tanh(y * 1.6) / np.tanh(1.6)
    a = math.exp(-2 * math.pi * 9000 / SR)
    return lfilter([1 - a], [1, -a], y, axis=0)


def main():
    content_path, out_dir = sys.argv[1], sys.argv[2]
    content = json.load(open(content_path))
    global PEAK_DB
    PEAK_DB = float(content["peak_db"])
    sf = content["soundfont"]
    sf2 = sf["file"]
    digest = hashlib.sha256(open(sf2, "rb").read()).hexdigest()
    if digest != sf["sha256"]:
        sys.exit(f"{sf2}: sha256 {digest}, expected {sf['sha256']}")
    if "--probe-kits" in sys.argv:
        probe_kits(sf2, content)
        return
    only = os.environ.get("CF_MUSIC_ONLY", "").split(",") if os.environ.get("CF_MUSIC_ONLY") else None
    os.makedirs(out_dir, exist_ok=True)
    for name, spec in content["instruments"].items():
        if "synth" in spec or (only and name not in only):
            continue
        instrument(sf2, name, spec, out_dir)
    choke = content["choke_groups"]
    rendered = {}
    for name, spec in content["kits"].items():
        if only and name not in only and not (name == "kit_acoustic" and "kit_lofi" in only):
            continue
        if "source" in spec:
            rendered[name] = kit_hits(sf2, spec, spec["pitches"])
            zones = kit_zones(rendered[name], spec)
        elif spec.get("synthesised"):
            zones = kit_909(spec)
        else:
            base = rendered[spec["derived_from"]]
            zones = kit_zones({k: lofi(v) for k, v in base.items() if k[0] in spec["pitches"]}, spec)
        if only and name not in only:
            continue
        gain = normalise(zones)
        save(out_dir, name, zones, {"kind": "kit", "one_shot": True, "choke_groups": choke,
                                    "gain_db": round(gain, 3)})
    if only:
        return
    manifest = {
        "sample_rate": SR,
        "instruments": [n for n, s in content["instruments"].items() if "synth" not in s],
        "kits": list(content["kits"]),
        "presets": {n: s["synth"] for n, s in content["instruments"].items() if "synth" in s},
        "soundfont_sha256": sf["sha256"],
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
