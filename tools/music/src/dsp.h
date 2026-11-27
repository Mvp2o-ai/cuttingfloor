// DSP for cf-music: automation curves, filters, envelopes and the effects. Everything is a
// function of the project and the absolute sample position, so a render is the same every time.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>
#include <memory>
#include <vector>

namespace cf
{
constexpr double pi = 3.14159265358979323846;

/** Dot product with 8 partial sums in a fixed order: vectorises, and is the same every run. */
template <typename T>
inline T dot (const T* a, const T* b, int n)
{
    T acc[8] = {};
    int k = 0;
    for (; k + 8 <= n; k += 8)
        for (int j = 0; j < 8; ++j) acc[j] += a[k + j] * b[k + j];
    T sum = ((acc[0] + acc[1]) + (acc[2] + acc[3])) + ((acc[4] + acc[5]) + (acc[6] + acc[7]));
    for (; k < n; ++k) sum += a[k] * b[k];
    return sum;
}

inline double dbToGain (double db) { return std::pow (10.0, db / 20.0); }
inline double gainToDb (double g) { return g > 0 ? 20.0 * std::log10 (g) : -std::numeric_limits<double>::infinity(); }

/** MIDI velocity as gain: 40 log10 (v / 127) dB, the SoundFont and DLS convention. */
inline double velocityGain (double velocity) { const double v = velocity / 127.0; return v * v; }

//==============================================================================
enum class CurveShape { hold, linear, smooth };

struct CurvePoint
{
    double time, value;
    CurveShape shape;
};

/** Automation: points {time, value, shape to the next point}. Before the first point the value
    is the first point's, after the last the last's. Points at the same time step at once. */
struct Curve
{
    std::vector<CurvePoint> points;
    mutable size_t hint = 0;

    double at (double t) const
    {
        const auto n = points.size();
        if (t < points.front().time) return points.front().value;
        if (t >= points.back().time) return points.back().value;
        // Renders move forward in time, so the segment is almost always at or after the hint.
        if (hint >= n - 1 || points[hint].time > t) hint = 0;
        while (hint + 1 < n && points[hint + 1].time <= t) ++hint;
        const auto& a = points[hint];
        const auto& b = points[hint + 1];
        const double x = (t - a.time) / (b.time - a.time);
        switch (a.shape)
        {
            case CurveShape::hold:   return a.value;
            case CurveShape::linear: return a.value + (b.value - a.value) * x;
            case CurveShape::smooth: return a.value + (b.value - a.value) * 0.5 * (1.0 - std::cos (pi * x));
        }
        return a.value;
    }
};

/** A numeric param: its value, or its automation when it has one. */
struct Param
{
    double base = 0;
    const Curve* curve = nullptr;
    double at (double t) const { return curve != nullptr ? curve->at (t) : base; }
    bool moves() const { return curve != nullptr; }
};

//==============================================================================
/** Topology-preserving state-variable filter (Simper): stable when its cutoff moves fast. */
struct Svf
{
    double ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, k = 1;

    void set (double hz, double q, double sr)
    {
        hz = std::clamp (hz, 1.0, sr * 0.49);
        const double g = std::tan (pi * hz / sr);
        k = 1.0 / std::max (q, 1e-3);
        a1 = 1.0 / (1.0 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
    }

    enum Out { low, high, band };

    double tick (double v0, Out out)
    {
        const double v3 = v0 - ic2;
        const double v1 = a1 * ic1 + a2 * v3;
        const double v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        switch (out)
        {
            case low:  return v2;
            case high: return v0 - k * v1 - v2;
            case band: return k * v1; // unity gain at the centre
        }
        return v2;
    }
};

enum class FilterType { lowpass, highpass, bandpass };

/** Low-pass, high-pass or band-pass at 12, 24 or 48 dB per octave: cascaded 2-pole sections.
    Low and high pass are Butterworth sections (maximally flat when resonance is 0.7071); the
    resonance scales the last section's Q. Band pass is slope/6 band sections of Q resonance,
    so each skirt falls at the slope. */
struct SlopeFilter
{
    FilterType type = FilterType::lowpass;
    int slope = 12;
    std::array<std::array<Svf, 8>, 2> stages {};
    int count = 1;
    std::array<double, 8> qs {};

    void configure (FilterType t, int slopeDb)
    {
        type = t;
        slope = slopeDb;
        static const double q12[] = { 0.70710678 };
        static const double q24[] = { 0.54119610, 1.30656296 };
        static const double q48[] = { 0.50979558, 0.60134489, 0.89997622, 2.56291545 };
        if (t == FilterType::bandpass)
        {
            count = slopeDb / 6;
            for (int i = 0; i < count; ++i) qs[(size_t) i] = 0;
            return;
        }
        const double* q = slopeDb == 12 ? q12 : slopeDb == 24 ? q24 : q48;
        count = slopeDb / 12;
        for (int i = 0; i < count; ++i) qs[(size_t) i] = q[i];
    }

    void set (double hz, double resonance, double sr)
    {
        for (int i = 0; i < count; ++i)
        {
            double q = type == FilterType::bandpass ? resonance
                     : (i == count - 1 ? qs[(size_t) i] * resonance / 0.70710678 : qs[(size_t) i]);
            for (auto& ch : stages)
                ch[(size_t) i].set (hz, q, sr);
        }
    }

    double tick (int ch, double x)
    {
        const auto out = type == FilterType::lowpass ? Svf::low : type == FilterType::highpass ? Svf::high : Svf::band;
        for (int i = 0; i < count; ++i)
            x = stages[(size_t) ch][(size_t) i].tick (x, out);
        return x;
    }
};

/** RBJ biquad (transposed direct form II) for peak and shelf bands. */
struct Biquad
{
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    std::array<double, 2> z1 {}, z2 {};

    enum Kind { peak, lowShelf, highShelf };

    void set (Kind kind, double hz, double gainDb, double q, double sr)
    {
        hz = std::clamp (hz, 1.0, sr * 0.49);
        const double A = std::pow (10.0, gainDb / 40.0);
        const double w = 2 * pi * hz / sr;
        const double cw = std::cos (w), alpha = std::sin (w) / (2 * std::max (q, 1e-3));
        double a0;
        if (kind == peak)
        {
            b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
            a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        }
        else
        {
            const double s = 2 * std::sqrt (A) * alpha;
            const double sign = kind == lowShelf ? 1.0 : -1.0;
            b0 = A * ((A + 1) - sign * (A - 1) * cw + s);
            b1 = sign * 2 * A * ((A - 1) - sign * (A + 1) * cw);
            b2 = A * ((A + 1) - sign * (A - 1) * cw - s);
            a0 = (A + 1) + sign * (A - 1) * cw + s;
            a1 = -sign * 2 * ((A - 1) + sign * (A + 1) * cw);
            a2 = (A + 1) + sign * (A - 1) * cw - s;
        }
        b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    }

    double tick (int ch, double x)
    {
        const double y = b0 * x + z1[(size_t) ch];
        z1[(size_t) ch] = b1 * x - a1 * y + z2[(size_t) ch];
        z2[(size_t) ch] = b2 * x - a2 * y;
        return y;
    }
};

//==============================================================================
/** Linear ADSR as a function of time: attack 0 to 1, decay to sustain, then from the note's end
    a release to 0. No state, so a note's level is known at any moment. */
struct Adsr
{
    double attack = 0, decay = 0, sustain = 1, release = 0; // seconds

    double held (double t) const
    {
        if (t < 0) return 0;
        if (t < attack) return t / attack;
        t -= attack;
        if (t < decay) return 1.0 + (sustain - 1.0) * t / decay;
        return sustain;
    }

    /** t: seconds since the note started; length: the note's length. */
    double at (double t, double length) const
    {
        if (t < length) return held (t);
        if (release <= 0) return 0;
        const double r = 1.0 - (t - length) / release;
        return r > 0 ? held (length) * r : 0;
    }

    double end (double length) const { return length + release; }
};

//==============================================================================
/** Delay line with fractional (linear) reads. */
struct DelayLine
{
    std::vector<float> buf;
    size_t w = 0;

    void resize (size_t n) { buf.assign (std::max<size_t> (n, 4), 0.0f); w = 0; }
    void push (double x) { buf[w] = (float) x; w = (w + 1) % buf.size(); }

    /** d samples ago (d >= 1 is the last pushed sample). */
    double read (double d) const
    {
        const auto n = buf.size();
        d = std::clamp (d, 1.0, (double) n - 2);
        const double pos = (double) w - d + (double) n;
        const auto i = (size_t) pos;
        const double f = pos - (double) i;
        const double a = buf[i % n], b = buf[(i + 1) % n];
        return a + (b - a) * f;
    }
};

//==============================================================================
/** Every processor works on stereo float blocks at an absolute sample position (0 is the start
    of the project), on one thread. */
struct Processor
{
    virtual ~Processor() = default;
    virtual void prepare (double sampleRate) = 0;
    /** Adds to (instruments) or transforms (effects) L and R for samples [pos, pos + n). */
    virtual void process (float* L, float* R, int n, int64_t pos) = 0;
    virtual int latency() const { return 0; }
    virtual bool generates() const { return false; }
};

//==============================================================================
struct GainFx : Processor
{
    Param gain;
    double sr = 48000;
    void prepare (double s) override { sr = s; }
    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double g = dbToGain (gain.at ((double) (pos + i) / sr));
            L[i] = (float) (L[i] * g);
            R[i] = (float) (R[i] * g);
        }
    }
};

/** A part's own level and pan. Pan is a stereo balance: at 0 both channels pass unchanged; toward
    a side the other channel falls on a cosine to silence at -1 or 1. */
struct FaderFx : Processor
{
    Param gain, pan;
    double sr = 48000;
    void prepare (double s) override { sr = s; }
    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double t = (double) (pos + i) / sr;
            const double g = dbToGain (gain.at (t));
            const double p = std::clamp (pan.at (t), -1.0, 1.0);
            const double gl = p > 0 ? std::cos (p * pi / 2) : 1.0;
            const double gr = p < 0 ? std::cos (-p * pi / 2) : 1.0;
            L[i] = (float) (L[i] * g * gl);
            R[i] = (float) (R[i] * g * gr);
        }
    }
};

//==============================================================================
struct FilterFx : Processor
{
    FilterType type;
    int slope;
    Param cutoff, resonance;
    SlopeFilter f;
    double sr = 48000;

    void prepare (double s) override { sr = s; f = {}; f.configure (type, slope); f.set (cutoff.at (0), resonance.at (0), sr); }
    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            if (((pos + i) & 31) == 0 && (cutoff.moves() || resonance.moves()))
            {
                const double t = (double) (pos + i) / sr;
                f.set (cutoff.at (t), resonance.at (t), sr);
            }
            L[i] = (float) f.tick (0, L[i]);
            R[i] = (float) f.tick (1, R[i]);
        }
    }
};

enum class BandType { peak, lowShelf, highShelf, lowpass, highpass };

struct EqBand
{
    BandType type;
    int slope;
    Param hz, gain, q;
    Biquad bq;
    SlopeFilter sf;
};

struct EqFx : Processor
{
    std::vector<EqBand> bands;
    double sr = 48000;

    void set (EqBand& b, double t)
    {
        if (b.type == BandType::lowpass || b.type == BandType::highpass)
            b.sf.set (b.hz.at (t), b.q.at (t), sr);
        else
            b.bq.set (b.type == BandType::peak ? Biquad::peak : b.type == BandType::lowShelf ? Biquad::lowShelf : Biquad::highShelf,
                      b.hz.at (t), b.gain.at (t), b.q.at (t), sr);
    }

    void prepare (double s) override
    {
        sr = s;
        for (auto& b : bands)
        {
            b.bq = {};
            b.sf = {};
            b.sf.configure (b.type == BandType::lowpass ? FilterType::lowpass : FilterType::highpass, b.slope);
            set (b, 0);
        }
    }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const bool tick = ((pos + i) & 31) == 0;
            double l = L[i], r = R[i];
            for (auto& b : bands)
            {
                if (tick && (b.hz.moves() || b.gain.moves() || b.q.moves()))
                    set (b, (double) (pos + i) / sr);
                if (b.type == BandType::lowpass || b.type == BandType::highpass)
                {
                    l = b.sf.tick (0, l);
                    r = b.sf.tick (1, r);
                }
                else
                {
                    l = b.bq.tick (0, l);
                    r = b.bq.tick (1, r);
                }
            }
            L[i] = (float) l;
            R[i] = (float) r;
        }
    }
};

//==============================================================================
/** Feed-forward compressor, stereo-linked peak detector, hard knee; attack and release smooth
    the gain reduction in dB. */
struct CompressorFx : Processor
{
    Param threshold, ratio, attack, release, makeup;
    double sr = 48000, gr = 0;

    void prepare (double s) override { sr = s; gr = 0; }

    static double coeff (double ms, double sr) { return ms <= 0 ? 0.0 : std::exp (-1.0 / (ms * 0.001 * sr)); }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        double ca = 0, cr = 0, thr = 0, rat = 1, mk = 0;
        for (int i = 0; i < n; ++i)
        {
            if (i == 0 || ((pos + i) & 31) == 0)
            {
                const double t = (double) (pos + i) / sr;
                ca = coeff (attack.at (t), sr);
                cr = coeff (release.at (t), sr);
                thr = threshold.at (t);
                rat = std::max (1.0, ratio.at (t));
                mk = makeup.at (t);
            }
            const double peak = std::max (std::abs ((double) L[i]), std::abs ((double) R[i]));
            const double level = peak > 1e-12 ? 20 * std::log10 (peak) : -240.0;
            const double target = level > thr ? (level - thr) * (1.0 - 1.0 / rat) : 0.0;
            const double c = target > gr ? ca : cr;
            gr = target + (gr - target) * c;
            const double g = dbToGain (mk - gr);
            L[i] = (float) (L[i] * g);
            R[i] = (float) (R[i] * g);
        }
    }
};

//==============================================================================
/** True-peak limiter. Each sample's true peak (the sample and the stretch to the next one) is
    found at 16 points per sample with a 128-tap Kaiser-windowed sinc, read 0.05 dB high: a finite
    kernel reads a band-limited peak a little low (up to 0.04 dB on the hardest material we
    measured), and the margin keeps even an ideal reconstruction under the ceiling. The gain each
    sample needs is held over the kernel's span on both sides and the lookahead (2 ms), then
    box-smoothed over the lookahead, so every sample whose reconstruction touches a peak already
    has that peak's gain; release_ms then lets the gain recover. Latency (reported, and compensated
    by the engine): kernel half + span + lookahead samples. */
struct LimiterFx : Processor
{
    Param ceiling, release;
    double sr = 48000;
    static constexpr int phases = 16, taps = 128, half = taps / 2, span = half;
    static constexpr double readHigh = 1.0057728; // +0.05 dB
    std::array<std::array<float, taps>, phases> kernel {};
    double reach = 1; // the most any interpolated point can be, per unit of the window's largest sample
    std::deque<std::pair<int64_t, double>> window; // the window's largest |sample|, for skipping
    int look;
    // The last `taps` samples of each channel, written twice (at i and i + taps) so the window is
    // always one contiguous run.
    std::vector<float> histL, histR;
    std::vector<double> delayL, delayR, need, held;
    int64_t count = 0;
    double boxSum = 0, env = 1;

    /** The lookahead (2 ms) is fixed at construction: the engine asks for the latency before
        the processor is prepared. */
    explicit LimiterFx (double rate) : sr (rate), look ((int) std::lround (0.002 * rate)) {}

    int latency() const override { return half + span + look; }

    static double bessel0 (double x)
    {
        double sum = 1, term = 1;
        for (int k = 1; k < 40; ++k) { term *= (x / (2 * k)) * (x / (2 * k)); sum += term; }
        return sum;
    }

    void prepare (double s) override
    {
        sr = s;
        const double beta = 5.0;
        for (int p = 0; p < phases; ++p)
            for (int k = 0; k < taps; ++k)
            {
                // Tap k is sample (m - (half - 1) + k); the point is m + p / phases.
                const double x = (double) (k - (half - 1)) - (double) p / phases;
                const double sinc = std::abs (x) < 1e-12 ? 1.0 : std::sin (pi * x) / (pi * x);
                const double r = x / (half + 0.5);
                const double w = std::abs (r) < 1 ? bessel0 (beta * std::sqrt (1 - r * r)) / bessel0 (beta) : 0;
                kernel[(size_t) p][(size_t) k] = (float) (sinc * w);
            }
        reach = 1;
        for (auto& kp : kernel)
        {
            double l1 = 0;
            for (auto v : kp) l1 += std::abs ((double) v);
            reach = std::max (reach, l1);
        }
        window.clear();
        histL.assign (2 * taps, 0); histR.assign (2 * taps, 0);
        delayL.assign ((size_t) latency() + 1, 0); delayR.assign ((size_t) latency() + 1, 0);
        need.assign ((size_t) (2 * span + look + 2), 1.0);
        held.assign ((size_t) (look + 1), 1.0);
        count = 0; boxSum = look + 1; env = 1;
    }

    /** The true peak of sample m (newest - half) and of the stretch to the next sample. */
    double truePeak (const std::vector<float>& h, int64_t newest) const
    {
        // The window, samples newest - taps + 1 .. newest: the kernel's taps; sample m is x[half - 1].
        const float* x = h.data() + (size_t) ((newest + 1) % taps);
        double peak = std::abs ((double) x[half - 1]);
        for (int p = 1; p < phases; ++p)
        {
            const float acc = dot (kernel[(size_t) p].data(), x, taps);
            peak = std::max (peak, std::abs ((double) acc));
        }
        return peak * readHigh;
    }

    static size_t ring (int64_t i, size_t n) { return (size_t) (((i % (int64_t) n) + (int64_t) n) % (int64_t) n); }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        const int lat = latency();
        for (int i = 0; i < n; ++i)
        {
            const int64_t c = count++;
            const auto at = (size_t) (c % taps);
            histL[at] = histL[at + taps] = L[i];
            histR[at] = histR[at + taps] = R[i];
            delayL[ring (c, delayL.size())] = L[i];
            delayR[ring (c, delayR.size())] = R[i];
            // Sample m has the `half` samples after it that the stretch to the next one needs.
            const int64_t m = c - half;
            const double tm = (double) (pos + i - half) / sr;
            const double ceil = dbToGain (ceiling.at (tm));
            // The largest |sample| of the kernel's window (m - half + 1 .. c), kept as a running max.
            const double level = std::max (std::abs ((double) L[i]), std::abs ((double) R[i]));
            while (! window.empty() && window.back().second <= level) window.pop_back();
            window.emplace_back (c, level);
            while (window.front().first <= c - taps) window.pop_front();
            // No point between samples can pass the ceiling when even the kernel's whole reach on
            // the window's largest sample stays under it: then nothing needs measuring.
            const double bound = window.front().second * reach * readHigh;
            const double tp = bound <= ceil ? 0.0 : std::max (truePeak (histL, c), truePeak (histR, c));
            need[ring (m, need.size())] = tp > ceil ? ceil / tp : 1.0;
            // j: the newest sample whose hold window [j - span, j + span + look] is complete.
            const int64_t j = m - span - look;
            double h = 1.0;
            for (int64_t k = j - span; k <= m; ++k)
                if (k >= 0) h = std::min (h, need[ring (k, need.size())]);
            // Box over the held gains of [j - look, j].
            const size_t slot = ring (j, held.size());
            boxSum += h - held[slot];
            held[slot] = h;
            const double box = boxSum / (double) (look + 1);
            const double tj = (double) (pos + i - lat) / sr;
            const double rc = std::exp (-1.0 / (std::max (release.at (tj), 0.01) * 0.001 * sr));
            env = std::min (box, env + (1.0 - env) * (1.0 - rc));
            // j is the sample that leaves now: c - j == latency.
            L[i] = (float) (j >= 0 ? delayL[ring (j, delayL.size())] * env : 0.0);
            R[i] = (float) (j >= 0 ? delayR[ring (j, delayR.size())] * env : 0.0);
        }
    }
};

//==============================================================================
/** Feedback delay network reverb: 8 delay lines under a Householder matrix, a one-pole damping
    filter in each loop, fed through 4 series allpass diffusers. decay_seconds is the time the
    tail takes to fall 60 dB (before damping takes the highs faster); size scales the line
    lengths from 0.25x (0) to 1.75x (1). Output = dry x input + wet x reverb. */
struct ReverbFx : Processor
{
    Param size, decay, damping, wet, dry;
    double sr = 48000;
    static constexpr int lines = 8;
    std::array<DelayLine, lines> line;
    std::array<double, lines> lp {};
    std::array<DelayLine, 4> diff;
    static constexpr double baseMs[lines] = { 31.3, 37.1, 41.9, 45.7, 53.3, 59.9, 67.1, 73.7 };
    static constexpr double diffMs[4] = { 4.77, 3.59, 12.73, 9.31 };
    std::array<double, lines> gains {}, lengths {};
    double damp = 0;

    void update (double t)
    {
        const double scale = 0.25 + 1.5 * std::clamp (size.at (t), 0.0, 1.0);
        const double t60 = std::max (decay.at (t), 0.01);
        for (int i = 0; i < lines; ++i)
        {
            lengths[(size_t) i] = baseMs[i] * 0.001 * sr * scale;
            gains[(size_t) i] = std::pow (10.0, -3.0 * lengths[(size_t) i] / (t60 * sr));
        }
        damp = std::clamp (damping.at (t), 0.0, 1.0) * 0.85;
    }

    void prepare (double s) override
    {
        sr = s;
        for (auto& l : line) l.resize ((size_t) (baseMs[lines - 1] * 0.001 * sr * 1.75) + 8);
        for (int i = 0; i < 4; ++i) diff[(size_t) i].resize ((size_t) (diffMs[i] * 0.001 * sr) + 4);
        lp.fill (0);
        update (0);
    }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double t = (double) (pos + i) / sr;
            if (((pos + i) & 31) == 0) update (t);
            double x = 0.5 * ((double) L[i] + (double) R[i]);
            for (int d = 0; d < 4; ++d)
            {
                auto& a = diff[(size_t) d];
                const double delayed = a.read ((double) a.buf.size() - 3);
                const double v = x + 0.6 * delayed;
                a.push (v);
                x = delayed - 0.6 * v;
            }
            std::array<double, lines> o;
            double sum = 0;
            for (int k = 0; k < lines; ++k)
            {
                const double y = line[(size_t) k].read (lengths[(size_t) k]);
                lp[(size_t) k] = y * (1 - damp) + lp[(size_t) k] * damp;
                o[(size_t) k] = lp[(size_t) k] * gains[(size_t) k];
                sum += o[(size_t) k];
            }
            const double h = 2.0 / lines * sum;
            for (int k = 0; k < lines; ++k)
                line[(size_t) k].push (x + o[(size_t) k] - h);
            const double outL = (o[0] - o[2] + o[4] - o[6]) * 0.5;
            const double outR = (o[1] - o[3] + o[5] - o[7]) * 0.5;
            const double w = wet.at (t), d = dry.at (t);
            L[i] = (float) (d * L[i] + w * outL);
            R[i] = (float) (d * R[i] + w * outR);
        }
    }
};

/** Echo: the input time_ms later, fed back by feedback; wet mixes it with the input
    (0 only the input, 1 only the echoes). */
struct DelayFx : Processor
{
    Param time, feedback, wet;
    double sr = 48000;
    std::array<DelayLine, 2> line;
    static constexpr double maxSeconds = 10.0;

    void prepare (double s) override
    {
        sr = s;
        for (auto& l : line) l.resize ((size_t) (maxSeconds * sr) + 8);
    }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double t = (double) (pos + i) / sr;
            const double d = std::max (1.0, time.at (t) * 0.001 * sr);
            const double fb = feedback.at (t), w = wet.at (t);
            float* io[2] = { L + i, R + i };
            for (int c = 0; c < 2; ++c)
            {
                const double x = *io[c];
                const double y = line[(size_t) c].read (d);
                line[(size_t) c].push (x + fb * y);
                *io[c] = (float) ((1 - w) * x + w * y);
            }
        }
    }
};

/** Chorus: each channel through a delay of 7 ms plus up to 10 ms x depth, swept by a sine at
    rate_hz (the right channel a quarter turn behind); wet mixes it with the input. */
struct ChorusFx : Processor
{
    Param rate, depth, wet;
    double sr = 48000, phase = 0;
    std::array<DelayLine, 2> line;

    void prepare (double s) override
    {
        sr = s;
        phase = 0;
        for (auto& l : line) l.resize ((size_t) (0.02 * sr) + 8);
    }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double t = (double) (pos + i) / sr;
            const double dep = std::clamp (depth.at (t), 0.0, 1.0), w = wet.at (t);
            float* io[2] = { L + i, R + i };
            for (int c = 0; c < 2; ++c)
            {
                const double lfo = 0.5 + 0.5 * std::sin (2 * pi * phase + (c == 1 ? pi / 2 : 0.0));
                const double d = (0.007 + 0.010 * dep * lfo) * sr;
                const double x = *io[c];
                line[(size_t) c].push (x);
                const double y = line[(size_t) c].read (d);
                *io[c] = (float) ((1 - w) * x + w * y);
            }
            if (pos + i >= 0)
            {
                phase += rate.at (t) / sr;
                phase -= std::floor (phase);
            }
        }
    }
};

/** Soft clipping: tanh of the input raised by drive_db, at 4x oversampling (97-tap
    Kaiser-windowed sinc up and down, so the latency is a whole 24 samples); wet mixes it with
    the input, delayed to match. */
struct SaturationFx : Processor
{
    Param drive, wet;
    double sr = 48000;
    static constexpr int factor = 4, taps = 97, lag = (taps - 1) / factor; // 24
    static constexpr int upTaps = lag + 1;   // input samples each oversampled point reads
    static constexpr int downSize = 128;     // oversampled history, at least taps long
    std::vector<double> h;
    std::array<std::array<double, upTaps>, factor> up {}; // per phase, oldest input first
    // Histories written twice (at i and i + size) so every window is one contiguous run.
    std::array<std::vector<double>, 2> inHist, overHist, dryHist;
    int64_t count = 0;

    int latency() const override { return lag; }

    void prepare (double s) override
    {
        sr = s;
        h.assign (taps, 0);
        const double fc = 0.5 / factor * 0.9; // of the oversampled rate
        double sum = 0;
        for (int k = 0; k < taps; ++k)
        {
            const double x = k - (taps - 1) / 2.0;
            const double sinc = x == 0 ? 2 * fc : std::sin (2 * pi * fc * x) / (pi * x);
            const double r = x / ((taps - 1) / 2.0);
            const double w = LimiterFx::bessel0 (8.0 * std::sqrt (std::max (0.0, 1 - r * r))) / LimiterFx::bessel0 (8.0);
            h[(size_t) k] = sinc * w;
            sum += h[(size_t) k];
        }
        for (auto& v : h) v /= sum;
        // Oversampled point p of input sample c is factor * sum_k h[p + factor k] x[c - k];
        // up[p][j] is the tap for x[c - lag + j].
        for (int p = 0; p < factor; ++p)
            for (int j = 0; j < upTaps; ++j)
            {
                const int k = lag - j, t = p + factor * k;
                up[(size_t) p][(size_t) j] = t < taps ? factor * h[(size_t) t] : 0.0;
            }
        for (int c = 0; c < 2; ++c)
        {
            inHist[(size_t) c].assign (2 * upTaps, 0);
            overHist[(size_t) c].assign (2 * downSize, 0);
            dryHist[(size_t) c].assign ((size_t) lag + 1, 0);
        }
        count = 0;
    }

    void process (float* L, float* R, int n, int64_t pos) override
    {
        for (int i = 0; i < n; ++i)
        {
            const double t = (double) (pos + i) / sr;
            const double g = dbToGain (drive.at (t)), w = wet.at (t);
            const int64_t c = count++;
            float* io[2] = { L + i, R + i };
            for (int ch = 0; ch < 2; ++ch)
            {
                auto& in = inHist[(size_t) ch];
                auto& over = overHist[(size_t) ch];
                auto& dry = dryHist[(size_t) ch];
                const auto at = (size_t) (c % upTaps);
                in[at] = in[at + upTaps] = *io[ch];
                dry[(size_t) (c % (lag + 1))] = *io[ch];
                // The input window, samples c - lag .. c.
                const double* x = in.data() + (size_t) ((c + 1) % upTaps);
                for (int p = 0; p < factor; ++p)
                {
                    const double u = dot (up[(size_t) p].data(), x, upTaps);
                    const auto q = (size_t) ((c * factor + p) % downSize);
                    over[q] = over[q + downSize] = std::tanh (g * u);
                }
                // Decimate at oversampled index factor * c: up and down filters together delay
                // it by taps - 1 = 96 oversampled samples, 24 input samples exactly. The window
                // is oversampled samples factor c - (taps - 1) .. factor c, and h is symmetric.
                const double* v = over.data() + (size_t) ((c * factor - (taps - 1) + 8 * downSize) % downSize);
                const double y = dot (h.data(), v, taps);
                const double x0 = dry[(size_t) ((c + 1) % (lag + 1))]; // input from `lag` ago
                *io[ch] = (float) ((1 - w) * x0 + w * y);
            }
        }
    }
};

}
