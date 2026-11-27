// The render project (JSON, all times in seconds) and its checks. Everything is checked before
// any sound is made; a wrong project fails with a code, the path of what was wrong and why.
// packages/engine/src/music.ts holds the same format as TypeScript types and the catalog's
// ranges; these checks are the engine's own and catch anything that reaches it unchecked.
#pragma once

#include <JuceHeader.h>
#include "sources.h"
#include <optional>
#include <set>
#include <stdexcept>

namespace cf
{
struct ProjectError : std::runtime_error
{
    std::string code, path;
    ProjectError (std::string c, std::string p, const std::string& message)
        : std::runtime_error (message), code (std::move (c)), path (std::move (p)) {}
};

[[noreturn]] inline void fail (const std::string& path, const std::string& message, const std::string& code = "bad_request")
{
    throw ProjectError (code, path, (path.empty() ? "" : path + ": ") + message);
}

inline bool isNumber (const juce::var& v) { return v.isInt() || v.isInt64() || v.isDouble(); }

inline std::string fmt (double v)
{
    std::ostringstream s;
    s << v;
    return s.str();
}

//==============================================================================
// Param schemas: what each device takes. Kinds: number, integer, boolean, string, one of a
// list, an object of fields, or a list of objects.
enum class Kind { number, integer, boolean, string, choice, object, list };

struct Spec
{
    std::string key;
    Kind kind;
    double min = -1e300, max = 1e300;
    std::vector<std::string> choices = {};
    std::vector<Spec> fields = {};
    bool optional = false;
    bool automatable = true;
    int minItems = 0, maxItems = 64;
};

inline Spec num (std::string k, double lo, double hi, bool automatable = true) { return { std::move (k), Kind::number, lo, hi, {}, {}, false, automatable }; }
inline Spec integer (std::string k, double lo, double hi) { return { std::move (k), Kind::integer, lo, hi, {}, {}, false, false }; }
inline Spec flag (std::string k) { return { std::move (k), Kind::boolean }; }
inline Spec text (std::string k) { return { std::move (k), Kind::string }; }
inline Spec choice (std::string k, std::vector<std::string> c) { return { std::move (k), Kind::choice, 0, 0, std::move (c) }; }
inline Spec object (std::string k, std::vector<Spec> f) { return { std::move (k), Kind::object, 0, 0, {}, std::move (f) }; }
inline Spec list (std::string k, std::vector<Spec> f, int lo, int hi) { Spec s { std::move (k), Kind::list, 0, 0, {}, std::move (f) }; s.minItems = lo; s.maxItems = hi; return s; }
inline Spec optional (Spec s) { s.optional = true; return s; }

enum class DeviceKind { sampler, synth, named, kit, eq, filter, compressor, limiter, reverb, delay, chorus, saturation, gain };

struct DeviceDef
{
    DeviceKind kind;
    std::vector<Spec> params;
    bool instrument() const { return kind == DeviceKind::sampler || kind == DeviceKind::synth || kind == DeviceKind::named || kind == DeviceKind::kit; }
};

inline const std::vector<Spec>& envelopeFields()
{
    static const std::vector<Spec> f { num ("attack_ms", 0, 60000), num ("decay_ms", 0, 60000), num ("sustain", 0, 1), num ("release_ms", 0, 60000) };
    return f;
}

/** The devices the engine has. Named instruments and kits are added from the content folder. */
inline std::map<std::string, DeviceDef> deviceDefs (const std::vector<std::string>& named, const std::vector<std::string>& kits,
                                                     const std::vector<std::string>& synthPresets)
{
    std::map<std::string, DeviceDef> d;
    const auto filterType = choice ("type", { "lowpass", "highpass", "bandpass" });
    const auto slope = choice ("slope_db_per_octave", { "12", "24", "48" });
    d["sampler"] = { DeviceKind::sampler, {
        text ("file"), num ("from_seconds", 0, 1e7, false), optional (num ("until_seconds", 0, 1e7, false)),
        num ("root_note", 0, 127, false), flag ("one_shot"),
        optional (list ("slices", { num ("note", 0, 127, false), num ("from_seconds", 0, 1e7, false), num ("until_seconds", 0, 1e7, false) }, 1, 128)),
        num ("attack_ms", 0, 60000), num ("release_ms", 0, 60000), flag ("loop"), num ("gain_db", -96, 24) } };
    auto fenv = envelopeFields();
    fenv.push_back (num ("amount_octaves", -10, 10));
    d["synth"] = { DeviceKind::synth, {
        list ("oscillators", { choice ("wave", { "sine", "saw", "square", "triangle", "noise" }), integer ("octave", -4, 4),
                               num ("detune_cents", -1200, 1200), num ("level", 0, 1) }, 1, 8),
        optional (object ("filter", { filterType, num ("cutoff_hz", 10, 24000), num ("resonance", 0.1, 30), slope })),
        object ("amp_envelope", envelopeFields()),
        optional (object ("filter_envelope", fenv)),
        num ("glide_ms", 0, 10000), num ("gain_db", -96, 24) } };
    for (auto& n : named)
        d[n] = { DeviceKind::named, { num ("gain_db", -96, 24), num ("attack_ms", 0, 60000), num ("release_ms", 0, 60000) } };
    for (auto& n : synthPresets)
        d[n] = { DeviceKind::synth, { num ("gain_db", -96, 24), num ("attack_ms", 0, 60000), num ("release_ms", 0, 60000) } };
    for (auto& k : kits)
        d[k] = { DeviceKind::kit, { num ("gain_db", -96, 24) } };
    d["eq"] = { DeviceKind::eq, { list ("bands", { choice ("type", { "peak", "low_shelf", "high_shelf", "lowpass", "highpass" }),
                                                   num ("hz", 10, 24000), num ("gain_db", -48, 48), num ("q", 0.05, 40), slope }, 1, 32) } };
    d["filter"] = { DeviceKind::filter, { filterType, num ("cutoff_hz", 10, 24000), num ("resonance", 0.1, 30), slope } };
    d["compressor"] = { DeviceKind::compressor, { num ("threshold_db", -96, 0), num ("ratio", 1, 100), num ("attack_ms", 0, 2000),
                                                  num ("release_ms", 0, 10000), num ("makeup_db", -48, 48) } };
    d["limiter"] = { DeviceKind::limiter, { num ("ceiling_dbtp", -60, 0), num ("release_ms", 0.01, 10000) } };
    d["reverb"] = { DeviceKind::reverb, { num ("size", 0, 1), num ("decay_seconds", 0.05, 60), num ("damping", 0, 1), num ("wet", 0, 4), num ("dry", 0, 4) } };
    d["delay"] = { DeviceKind::delay, { num ("time_ms", 0.1, DelayFx::maxSeconds * 1000), num ("feedback", 0, 0.99), num ("wet", 0, 1) } };
    d["chorus"] = { DeviceKind::chorus, { num ("rate_hz", 0.001, 40), num ("depth", 0, 1), num ("wet", 0, 1) } };
    d["saturation"] = { DeviceKind::saturation, { num ("drive_db", -24, 60), num ("wet", 0, 1) } };
    d["gain"] = { DeviceKind::gain, { num ("gain_db", -96, 48) } };
    return d;
}

//==============================================================================
struct NumericParam
{
    double value, min, max;
    bool automatable;
    Param param;
};

struct Device
{
    std::string id, name, path;
    const DeviceDef* def = nullptr;
    juce::var params;
    std::map<std::string, NumericParam> numbers; // "filter.cutoff_hz", "bands[0].gain_db"
    bool enabled = true;

    Param p (const std::string& key) const
    {
        auto it = numbers.find (key);
        if (it == numbers.end()) fail (path, "missing param " + key, "engine_error");
        return it->second.param;
    }
    std::string str (const std::string& key) const { return params[juce::Identifier (key)].toString().toStdString(); }
};

struct Send
{
    std::string id, to, path;
    double level_db = 0;
    bool before_gain = false;
    Param level;
    int bus = 0;
};

struct ClipDef
{
    std::string file, path;
    double at = 0, from = 0, gain_db = 0;
    std::optional<double> until, stretch_to;
};

struct TrackDef
{
    std::string id, output = "master", path;
    double gain_db = 0, pan = 0;
    Param gain, panParam;
    std::vector<Device> devices;
    std::vector<Send> sends;
    std::vector<Note> notes;
    std::vector<ClipDef> clips;
    bool sounds = true; // in the render's track list
};

struct Project
{
    int sampleRate = 48000;
    double from = 0, until = 0;
    std::optional<double> tailDb;
    double tailMax = 0;
    std::vector<TrackDef> tracks;
    std::vector<Device> master;
    std::vector<std::unique_ptr<Curve>> curves;
    std::vector<std::string> alone;
};

//==============================================================================
struct Reader
{
    const std::map<std::string, DeviceDef>& defs;

    static void onlyKeys (const juce::var& o, const std::string& path, std::initializer_list<const char*> keys)
    {
        auto* obj = o.getDynamicObject();
        if (obj == nullptr) fail (path, "must be an object");
        for (auto& p : obj->getProperties())
        {
            bool known = false;
            for (auto k : keys) known = known || p.name.toString() == k;
            if (! known)
            {
                std::string list;
                for (auto k : keys) list += (list.empty() ? "" : ", ") + std::string (k);
                fail (path, "unknown field " + p.name.toString().toStdString() + " (fields: " + list + ")");
            }
        }
    }

    static const juce::var& field (const juce::var& o, const char* key, const std::string& path)
    {
        if (! o.hasProperty (key)) fail (path, std::string ("missing ") + key);
        return o[key];
    }

    static double number (const juce::var& o, const char* key, const std::string& path, double lo, double hi)
    {
        const auto& v = field (o, key, path);
        if (! isNumber (v)) fail (path + "." + key, "must be a number");
        const double d = (double) v;
        if (! std::isfinite (d) || d < lo || d > hi) fail (path + "." + key, fmt (d) + " is out of range " + fmt (lo) + " to " + fmt (hi));
        return d;
    }

    static std::string string (const juce::var& o, const char* key, const std::string& path)
    {
        const auto& v = field (o, key, path);
        if (! v.isString() || v.toString().isEmpty()) fail (path + "." + key, "must be a non-empty string");
        return v.toString().toStdString();
    }

    static bool boolean (const juce::var& o, const char* key, const std::string& path)
    {
        const auto& v = field (o, key, path);
        if (! v.isBool()) fail (path + "." + key, "must be true or false");
        return (bool) v;
    }

    /** Checks a param value against its spec and records every number it holds by path. */
    void check (const Spec& s, const juce::var& v, const std::string& path, const std::string& key, Device& d)
    {
        switch (s.kind)
        {
            case Kind::number:
            case Kind::integer:
            {
                if (! isNumber (v)) fail (path, "must be a number");
                const double x = (double) v;
                if (! std::isfinite (x) || x < s.min || x > s.max) fail (path, fmt (x) + " is out of range " + fmt (s.min) + " to " + fmt (s.max));
                if (s.kind == Kind::integer && x != std::floor (x)) fail (path, "must be a whole number");
                d.numbers[key] = { x, s.min, s.max, s.automatable && s.kind == Kind::number, { x, nullptr } };
                return;
            }
            case Kind::boolean: if (! v.isBool()) fail (path, "must be true or false"); return;
            case Kind::string:  if (! v.isString() || v.toString().isEmpty()) fail (path, "must be a non-empty string"); return;
            case Kind::choice:
            {
                std::string value;
                if (v.isString()) value = v.toString().toStdString();
                else if (isNumber (v) && (double) v == std::floor ((double) v)) value = std::to_string ((long long) (double) v);
                if (std::find (s.choices.begin(), s.choices.end(), value) == s.choices.end())
                {
                    std::string list;
                    for (auto& c : s.choices) list += (list.empty() ? "" : ", ") + c;
                    fail (path, "'" + v.toString().toStdString() + "' is not one of " + list);
                }
                return;
            }
            case Kind::object:
                checkObject (s.fields, v, path, key + ".", d);
                return;
            case Kind::list:
            {
                if (! v.isArray()) fail (path, "must be a list");
                const auto n = v.size();
                if (n < s.minItems || n > s.maxItems) fail (path, "must have " + std::to_string (s.minItems) + " to " + std::to_string (s.maxItems) + " items");
                for (int i = 0; i < n; ++i)
                    checkObject (s.fields, v[i], path + "[" + std::to_string (i) + "]", key + "[" + std::to_string (i) + "].", d);
                return;
            }
        }
    }

    void checkObject (const std::vector<Spec>& fields, const juce::var& v, const std::string& path, const std::string& prefix, Device& d)
    {
        auto* obj = v.getDynamicObject();
        if (obj == nullptr) fail (path, "must be an object");
        for (auto& p : obj->getProperties())
        {
            const auto name = p.name.toString().toStdString();
            if (std::none_of (fields.begin(), fields.end(), [&] (const Spec& s) { return s.key == name; }))
            {
                std::string list;
                for (auto& s : fields) list += (list.empty() ? "" : ", ") + s.key;
                fail (path, "unknown param " + name + " (params: " + list + ")");
            }
        }
        for (auto& s : fields)
        {
            if (! v.hasProperty (juce::Identifier (s.key)))
            {
                if (s.optional) continue;
                fail (path, "missing param " + s.key);
            }
            check (s, v[juce::Identifier (s.key)], path + "." + s.key, prefix + s.key, d);
        }
    }

    Device device (const juce::var& v, const std::string& path)
    {
        onlyKeys (v, path, { "id", "name", "params", "enabled" });
        Device d;
        d.path = path;
        d.id = string (v, "id", path);
        d.name = string (v, "name", path);
        auto def = defs.find (d.name);
        if (def == defs.end())
        {
            std::string names;
            for (auto& [n, _] : defs) names += (names.empty() ? "" : ", ") + n;
            fail (path + ".name", "unknown device " + d.name + " (devices: " + names + ")");
        }
        d.def = &def->second;
        if (v.hasProperty ("enabled")) d.enabled = boolean (v, "enabled", path);
        d.params = field (v, "params", path);
        // Keys are recorded without the "params." prefix: "cutoff_hz", "filter.cutoff_hz".
        checkObject (d.def->params, d.params, path + ".params", "", d);
        return d;
    }

    Note note (const juce::var& v, const std::string& path)
    {
        onlyKeys (v, path, { "start", "length", "pitch", "velocity" });
        Note n;
        n.start = number (v, "start", path, 0, 1e7);
        n.length = number (v, "length", path, 1e-6, 1e7);
        n.pitch = number (v, "pitch", path, 0, 127);
        const double vel = number (v, "velocity", path, 1, 127);
        if (vel != std::floor (vel)) fail (path + ".velocity", "must be a whole number");
        n.velocity = (int) vel;
        return n;
    }

    ClipDef clip (const juce::var& v, const std::string& path)
    {
        onlyKeys (v, path, { "file", "at", "from", "until", "gain_db", "stretch_to" });
        ClipDef c;
        c.path = path;
        c.file = string (v, "file", path);
        c.at = number (v, "at", path, 0, 1e7);
        c.from = number (v, "from", path, 0, 1e7);
        if (v.hasProperty ("until")) c.until = number (v, "until", path, 0, 1e7);
        c.gain_db = number (v, "gain_db", path, -96, 24);
        if (v.hasProperty ("stretch_to")) c.stretch_to = number (v, "stretch_to", path, 0.001, 1e7);
        if (c.until && *c.until <= c.from) fail (path + ".until", "must be after from");
        return c;
    }
};

}
