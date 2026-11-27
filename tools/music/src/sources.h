// Sound sources for cf-music: the synth, the sampler (user media, named instruments and drum
// kits) and audio clips. Each instrument plays every note of its part, from the note list, at
// the note's exact pitch (decimals included) and sample.
#pragma once

#include "dsp.h"
#include <map>
#include <memory>
#include <string>

namespace cf
{
struct Note
{
    double start, length, pitch;
    int velocity;
};

/** Decoded audio: one or two channels at their own rate. */
struct Audio
{
    double rate = 48000;
    std::vector<float> left, right; // right empty when mono
    int64_t frames() const { return (int64_t) left.size(); }
    const float* channel (int c) const { return c == 1 && ! right.empty() ? right.data() : left.data(); }
};

/** 4-point cubic Hermite read; exact at whole positions. Outside [0, n) reads silence. */
inline double hermite (const float* d, int64_t n, double pos)
{
    const auto i = (int64_t) std::floor (pos);
    const double f = pos - (double) i;
    auto s = [&] (int64_t k) { return k >= 0 && k < n ? (double) d[k] : 0.0; };
    const double x0 = s (i);
    if (f == 0) return x0;
    const double xm1 = s (i - 1), x1 = s (i + 1), x2 = s (i + 2);
    const double c1 = 0.5 * (x1 - xm1);
    const double c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const double c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
}

inline double pitchHz (double pitch) { return 440.0 * std::pow (2.0, (pitch - 69.0) / 12.0); }

//==============================================================================
/** Base for instruments: keeps the sorted note list and starts voices at their samples. */
template <typename Voice>
struct Instrument : Processor
{
    std::vector<Note> notes; // sorted by start
    double sr = 48000;
    size_t next = 0;
    std::vector<Voice> voices;

    bool generates() const override { return true; }
    void prepare (double s) override { sr = s; next = 0; voices.clear(); }

    virtual bool start (Voice& v, size_t index, int64_t startSample) = 0;
    /** Adds the voice into L and R from sample `from` for n samples; false once it has ended. */
    virtual bool render (Voice& v, float* L, float* R, int n, int64_t from) = 0;
    virtual void started (size_t) {}

    void process (float* L, float* R, int n, int64_t pos) override
    {
        const int64_t end = pos + n;
        // Start the notes whose first sample falls before this block's end, each at its sample.
        while (next < notes.size())
        {
            const auto s = (int64_t) std::llround (notes[next].start * sr);
            if (s >= end) break;
            int at = (int) std::max<int64_t> (0, s - pos);
            if (at > 0)
                renderAll (L, R, at, pos);
            Voice v;
            if (start (v, next, s))
            {
                started (next);
                voices.push_back (std::move (v));
            }
            ++next;
            // Render the block from `at` onward with the new voice included (below).
            L += at; R += at; n -= at; pos += at;
        }
        renderAll (L, R, n, pos);
    }

    void renderAll (float* L, float* R, int n, int64_t pos)
    {
        if (n <= 0) return;
        for (size_t i = 0; i < voices.size();)
        {
            if (render (voices[i], L, R, n, pos)) ++i;
            else voices.erase (voices.begin() + (long) i);
        }
    }
};

//==============================================================================
enum class Wave { sine, saw, square, triangle, noise };

struct Oscillator
{
    Wave wave;
    int octave;
    Param detune, level;
};

struct SynthVoice
{
    size_t note = 0;
    int64_t start = 0;
    double length = 0, from = 0, glide = 0, amount = 0, vel = 1;
    std::array<double, 8> phase {};
    Adsr amp, fenv;
    SlopeFilter filter;
    uint32_t noise = 1;
};

/** Oscillators (band-limited saw and square, sine, triangle, seeded noise), an optional filter
    with its envelope, the amp envelope, glide from the note before. Every phase starts at 0. */
struct Synth : Instrument<SynthVoice>
{
    std::vector<Oscillator> oscs;
    bool hasFilter = false;
    FilterType filterType = FilterType::lowpass;
    int filterSlope = 12;
    Param cutoff, resonance;
    Param ampA, ampD, ampS, ampR;
    bool hasFilterEnv = false;
    Param fA, fD, fS, fR, fAmount;
    Param glide, gain;
    uint32_t seed = 1;

    bool start (SynthVoice& v, size_t index, int64_t s) override
    {
        const auto& n = notes[index];
        const double t = n.start;
        v.note = index;
        v.start = s;
        v.length = n.length;
        v.amp = { ampA.at (t) * 0.001, ampD.at (t) * 0.001, ampS.at (t), ampR.at (t) * 0.001 };
        if (hasFilterEnv)
        {
            v.fenv = { fA.at (t) * 0.001, fD.at (t) * 0.001, fS.at (t), fR.at (t) * 0.001 };
            v.amount = 1;
        }
        v.glide = glide.at (t) * 0.001;
        v.from = index > 0 ? notes[index - 1].pitch : n.pitch;
        v.vel = velocityGain (n.velocity);
        if (hasFilter)
        {
            v.filter.configure (filterType, filterSlope);
            v.filter.set (cutoff.at (t), resonance.at (t), sr);
        }
        // Noise is seeded by the device and the note, so it is the same every render.
        v.noise = seed * 2654435761u ^ (uint32_t) (index * 40503u + 1u);
        if (v.noise == 0) v.noise = 1;
        return true;
    }

    static double blep (double t, double dt)
    {
        if (t < dt) { t /= dt; return t + t - t * t - 1.0; }
        if (t > 1.0 - dt) { t = (t - 1.0) / dt; return t * t + t + t + 1.0; }
        return 0.0;
    }

    bool render (SynthVoice& v, float* L, float* R, int n, int64_t pos) override
    {
        const auto& note = notes[v.note];
        const double ends = v.amp.end (v.length);
        for (int i = 0; i < n; ++i)
        {
            const int64_t k = pos + i;
            const double t = (double) (k - v.start) / sr;
            if (t < 0) continue;
            if (t >= ends) return false;
            const double abs = (double) k / sr;
            double p = note.pitch;
            if (v.glide > 0 && t < v.glide) p = v.from + (note.pitch - v.from) * t / v.glide;
            const double f = pitchHz (p);
            double mix = 0;
            for (size_t o = 0; o < oscs.size(); ++o)
            {
                const auto& osc = oscs[o];
                const double fo = f * std::pow (2.0, osc.octave + osc.detune.at (abs) / 1200.0);
                const double dt = std::min (fo / sr, 0.49);
                double& ph = v.phase[o];
                double y = 0;
                switch (osc.wave)
                {
                    case Wave::sine:     y = std::sin (2 * pi * ph); break;
                    case Wave::saw:      y = 2 * ph - 1 - blep (ph, dt); break;
                    case Wave::square:   y = (ph < 0.5 ? 1.0 : -1.0) + blep (ph, dt) - blep (std::fmod (ph + 0.5, 1.0), dt); break;
                    case Wave::triangle: y = 1.0 - 4.0 * std::abs (ph - 0.5); break;
                    case Wave::noise:
                        v.noise ^= v.noise << 13; v.noise ^= v.noise >> 17; v.noise ^= v.noise << 5;
                        y = (double) v.noise / 2147483648.0 - 1.0;
                        break;
                }
                mix += y * osc.level.at (abs);
                ph += dt;
                ph -= std::floor (ph);
            }
            if (hasFilter)
            {
                if (((k - v.start) & 15) == 0)
                {
                    double hz = cutoff.at (abs);
                    if (hasFilterEnv) hz *= std::pow (2.0, fAmount.at (abs) * v.fenv.at (t, v.length));
                    v.filter.set (hz, resonance.at (abs), sr);
                }
                mix = v.filter.tick (0, mix);
            }
            const double y = mix * v.amp.at (t, v.length) * v.vel * dbToGain (gain.at (abs));
            L[i] += (float) y;
            R[i] += (float) y;
        }
        return true;
    }
};

//==============================================================================
/** One sound a sampler can play: a range of audio, the pitches and velocities it covers. */
struct Zone
{
    std::shared_ptr<const Audio> audio;
    double root = 60;           // the pitch that plays it unchanged
    double lo = 0, hi = 127;    // pitches it covers (inclusive)
    bool exact = false;         // a slice: only its own pitch plays it
    int vel = 127, vlo = 1, vhi = 127;
    int64_t from = 0, until = 0; // source frames
    int64_t loopFrom = -1, loopUntil = -1;
};

struct SamplerVoice
{
    const Zone* zone = nullptr;
    size_t note = 0;
    int64_t start = 0;
    double length = 0, pos = 0, ratio = 1, gain = 1, attack = 0, release = 0;
    int64_t choked = -1;
};

/** Plays zones at each note's pitch. layered: zones carry velocity layers and each note is
    corrected from its layer's velocity (named instruments and kits); otherwise velocity is gain
    from 127. one_shot plays to the zone's end whatever the note's length; otherwise the zone
    plays for the note's length (looping where the zone has a loop), then release_ms. */
struct Sampler : Instrument<SamplerVoice>
{
    std::vector<Zone> zones;
    bool oneShot = false, layered = false;
    Param attack, release, gain;
    std::vector<std::vector<int>> chokeGroups;
    double chokeSeconds = 0.005;

    const Zone* find (double pitch, int velocity) const
    {
        const Zone* best = nullptr;
        double bestDistance = 1e9;
        for (auto& z : zones)
        {
            if (velocity < z.vlo || velocity > z.vhi) continue;
            if (z.exact)
            {
                if (std::abs (pitch - z.root) < 1e-9) return &z;
                continue;
            }
            const double rounded = std::round (pitch);
            if (rounded >= z.lo && rounded <= z.hi) return &z;
            // Past the instrument's range: the nearest edge zone plays it.
            const double d = rounded < z.lo ? z.lo - rounded : rounded - z.hi;
            if (d < bestDistance) { bestDistance = d; best = &z; }
        }
        return best;
    }

    bool start (SamplerVoice& v, size_t index, int64_t s) override
    {
        const auto& n = notes[index];
        const Zone* z = find (n.pitch, n.velocity);
        if (z == nullptr) return false; // a pitch with no slice is silent
        v.zone = z;
        v.note = index;
        v.start = s;
        v.length = n.length;
        v.pos = (double) z->from;
        v.ratio = z->exact ? z->audio->rate / sr : std::pow (2.0, (n.pitch - z->root) / 12.0) * z->audio->rate / sr;
        v.gain = layered ? velocityGain ((double) n.velocity * 127.0 / z->vel) : velocityGain (n.velocity);
        v.attack = attack.at (n.start) * 0.001;
        v.release = release.at (n.start) * 0.001;
        return true;
    }

    void started (size_t index) override
    {
        if (chokeGroups.empty()) return;
        const auto pitch = notes[index].pitch;
        for (auto& g : chokeGroups)
        {
            if (std::find (g.begin(), g.end(), (int) std::lround (pitch)) == g.end()) continue;
            const auto s = (int64_t) std::llround (notes[index].start * sr);
            for (auto& v : voices)
                if (v.choked < 0 && std::find (g.begin(), g.end(), (int) std::lround (notes[v.note].pitch)) != g.end())
                    v.choked = s;
        }
    }

    bool render (SamplerVoice& v, float* L, float* R, int n, int64_t pos) override
    {
        const auto& z = *v.zone;
        const float* a = z.audio->channel (0);
        const float* b = z.audio->channel (1);
        const int64_t frames = z.audio->frames();
        const bool loops = z.loopFrom >= 0 && ! oneShot;
        for (int i = 0; i < n; ++i)
        {
            const int64_t k = pos + i;
            const double t = (double) (k - v.start) / sr;
            if (t < 0) continue;
            double amp = v.attack > 0 && t < v.attack ? t / v.attack : 1.0;
            if (! oneShot && t >= v.length)
            {
                if (v.release <= 0) return false;
                const double r = 1.0 - (t - v.length) / v.release;
                if (r <= 0) return false;
                amp *= r;
            }
            if (v.choked >= 0 && k >= v.choked)
            {
                const double c = 1.0 - (double) (k - v.choked) / (chokeSeconds * sr);
                if (c <= 0) return false;
                amp *= c;
            }
            if (loops && v.pos >= (double) z.loopUntil)
                v.pos -= (double) (z.loopUntil - z.loopFrom);
            if (! loops && v.pos >= (double) z.until) return false;
            const double g = amp * v.gain * dbToGain (gain.at ((double) k / sr));
            L[i] += (float) (hermite (a, frames, v.pos) * g);
            R[i] += (float) (hermite (b, frames, v.pos) * g);
            v.pos += v.ratio;
        }
        return true;
    }
};

//==============================================================================
struct Clip
{
    std::shared_ptr<const Audio> audio; // at the project rate, already cut and stretched
    int64_t at = 0;                     // first sample in the project
    int64_t stop = INT64_MAX;           // no sample from here on (the tail's cut)
    double gain = 1;
};

/** A part's audio clips, each added at its place. */
struct Clips : Processor
{
    std::vector<Clip> clips;
    bool generates() const override { return true; }
    void prepare (double) override {}
    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (auto& c : clips)
        {
            const int64_t a = std::max (pos, c.at);
            const int64_t b = std::min ({ pos + n, c.at + c.audio->frames(), c.stop });
            const float* l = c.audio->channel (0);
            const float* r = c.audio->channel (1);
            for (int64_t k = a; k < b; ++k)
            {
                L[k - pos] += (float) (l[k - c.at] * c.gain);
                R[k - pos] += (float) (r[k - c.at] * c.gain);
            }
        }
    }
};
}
