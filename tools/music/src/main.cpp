// cf-music: renders a music project (JSON, seconds) to a 24-bit WAV on Tracktion Engine.
//
//   cf-music render <project.json> <out.wav> [--content <dir>]
//   cf-music check <project.json> [--content <dir>]
//   cf-music catalog [--content <dir>]
//   cf-music version
//
// Prints one JSON line on stdout: the facts of the render, {"ok": true} for check, the devices
// and their params for catalog, or {"error": {"code", "message", "path"}} (also the last line on
// stderr). Exit 0 on success, 2 for a project that is wrong,
// 1 when the engine fails. Nothing is rendered until the whole project has been checked and every
// file it names has been read.
//
// Tracktion Engine runs the graph: one audio track per part, a part's output to the master or to
// another part, sends as aux sends and returns, latency compensation, and the offline render.
// Every sound source and effect is cf-music's own plugin (src/dsp.h, src/sources.h), driven by
// the absolute sample position, so a note sounds at its exact pitch and sample and a render is
// the same every time.

#include <JuceHeader.h>
#include "project.h"
#include "signalsmith-stretch/signalsmith-stretch.h"

#include <chrono>
#include <fstream>
#include <iostream>
#include <unistd.h>

namespace te = tracktion;
using namespace std::chrono;

namespace cf
{
//==============================================================================
// Engine set-up: no audio devices, no UI, one thread (a render is the same every time).
struct HeadlessUIBehaviour : te::UIBehaviour
{
    void runTaskWithProgressBar (te::ThreadPoolJobWithProgress& t) override
    {
        while (t.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain) {}
    }
};

struct HeadlessEngineBehaviour : te::EngineBehaviour
{
    bool autoInitialiseDeviceManager() override { return false; }
    bool addSystemAudioIODeviceTypes() override { return false; }
    int getNumberOfCPUsToUseForAudio() override { return 1; }
};

/** Settings in memory, and a cache folder of this process's own (removed at exit): nothing is
    written under $HOME, and renders running at once never share a folder. */
struct MemoryStorage : te::PropertyStorage
{
    juce::File cache;
    std::map<juce::String, juce::var> values;

    MemoryStorage() : te::PropertyStorage ("cf-music")
    {
        cache = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("cf-music-" + juce::String (juce::SystemStats::getEnvironmentVariable ("HOSTNAME", "")) + "-"
                                   + juce::String ((int) getpid()));
    }
    ~MemoryStorage() override { cache.deleteRecursively(); }

    static juce::String key (te::SettingID s, juce::StringRef item = {}) { return juce::String (settingToString (s)) + "/" + item; }
    juce::File getAppCacheFolder() override { return cache; }
    juce::File getAppPrefsFolder() override { return cache; }
    void removeProperty (te::SettingID s) override { values.erase (key (s)); }
    juce::var getProperty (te::SettingID s, const juce::var& d) override { auto it = values.find (key (s)); return it != values.end() ? it->second : d; }
    void setProperty (te::SettingID s, const juce::var& v) override { values[key (s)] = v; }
    std::unique_ptr<juce::XmlElement> getXmlProperty (te::SettingID) override { return {}; }
    void setXmlProperty (te::SettingID, const juce::XmlElement&) override {}
    void removePropertyItem (te::SettingID s, juce::StringRef i) override { values.erase (key (s, i)); }
    juce::var getPropertyItem (te::SettingID s, juce::StringRef i, const juce::var& d) override { auto it = values.find (key (s, i)); return it != values.end() ? it->second : d; }
    void setPropertyItem (te::SettingID s, juce::StringRef i, const juce::var& v) override { values[key (s, i)] = v; }
    std::unique_ptr<juce::XmlElement> getXmlPropertyItem (te::SettingID, juce::StringRef) override { return {}; }
    void setXmlPropertyItem (te::SettingID, juce::StringRef, const juce::XmlElement&) override {}
    juce::File getDefaultLoadSaveDirectory (juce::StringRef) override { return cache; }
    void setDefaultLoadSaveDirectory (juce::StringRef, const juce::File&) override {}
    juce::File getDefaultLoadSaveDirectory (te::ProjectItem::Category) override { return cache; }
    juce::String getUserName() override { return "cf-music"; }
};

/** Tracktion's log lines would land on stdout, which carries only cf-music's JSON. */
struct QuietLogger : juce::Logger
{
    void logMessage (const juce::String&) override {}
};

/** The processors the plugins run, by index (the plugin's state holds the index). */
std::vector<std::unique_ptr<Processor>> processors;
double projectRate = 48000;

/** A Tracktion plugin around one of cf-music's processors. */
class CfPlugin : public te::Plugin
{
public:
    static const char* xmlTypeName;

    CfPlugin (te::PluginCreationInfo info) : te::Plugin (info)
    {
        const int index = state.getProperty ("cfIndex", -1);
        if (juce::isPositiveAndBelow (index, (int) processors.size()))
            proc = processors[(size_t) index].get();
    }
    ~CfPlugin() override { notifyListenersOfDeletion(); }

    juce::String getName() const override { return "cf"; }
    juce::String getPluginType() override { return xmlTypeName; }
    juce::String getSelectableDescription() override { return "cf"; }
    bool producesAudioWhenNoAudioInput() override { return proc != nullptr && proc->generates(); }
    bool takesAudioInput() override { return true; }
    bool takesMidiInput() override { return false; }
    bool isSynth() override { return false; }
    bool noTail() override { return false; }
    int getNumOutputChannelsGivenInputs (int) override { return 2; }
    BusLayout getBusses() const override { return BusLayout::singleStereoInOut(); }
    double getLatencySeconds() override { return proc != nullptr ? proc->latency() / projectRate : 0.0; }
    void initialise (const te::PluginInitialisationInfo& info) override
    {
        if (proc != nullptr && ! prepared) { proc->prepare (info.sampleRate); prepared = true; }
    }
    void deinitialise() override {}
    void reset() override {}
    void restorePluginStateFromValueTree (const juce::ValueTree&) override {}

    void applyToBuffer (const te::PluginRenderContext& fc) override
    {
        if (proc == nullptr || fc.destBuffer == nullptr || fc.bufferNumSamples <= 0) return;
        auto& b = *fc.destBuffer;
        if (b.getNumChannels() < 2) return;
        const auto pos = (int64_t) std::llround (fc.editTime.getStart().inSeconds() * projectRate);
        // Pre-roll blocks before the start of the project carry silence and no notes.
        proc->process (b.getWritePointer (0, fc.bufferStartSample), b.getWritePointer (1, fc.bufferStartSample),
                       fc.bufferNumSamples, pos);
    }

private:
    Processor* proc = nullptr;
    bool prepared = false;
};

const char* CfPlugin::xmlTypeName = "cfdevice";

/** Sets an aux send's level from the send's automation each block, just before the send. */
struct SendControl : Processor
{
    te::AuxSendPlugin* send = nullptr;
    Param level;
    double sr = 48000;
    void prepare (double s) override { sr = s; }
    void process (float*, float*, int, int64_t pos) override
    {
        if (send != nullptr)
            send->gain->setParameter (te::decibelsToVolumeFaderPosition ((float) level.at ((double) pos / sr)), juce::dontSendNotification);
    }
};

//==============================================================================
struct Content
{
    juce::File dir;
    juce::var manifest;
    std::vector<std::string> instruments, kits, presets;
    std::map<std::string, juce::var> zones;

    void load (const juce::File& d)
    {
        dir = d;
        auto file = d.getChildFile ("manifest.json");
        if (! file.existsAsFile()) return;
        manifest = juce::JSON::parse (file);
        for (auto& v : *manifest["instruments"].getArray()) instruments.push_back (v.toString().toStdString());
        for (auto& v : *manifest["kits"].getArray()) kits.push_back (v.toString().toStdString());
        if (auto* o = manifest["presets"].getDynamicObject())
            for (auto& p : o->getProperties()) presets.push_back (p.name.toString().toStdString());
    }

    const juce::var& zonesFor (const std::string& name)
    {
        auto it = zones.find (name);
        if (it != zones.end()) return it->second;
        auto file = dir.getChildFile (juce::String (name)).getChildFile ("zones.json");
        if (! file.existsAsFile()) fail ("", "the content for " + name + " is missing from " + dir.getFullPathName().toStdString(), "engine_error");
        return zones[name] = juce::JSON::parse (file);
    }
};

//==============================================================================
struct AudioFiles
{
    juce::AudioFormatManager formats;
    std::map<std::string, std::shared_ptr<Audio>> cache;
    AudioFiles() { formats.registerBasicFormats(); }

    std::shared_ptr<Audio> load (const std::string& path, const std::string& where)
    {
        auto it = cache.find (path);
        if (it != cache.end()) return it->second;
        juce::File f (juce::String::fromUTF8 (path.c_str()));
        if (! juce::File::isAbsolutePath (juce::String::fromUTF8 (path.c_str())))
            fail (where, "the file must be an absolute path: " + path);
        if (! f.existsAsFile()) fail (where, "no such file: " + path, "not_found");
        std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (f));
        if (reader == nullptr) fail (where, "not an audio file cf-music reads (WAV, FLAC, AIFF, Ogg): " + path);
        if (reader->lengthInSamples <= 0 || reader->numChannels < 1) fail (where, "the file has no audio: " + path);
        auto a = std::make_shared<Audio>();
        a->rate = reader->sampleRate;
        const auto n = (int) reader->lengthInSamples;
        juce::AudioBuffer<float> buf ((int) std::min<unsigned> (reader->numChannels, 2), n);
        reader->read (&buf, 0, n, 0, true, true);
        a->left.assign (buf.getReadPointer (0), buf.getReadPointer (0) + n);
        if (buf.getNumChannels() > 1) a->right.assign (buf.getReadPointer (1), buf.getReadPointer (1) + n);
        cache[path] = a;
        return a;
    }
};

//==============================================================================
/** Reads, checks and binds the whole project. Throws ProjectError. */
struct Loader
{
    Content& content;
    AudioFiles& files;
    std::map<std::string, DeviceDef> defs;
    Project project;

    Loader (Content& c, AudioFiles& f) : content (c), files (f), defs (deviceDefs (c.instruments, c.kits, c.presets)) {}

    void load (const juce::var& root)
    {
        Reader r { defs };
        Reader::onlyKeys (root, "", { "version", "sample_rate", "from", "until", "tail_db", "tail_max_seconds", "alone", "tracks", "master", "automation" });
        if (! root.hasProperty ("version") || (int) root["version"] != 1 || ! isNumber (root["version"])) fail ("version", "must be 1");
        const auto rate = Reader::number (root, "sample_rate", "", 0, 1e6);
        if (rate != 44100 && rate != 48000) fail ("sample_rate", "must be 44100 or 48000");
        project.sampleRate = (int) rate;
        project.from = Reader::number (root, "from", "", 0, 1e6);
        project.until = Reader::number (root, "until", "", 0, 1e6);
        if (project.until <= project.from) fail ("until", "must be after from");
        if (root.hasProperty ("tail_db"))
        {
            project.tailDb = Reader::number (root, "tail_db", "", -200, -1e-9);
            project.tailMax = Reader::number (root, "tail_max_seconds", "", 1e-3, 3600);
        }
        else if (root.hasProperty ("tail_max_seconds")) fail ("tail_max_seconds", "is only for a render with tail_db");

        const auto& tracks = Reader::field (root, "tracks", "");
        if (! tracks.isArray()) fail ("tracks", "must be a list");
        std::set<std::string> deviceIds, sendIds;
        for (int i = 0; i < tracks.size(); ++i)
        {
            const auto path = "tracks[" + std::to_string (i) + "]";
            const auto& v = tracks[i];
            Reader::onlyKeys (v, path, { "id", "gain_db", "pan", "output", "devices", "sends", "notes", "clips" });
            TrackDef t;
            t.path = path;
            t.id = Reader::string (v, "id", path);
            for (auto& other : project.tracks)
                if (other.id == t.id) fail (path + ".id", "track id " + t.id + " is used twice");
            t.gain_db = Reader::number (v, "gain_db", path, -120, 24);
            t.pan = Reader::number (v, "pan", path, -1, 1);
            t.gain = { t.gain_db, nullptr };
            t.panParam = { t.pan, nullptr };
            t.output = Reader::string (v, "output", path);
            const auto& devices = Reader::field (v, "devices", path);
            if (! devices.isArray()) fail (path + ".devices", "must be a list");
            bool effectSeen = false;
            for (int k = 0; k < devices.size(); ++k)
            {
                auto d = r.device (devices[k], path + ".devices[" + std::to_string (k) + "]");
                if (! deviceIds.insert (d.id).second) fail (d.path + ".id", "device id " + d.id + " is used twice");
                if (d.def->instrument() && effectSeen) fail (d.path, d.name + " is an instrument after an effect: instruments come first on a track");
                effectSeen = effectSeen || ! d.def->instrument();
                t.devices.push_back (std::move (d));
            }
            const auto& sends = Reader::field (v, "sends", path);
            if (! sends.isArray()) fail (path + ".sends", "must be a list");
            for (int k = 0; k < sends.size(); ++k)
            {
                const auto sp = path + ".sends[" + std::to_string (k) + "]";
                Reader::onlyKeys (sends[k], sp, { "id", "to", "level_db", "before_gain" });
                Send s;
                s.path = sp;
                s.id = Reader::string (sends[k], "id", sp);
                if (! sendIds.insert (s.id).second) fail (sp + ".id", "send id " + s.id + " is used twice");
                s.to = Reader::string (sends[k], "to", sp);
                s.level_db = Reader::number (sends[k], "level_db", sp, -120, 6);
                s.before_gain = Reader::boolean (sends[k], "before_gain", sp);
                s.level = { s.level_db, nullptr };
                t.sends.push_back (s);
            }
            const auto& notes = Reader::field (v, "notes", path);
            if (! notes.isArray()) fail (path + ".notes", "must be a list");
            for (int k = 0; k < notes.size(); ++k)
                t.notes.push_back (r.note (notes[k], path + ".notes[" + std::to_string (k) + "]"));
            const auto& clips = Reader::field (v, "clips", path);
            if (! clips.isArray()) fail (path + ".clips", "must be a list");
            for (int k = 0; k < clips.size(); ++k)
                t.clips.push_back (r.clip (clips[k], path + ".clips[" + std::to_string (k) + "]"));
            project.tracks.push_back (std::move (t));
        }

        if (root.hasProperty ("master"))
        {
            const auto& m = root["master"];
            Reader::onlyKeys (m, "master", { "devices" });
            const auto& devices = Reader::field (m, "devices", "master");
            if (! devices.isArray()) fail ("master.devices", "must be a list");
            for (int k = 0; k < devices.size(); ++k)
            {
                auto d = r.device (devices[k], "master.devices[" + std::to_string (k) + "]");
                if (! deviceIds.insert (d.id).second) fail (d.path + ".id", "device id " + d.id + " is used twice");
                if (d.def->instrument()) fail (d.path, d.name + " is an instrument: the master takes effects only");
                project.master.push_back (std::move (d));
            }
        }

        if (root.hasProperty ("alone"))
        {
            const auto& alone = root["alone"];
            if (! alone.isArray()) fail ("alone", "must be a list of track ids");
            for (int i = 0; i < alone.size(); ++i)
            {
                const auto id = alone[i].toString().toStdString();
                if (track (id) == nullptr) fail ("alone[" + std::to_string (i) + "]", "no track " + id);
                project.alone.push_back (id);
            }
            for (auto& t : project.tracks)
                t.sounds = std::find (project.alone.begin(), project.alone.end(), t.id) != project.alone.end();
        }

        routing();
        if (root.hasProperty ("automation")) automation (root["automation"]);
        files_();
    }

    TrackDef* track (const std::string& id)
    {
        for (auto& t : project.tracks) if (t.id == id) return &t;
        return nullptr;
    }

    void routing()
    {
        for (auto& t : project.tracks)
        {
            if (t.output != "master")
            {
                if (t.output == t.id) fail (t.path + ".output", "a track cannot output to itself");
                if (track (t.output) == nullptr) fail (t.path + ".output", "no track " + t.output + " (master or a track id)");
            }
            for (auto& s : t.sends)
            {
                if (s.to == t.id) fail (s.path + ".to", "a track cannot send to itself");
                if (track (s.to) == nullptr) fail (s.path + ".to", "no track " + s.to);
            }
            bool instrument = false;
            for (auto& d : t.devices) instrument = instrument || (d.def->instrument() && d.enabled);
            if (t.sounds && ! t.notes.empty() && ! instrument)
                fail (t.path + ".notes", "the track has notes but no instrument to play them");
        }
        // Outputs and sends must not loop back.
        std::map<std::string, int> state;
        std::function<void (TrackDef&, std::string)> visit = [&] (TrackDef& t, std::string chain)
        {
            auto& s = state[t.id];
            if (s == 2) return;
            if (s == 1) fail (t.path, "routing loops back: " + chain);
            s = 1;
            if (t.output != "master") visit (*track (t.output), chain + " -> " + t.output);
            for (auto& send : t.sends) visit (*track (send.to), chain + " -> " + send.to);
            s = 2;
        };
        for (auto& t : project.tracks) visit (t, t.id);
        // One aux bus per track that receives sends.
        std::map<std::string, int> bus;
        for (auto& t : project.tracks)
            for (auto& s : t.sends)
            {
                if (! bus.count (s.to)) { const int b = (int) bus.size(); bus[s.to] = b; }
                s.bus = bus[s.to];
            }
    }

    void automation (const juce::var& list)
    {
        if (! list.isArray()) fail ("automation", "must be a list");
        std::set<std::string> seen;
        for (int i = 0; i < list.size(); ++i)
        {
            const auto path = "automation[" + std::to_string (i) + "]";
            const auto& a = list[i];
            Reader::onlyKeys (a, path, { "target", "points" });
            const auto& target = Reader::field (a, "target", path);
            Reader::onlyKeys (target, path + ".target", { "track", "send", "device", "param" });
            const auto param = Reader::string (target, "param", path + ".target");
            Param* p = nullptr;
            double lo = 0, hi = 0;
            std::string key;
            if (target.hasProperty ("track"))
            {
                const auto id = target["track"].toString().toStdString();
                auto* t = track (id);
                if (t == nullptr) fail (path + ".target.track", "no track " + id);
                if (param == "gain_db") { p = &t->gain; lo = -120; hi = 24; }
                else if (param == "pan") { p = &t->panParam; lo = -1; hi = 1; }
                else fail (path + ".target.param", "a track's automatable params are gain_db and pan");
                key = "track:" + id + ":" + param;
            }
            else if (target.hasProperty ("send"))
            {
                const auto id = target["send"].toString().toStdString();
                for (auto& t : project.tracks) for (auto& s : t.sends) if (s.id == id) p = &s.level;
                if (p == nullptr) fail (path + ".target.send", "no send " + id);
                if (param != "level_db") fail (path + ".target.param", "a send's automatable param is level_db");
                lo = -120; hi = 6;
                key = "send:" + id;
            }
            else if (target.hasProperty ("device"))
            {
                const auto id = target["device"].toString().toStdString();
                Device* d = nullptr;
                for (auto& t : project.tracks) for (auto& dv : t.devices) if (dv.id == id) d = &dv;
                for (auto& dv : project.master) if (dv.id == id) d = &dv;
                if (d == nullptr) fail (path + ".target.device", "no device " + id);
                auto it = d->numbers.find (param);
                if (it == d->numbers.end() || ! it->second.automatable)
                {
                    std::string names;
                    for (auto& [k, n] : d->numbers) if (n.automatable) names += (names.empty() ? "" : ", ") + k;
                    fail (path + ".target.param", d->name + " has no automatable param " + param + " (automatable: " + names + ")");
                }
                p = &it->second.param;
                lo = it->second.min; hi = it->second.max;
                key = "device:" + id + ":" + param;
            }
            else fail (path + ".target", "needs track, send or device");
            if (! seen.insert (key).second) fail (path + ".target", "this param is automated twice");

            const auto& points = Reader::field (a, "points", path);
            if (! points.isArray() || points.size() < 1) fail (path + ".points", "must be a list of one or more points");
            auto curve = std::make_unique<Curve>();
            for (int k = 0; k < points.size(); ++k)
            {
                const auto pp = path + ".points[" + std::to_string (k) + "]";
                Reader::onlyKeys (points[k], pp, { "time", "value", "curve" });
                CurvePoint cp;
                cp.time = Reader::number (points[k], "time", pp, 0, 1e7);
                cp.value = Reader::number (points[k], "value", pp, lo, hi);
                const auto shape = Reader::string (points[k], "curve", pp);
                if (shape == "hold") cp.shape = CurveShape::hold;
                else if (shape == "linear") cp.shape = CurveShape::linear;
                else if (shape == "smooth") cp.shape = CurveShape::smooth;
                else fail (pp + ".curve", "'" + shape + "' is not one of hold, linear, smooth");
                if (! curve->points.empty() && cp.time < curve->points.back().time) fail (pp + ".time", "points must be in time order");
                curve->points.push_back (cp);
            }
            p->curve = curve.get();
            project.curves.push_back (std::move (curve));
        }
    }

    /** Reads every file the project names, and checks ranges against their lengths. */
    void files_()
    {
        for (auto& t : project.tracks)
        {
            for (auto& c : t.clips)
            {
                auto a = files.load (c.file, c.path + ".file");
                const double length = (double) a->frames() / a->rate;
                if (c.from >= length) fail (c.path + ".from", fmt (c.from) + " s is past the end of the file (" + fmt (length) + " s)");
                if (c.until && *c.until > length + 1.0 / a->rate) fail (c.path + ".until", fmt (*c.until) + " s is past the end of the file (" + fmt (length) + " s)");
            }
            for (auto& d : t.devices)
            {
                if (d.def->kind != DeviceKind::sampler) continue;
                const auto file = d.str ("file");
                auto a = files.load (file, d.path + ".params.file");
                const double length = (double) a->frames() / a->rate;
                const double from = d.numbers.at ("from_seconds").value;
                if (from >= length) fail (d.path + ".params.from_seconds", fmt (from) + " s is past the end of the file (" + fmt (length) + " s)");
                if (d.numbers.count ("until_seconds"))
                {
                    const double until = d.numbers.at ("until_seconds").value;
                    if (until <= from) fail (d.path + ".params.until_seconds", "must be after from_seconds");
                    if (until > length + 1.0 / a->rate) fail (d.path + ".params.until_seconds", fmt (until) + " s is past the end of the file (" + fmt (length) + " s)");
                }
                if ((bool) d.params["loop"] && (bool) d.params["one_shot"]) fail (d.path + ".params", "loop and one_shot cannot both be true");
                const auto& slices = d.params["slices"];
                if (slices.isArray())
                {
                    std::set<double> notes;
                    for (int i = 0; i < slices.size(); ++i)
                    {
                        const auto sp = d.path + ".params.slices[" + std::to_string (i) + "]";
                        const double a0 = slices[i]["from_seconds"], b0 = slices[i]["until_seconds"];
                        if (b0 <= a0) fail (sp + ".until_seconds", "must be after from_seconds");
                        if (b0 > length + 1.0 / a->rate) fail (sp + ".until_seconds", fmt (b0) + " s is past the end of the file (" + fmt (length) + " s)");
                        if (! notes.insert ((double) slices[i]["note"]).second) fail (sp + ".note", "two slices on one note");
                    }
                }
            }
        }
    }
};

//==============================================================================
std::shared_ptr<Audio> zoneAudio (Content& content, AudioFiles& files, const std::string& name, const juce::var& zone)
{
    const auto file = content.dir.getChildFile (juce::String (name)).getChildFile (zone["file"].toString());
    return files.load (file.getFullPathName().toStdString(), name);
}

std::vector<Note> playedNotes (const TrackDef& t, const Project& p)
{
    std::vector<Note> notes;
    if (! t.sounds) return notes;
    for (auto& n : t.notes)
    {
        // With a tail, nothing starts at or after `until`: what sounds is what rings on. Without
        // one, later notes stay: a lookahead (the limiter's) hears them as a full render would.
        if (p.tailDb && n.start >= p.until) continue;
        notes.push_back (n);
    }
    std::stable_sort (notes.begin(), notes.end(), [] (const Note& a, const Note& b) { return a.start < b.start; });
    return notes;
}

Param fixed (double v) { return { v, nullptr }; }

FilterType filterType (const std::string& s) { return s == "highpass" ? FilterType::highpass : s == "bandpass" ? FilterType::bandpass : FilterType::lowpass; }
int slopeOf (const juce::var& v) { return v.isString() ? v.toString().getIntValue() : (int) v; }

/** Builds the synth from params, or from a preset with gain_db, attack_ms and release_ms. */
std::unique_ptr<Synth> makeSynth (const Device& d, const juce::var& params, bool preset, uint32_t seed)
{
    auto s = std::make_unique<Synth>();
    s->seed = seed;
    auto num = [&] (const std::string& key) -> Param {
        if (! preset) return d.p (key);
        // Presets are plain numbers from the manifest.
        juce::var v = params;
        juce::StringArray parts;
        parts.addTokens (juce::String (key), ".", "");
        for (auto& part : parts)
        {
            if (part.contains ("["))
            {
                v = v[juce::Identifier (part.upToFirstOccurrenceOf ("[", false, false))];
                v = v[part.fromFirstOccurrenceOf ("[", false, false).getIntValue()];
            }
            else v = v[juce::Identifier (part)];
        }
        return fixed ((double) v);
    };
    const auto& oscs = params["oscillators"];
    for (int i = 0; i < oscs.size(); ++i)
    {
        const auto w = oscs[i]["wave"].toString();
        Oscillator o;
        o.wave = w == "saw" ? Wave::saw : w == "square" ? Wave::square : w == "triangle" ? Wave::triangle : w == "noise" ? Wave::noise : Wave::sine;
        o.octave = (int) oscs[i]["octave"];
        const auto k = "oscillators[" + std::to_string (i) + "].";
        o.detune = num (k + "detune_cents");
        o.level = num (k + "level");
        s->oscs.push_back (o);
    }
    const auto& filter = params["filter"];
    if (filter.isObject())
    {
        s->hasFilter = true;
        s->filterType = filterType (filter["type"].toString().toStdString());
        s->filterSlope = filter.hasProperty ("slope_db_per_octave") ? slopeOf (filter["slope_db_per_octave"]) : 12;
        s->cutoff = num ("filter.cutoff_hz");
        s->resonance = num ("filter.resonance");
    }
    s->ampA = num ("amp_envelope.attack_ms");
    s->ampD = num ("amp_envelope.decay_ms");
    s->ampS = num ("amp_envelope.sustain");
    s->ampR = num ("amp_envelope.release_ms");
    if (params["filter_envelope"].isObject())
    {
        s->hasFilterEnv = true;
        s->fA = num ("filter_envelope.attack_ms");
        s->fD = num ("filter_envelope.decay_ms");
        s->fS = num ("filter_envelope.sustain");
        s->fR = num ("filter_envelope.release_ms");
        s->fAmount = num ("filter_envelope.amount_octaves");
    }
    s->glide = num ("glide_ms");
    if (preset)
    {
        // The device's own attack, release and gain.
        s->ampA = d.p ("attack_ms");
        s->ampR = d.p ("release_ms");
        s->gain = d.p ("gain_db");
    }
    else s->gain = d.p ("gain_db");
    return s;
}

std::unique_ptr<Processor> makeDevice (const Device& d, const TrackDef* track, const Project& project, Content& content, AudioFiles& files, uint32_t seed)
{
    const auto notes = track != nullptr ? playedNotes (*track, project) : std::vector<Note> {};
    switch (d.def->kind)
    {
        case DeviceKind::synth:
        {
            const bool preset = std::find (content.presets.begin(), content.presets.end(), d.name) != content.presets.end();
            auto s = makeSynth (d, preset ? content.manifest["presets"][juce::Identifier (d.name)] : d.params, preset, seed);
            s->notes = notes;
            return s;
        }
        case DeviceKind::sampler:
        {
            auto s = std::make_unique<Sampler>();
            auto a = files.load (d.str ("file"), d.path + ".params.file");
            s->oneShot = (bool) d.params["one_shot"];
            s->attack = d.p ("attack_ms");
            s->release = d.p ("release_ms");
            s->gain = d.p ("gain_db");
            const auto& slices = d.params["slices"];
            if (slices.isArray())
            {
                for (int i = 0; i < slices.size(); ++i)
                {
                    Zone z;
                    z.audio = a;
                    z.exact = true;
                    z.root = (double) slices[i]["note"];
                    z.from = (int64_t) std::llround ((double) slices[i]["from_seconds"] * a->rate);
                    z.until = std::min (a->frames(), (int64_t) std::llround ((double) slices[i]["until_seconds"] * a->rate));
                    s->zones.push_back (z);
                }
            }
            else
            {
                Zone z;
                z.audio = a;
                z.root = d.numbers.at ("root_note").value;
                z.lo = -1e9; z.hi = 1e9;
                z.from = (int64_t) std::llround (d.numbers.at ("from_seconds").value * a->rate);
                z.until = d.numbers.count ("until_seconds") ? std::min (a->frames(), (int64_t) std::llround (d.numbers.at ("until_seconds").value * a->rate)) : a->frames();
                if ((bool) d.params["loop"]) { z.loopFrom = z.from; z.loopUntil = z.until; }
                s->zones.push_back (z);
            }
            s->notes = notes;
            return s;
        }
        case DeviceKind::named:
        case DeviceKind::kit:
        {
            auto s = std::make_unique<Sampler>();
            const auto& doc = content.zonesFor (d.name);
            s->layered = true;
            s->oneShot = d.def->kind == DeviceKind::kit;
            s->gain = d.p ("gain_db");
            s->attack = s->oneShot ? fixed (0) : d.p ("attack_ms");
            s->release = s->oneShot ? fixed (0) : d.p ("release_ms");
            if (const auto* groups = doc["choke_groups"].getArray())
                for (auto& g : *groups)
                {
                    std::vector<int> group;
                    for (auto& p : *g.getArray()) group.push_back ((int) p);
                    s->chokeGroups.push_back (group);
                }
            // Load only the zones these notes play.
            const auto& all = *doc["zones"].getArray();
            std::vector<Zone> zones;
            for (auto& zv : all)
            {
                Zone z;
                z.root = (double) zv["root"]; z.lo = (double) zv["lo"]; z.hi = (double) zv["hi"];
                z.exact = s->oneShot;
                z.vel = (int) zv["vel"]; z.vlo = (int) zv["vlo"]; z.vhi = (int) zv["vhi"];
                z.from = 0;
                z.until = (int64_t) (double) zv["frames"];
                if (zv["loop"].isArray()) { z.loopFrom = (int64_t) (double) zv["loop"][0]; z.loopUntil = (int64_t) (double) zv["loop"][1]; }
                zones.push_back (z);
            }
            s->zones = zones;
            std::set<size_t> used;
            for (auto& n : notes)
                if (auto* z = s->find (n.pitch, n.velocity)) used.insert ((size_t) (z - s->zones.data()));
            for (auto i : used)
            {
                s->zones[i].audio = zoneAudio (content, files, d.name, all[(int) i]);
                s->zones[i].until = std::min (s->zones[i].until, s->zones[i].audio->frames());
            }
            // Zones no note plays stay unloaded and are dropped.
            std::vector<Zone> kept;
            for (auto& z : s->zones) if (z.audio) kept.push_back (z);
            s->zones = kept;
            s->notes = notes;
            return s;
        }
        case DeviceKind::gain: { auto g = std::make_unique<GainFx>(); g->gain = d.p ("gain_db"); return g; }
        case DeviceKind::filter:
        {
            auto f = std::make_unique<FilterFx>();
            f->type = filterType (d.str ("type"));
            f->slope = slopeOf (d.params["slope_db_per_octave"]);
            f->cutoff = d.p ("cutoff_hz");
            f->resonance = d.p ("resonance");
            return f;
        }
        case DeviceKind::eq:
        {
            auto e = std::make_unique<EqFx>();
            const auto& bands = d.params["bands"];
            for (int i = 0; i < bands.size(); ++i)
            {
                const auto t = bands[i]["type"].toString();
                const auto k = "bands[" + std::to_string (i) + "].";
                EqBand b;
                b.type = t == "low_shelf" ? BandType::lowShelf : t == "high_shelf" ? BandType::highShelf : t == "lowpass" ? BandType::lowpass : t == "highpass" ? BandType::highpass : BandType::peak;
                b.slope = slopeOf (bands[i]["slope_db_per_octave"]);
                b.hz = d.p (k + "hz"); b.gain = d.p (k + "gain_db"); b.q = d.p (k + "q");
                e->bands.push_back (b);
            }
            return e;
        }
        case DeviceKind::compressor:
        {
            auto c = std::make_unique<CompressorFx>();
            c->threshold = d.p ("threshold_db"); c->ratio = d.p ("ratio"); c->attack = d.p ("attack_ms");
            c->release = d.p ("release_ms"); c->makeup = d.p ("makeup_db");
            return c;
        }
        case DeviceKind::limiter: { auto l = std::make_unique<LimiterFx> ((double) project.sampleRate); l->ceiling = d.p ("ceiling_dbtp"); l->release = d.p ("release_ms"); return l; }
        case DeviceKind::reverb:
        {
            auto r = std::make_unique<ReverbFx>();
            r->size = d.p ("size"); r->decay = d.p ("decay_seconds"); r->damping = d.p ("damping"); r->wet = d.p ("wet"); r->dry = d.p ("dry");
            return r;
        }
        case DeviceKind::delay: { auto x = std::make_unique<DelayFx>(); x->time = d.p ("time_ms"); x->feedback = d.p ("feedback"); x->wet = d.p ("wet"); return x; }
        case DeviceKind::chorus: { auto x = std::make_unique<ChorusFx>(); x->rate = d.p ("rate_hz"); x->depth = d.p ("depth"); x->wet = d.p ("wet"); return x; }
        case DeviceKind::saturation: { auto x = std::make_unique<SaturationFx>(); x->drive = d.p ("drive_db"); x->wet = d.p ("wet"); return x; }
    }
    fail (d.path, "device " + d.name + " cannot be built", "engine_error");
}

/** A clip's audio at the project rate: cut to its source range, stretched with pitch kept. */
std::shared_ptr<Audio> clipAudio (const ClipDef& c, AudioFiles& files, double sr)
{
    auto src = files.load (c.file, c.path + ".file");
    const auto a = (int64_t) std::llround (c.from * src->rate);
    const auto b = c.until ? std::min (src->frames(), (int64_t) std::llround (*c.until * src->rate)) : src->frames();
    const int channels = src->right.empty() ? 1 : 2;
    std::vector<std::vector<float>> cut ((size_t) channels);
    for (int ch = 0; ch < channels; ++ch)
        cut[(size_t) ch].assign (src->channel (ch) + a, src->channel (ch) + b);
    double rate = src->rate;
    if (c.stretch_to)
    {
        const auto outFrames = (int) std::llround (*c.stretch_to * src->rate);
        signalsmith::stretch::SignalsmithStretch<float> stretch (0L);
        stretch.presetDefault (channels, (float) src->rate);
        std::vector<std::vector<float>> out ((size_t) channels, std::vector<float> ((size_t) outFrames));
        std::vector<float*> in ((size_t) channels), outp ((size_t) channels);
        for (int ch = 0; ch < channels; ++ch) { in[(size_t) ch] = cut[(size_t) ch].data(); outp[(size_t) ch] = out[(size_t) ch].data(); }
        if (! stretch.exact (in.data(), (int) (b - a), outp.data(), outFrames))
            fail (c.path + ".stretch_to", "the source range is too short to stretch (" + fmt ((double) (b - a) / src->rate) + " s)");
        cut = std::move (out);
    }
    auto result = std::make_shared<Audio>();
    result->rate = sr;
    auto toRate = [&] (const std::vector<float>& x) {
        if (rate == sr) return x;
        const auto n = (int64_t) std::llround ((double) x.size() * sr / rate);
        std::vector<float> y ((size_t) n);
        for (int64_t i = 0; i < n; ++i) y[(size_t) i] = (float) hermite (x.data(), (int64_t) x.size(), (double) i * rate / sr);
        return y;
    };
    result->left = toRate (cut[0]);
    if (channels > 1) result->right = toRate (cut[1]);
    return result;
}

//==============================================================================
/** 24-bit PCM WAV, a plain 44-byte header: the same bytes for the same samples. */
struct WavWriter
{
    std::ofstream out;
    int64_t frames = 0;
    int rate;

    WavWriter (const std::string& path, int r) : out (path, std::ios::binary), rate (r)
    {
        if (! out) throw std::runtime_error ("cannot write " + path);
        char header[44] {};
        out.write (header, 44);
    }

    static void u32 (char* p, uint32_t v) { for (int i = 0; i < 4; ++i) p[i] = (char) ((v >> (8 * i)) & 0xff); }
    static void u16 (char* p, uint16_t v) { p[0] = (char) (v & 0xff); p[1] = (char) (v >> 8); }

    int64_t clipped = 0;

    void write (const float* L, const float* R, int n)
    {
        std::vector<char> buf ((size_t) n * 6);
        for (int i = 0; i < n; ++i)
            for (int c = 0; c < 2; ++c)
            {
                const double x = (c == 0 ? L : R)[i];
                auto q = (int64_t) std::llround (x * 8388608.0);
                if (q > 8388607 || q < -8388608) { ++clipped; q = std::clamp<int64_t> (q, -8388608, 8388607); }
                const auto v = (uint32_t) q;
                char* p = buf.data() + (size_t) (i * 6 + c * 3);
                p[0] = (char) (v & 0xff); p[1] = (char) ((v >> 8) & 0xff); p[2] = (char) ((v >> 16) & 0xff);
            }
        out.write (buf.data(), (std::streamsize) buf.size());
        frames += n;
    }

    void close()
    {
        char h[44];
        const auto data = (uint32_t) (frames * 6);
        std::memcpy (h, "RIFF", 4); u32 (h + 4, 36 + data); std::memcpy (h + 8, "WAVEfmt ", 8);
        u32 (h + 16, 16); u16 (h + 20, 1); u16 (h + 22, 2); u32 (h + 24, (uint32_t) rate);
        u32 (h + 28, (uint32_t) rate * 6); u16 (h + 32, 6); u16 (h + 34, 24);
        std::memcpy (h + 36, "data", 4); u32 (h + 40, data);
        out.seekp (0);
        out.write (h, 44);
        out.close();
    }
};

double msSince (steady_clock::time_point t0) { return duration<double, std::milli> (steady_clock::now() - t0).count(); }

std::string jsonString (const std::string& s)
{
    return juce::JSON::toString (juce::var (juce::String::fromUTF8 (s.c_str())), true).toStdString();
}

void printError (const std::string& code, const std::string& message, const std::string& path)
{
    const auto line = "{\"error\":{\"code\":" + jsonString (code) + ",\"message\":" + jsonString (message)
                      + ",\"path\":" + jsonString (path) + "}}";
    std::cout << line << std::endl;
    std::cerr << line << std::endl;
}

//==============================================================================
juce::var specJson (const Spec& s)
{
    static const char* kinds[] = { "number", "integer", "boolean", "string", "choice", "object", "list" };
    auto* o = new juce::DynamicObject();
    o->setProperty ("kind", kinds[(int) s.kind]);
    if (s.kind == Kind::number || s.kind == Kind::integer) { o->setProperty ("min", s.min); o->setProperty ("max", s.max); o->setProperty ("automatable", s.automatable && s.kind == Kind::number); }
    if (s.kind == Kind::choice) { juce::Array<juce::var> c; for (auto& x : s.choices) c.add (juce::String (x)); o->setProperty ("choices", c); }
    if (s.kind == Kind::list) { o->setProperty ("min_items", s.minItems); o->setProperty ("max_items", s.maxItems); }
    if (s.kind == Kind::object || s.kind == Kind::list)
    {
        auto* f = new juce::DynamicObject();
        for (auto& x : s.fields) f->setProperty (juce::Identifier (x.key), specJson (x));
        o->setProperty ("fields", juce::var (f));
    }
    o->setProperty ("optional", s.optional);
    return juce::var (o);
}

/** Every device and its params as the engine checks them, for comparing with the TypeScript
    catalog. */
int catalog (const juce::File& contentDir)
{
    Content content;
    content.load (contentDir);
    auto* root = new juce::DynamicObject();
    for (auto& [name, def] : deviceDefs (content.instruments, content.kits, content.presets))
    {
        auto* params = new juce::DynamicObject();
        for (auto& s : def.params) params->setProperty (juce::Identifier (s.key), specJson (s));
        auto* d = new juce::DynamicObject();
        d->setProperty ("instrument", def.instrument());
        d->setProperty ("params", juce::var (params));
        root->setProperty (juce::Identifier (name), juce::var (d));
    }
    std::cout << juce::JSON::toString (juce::var (root), true).toStdString() << std::endl;
    return 0;
}

int run (te::Engine& engine, const std::string& command, const juce::StringArray& args)
{
    if (args.size() < (command == "render" ? 2 : 1))
    {
        printError ("bad_request", "usage: cf-music render <project.json> <out.wav> [--content dir] | check <project.json> [--content dir]", "");
        return 2;
    }
    juce::File contentDir (juce::SystemStats::getEnvironmentVariable ("CF_MUSIC_CONTENT", "/usr/share/cuttingfloor/music"));
    for (int i = 0; i < args.size(); ++i)
        if (args[i] == "--content" && i + 1 < args.size()) contentDir = juce::File (args[i + 1]);

    const auto t0 = steady_clock::now();
    Content content;
    content.load (contentDir);
    AudioFiles files;
    Loader loader (content, files);

    juce::File projectFile (args[0]);
    if (! projectFile.existsAsFile()) { printError ("not_found", "no project file " + args[0].toStdString(), ""); return 2; }
    juce::var root;
    const auto parsed = juce::JSON::parse (projectFile.loadFileAsString(), root);
    if (parsed.failed()) { printError ("bad_request", "the project is not JSON: " + parsed.getErrorMessage().toStdString(), ""); return 2; }

    loader.load (root);
    auto& project = loader.project;
    projectRate = project.sampleRate;
    const double sr = project.sampleRate;

    // Build every processor (this loads the samples the notes play) before anything renders.
    struct Chain { std::vector<int> devices; int clips = -1; int fader = -1; std::vector<std::pair<int, const Send*>> pre, post; };
    std::vector<Chain> chains (project.tracks.size());
    std::vector<int> masterChain;
    uint32_t seed = 1;
    auto add = [] (std::unique_ptr<Processor> p) { processors.push_back (std::move (p)); return (int) processors.size() - 1; };
    for (size_t i = 0; i < project.tracks.size(); ++i)
    {
        auto& t = project.tracks[i];
        auto& chain = chains[i];
        if (t.sounds && ! t.clips.empty())
        {
            auto clips = std::make_unique<Clips>();
            for (auto& c : t.clips)
            {
                Clip clip;
                clip.audio = clipAudio (c, files, sr);
                clip.at = (int64_t) std::llround (c.at * sr);
                clip.gain = dbToGain (c.gain_db);
                if (project.tailDb) clip.stop = (int64_t) std::llround (project.until * sr);
                clips->clips.push_back (clip);
            }
            chain.clips = add (std::move (clips));
        }
        for (auto& d : t.devices)
            if (d.enabled) chain.devices.push_back (add (makeDevice (d, &t, project, content, files, seed++)));
        auto fader = std::make_unique<FaderFx>();
        fader->gain = t.gain;
        fader->pan = t.panParam;
        chain.fader = add (std::move (fader));
    }
    for (auto& d : project.master)
        if (d.enabled) masterChain.push_back (add (makeDevice (d, nullptr, project, content, files, seed++)));
    const double loadMs = msSince (t0);

    if (command == "check")
    {
        std::cout << "{\"ok\":true}" << std::endl;
        return 0;
    }

    const juce::File outFile (args[1]);
    const auto untilSample = (int64_t) std::llround (project.until * sr);
    const auto fromSample = (int64_t) std::llround (project.from * sr);
    const auto capSample = project.tailDb ? (int64_t) std::llround ((project.until + project.tailMax) * sr) : untilSample;

    // The Edit: one audio track per part, everything else is cf-music's plugins.
    te::Edit::Options opts { engine, te::createEmptyEdit (engine), te::ProjectItemID::createNewID (te::ProjectID (0)) };
    opts.role = te::Edit::forRendering;
    opts.numAudioTracks = 0;
    opts.defaultMasterVolumedB = 0.0f;
    auto edit = te::Edit::createEdit (std::move (opts));
    if (auto mv = edit->getMasterVolumePlugin()) { mv->setVolumeDb (0.0f); mv->setPan (0.0f); }
    edit->ensureNumberOfAudioTracks ((int) project.tracks.size());
    auto tracks = te::getAudioTracks (*edit);
    if (tracks.size() != (int) project.tracks.size()) fail ("", "could not make the tracks", "engine_error");

    auto plugin = [&] (int index) {
        juce::ValueTree v (te::IDs::PLUGIN);
        v.setProperty (te::IDs::type, CfPlugin::xmlTypeName, nullptr);
        v.setProperty ("cfIndex", index, nullptr);
        auto p = edit->getPluginCache().createNewPlugin (v);
        if (p == nullptr) fail ("", "could not make a plugin", "engine_error");
        return p;
    };
    std::map<std::string, int> busOf;
    for (auto& t : project.tracks) for (auto& s : t.sends) busOf[s.to] = s.bus;

    for (size_t i = 0; i < project.tracks.size(); ++i)
    {
        auto& def = project.tracks[i];
        auto* track = tracks[(int) i];
        track->setName (juce::String (def.id));
        for (auto p : track->pluginList.getPlugins()) p->deleteFromParent();
        int at = 0;
        auto insert = [&] (te::Plugin::Ptr p) { track->pluginList.insertPlugin (p, at++, nullptr); };
        if (busOf.count (def.id))
        {
            auto ret = edit->getPluginCache().createNewPlugin (te::AuxReturnPlugin::xmlTypeName, {});
            dynamic_cast<te::AuxReturnPlugin*> (ret.get())->busNumber = busOf[def.id];
            insert (ret);
        }
        auto& chain = chains[i];
        if (chain.clips >= 0) insert (plugin (chain.clips));
        for (int d : chain.devices) insert (plugin (d));
        auto addSends = [&] (bool before) {
            for (auto& s : def.sends)
            {
                if (s.before_gain != before) continue;
                auto sp = edit->getPluginCache().createNewPlugin (te::AuxSendPlugin::xmlTypeName, {});
                auto* send = dynamic_cast<te::AuxSendPlugin*> (sp.get());
                send->busNumber = s.bus;
                send->setGainDb ((float) s.level.at (0));
                auto ctl = std::make_unique<SendControl>();
                ctl->send = send;
                ctl->level = s.level;
                insert (plugin (add (std::move (ctl))));
                insert (sp);
            }
        };
        addSends (true);
        insert (plugin (chain.fader));
        addSends (false);
    }
    for (size_t i = 0; i < project.tracks.size(); ++i)
    {
        auto& def = project.tracks[i];
        if (def.output == "master") continue;
        for (size_t k = 0; k < project.tracks.size(); ++k)
            if (project.tracks[k].id == def.output)
                tracks[(int) i]->getOutput().setOutputToTrack (tracks[(int) k]);
    }
    int mi = 0;
    for (int d : masterChain) edit->getMasterPluginList().insertPlugin (plugin (d), mi++, nullptr);

    // Render [0, end): always from the start, so a range is the same samples a full render has.
    const auto tmpFile = outFile.getSiblingFile (outFile.getFileName() + ".render.wav");
    tmpFile.deleteFile();
    const auto t1 = steady_clock::now();
    const auto endSeconds = (double) capSample / sr;
    std::vector<float> L, R;
    if (project.tracks.empty())
    {
        L.assign ((size_t) capSample, 0.0f);
        R.assign ((size_t) capSample, 0.0f);
    }
    else
    {
        te::Renderer::Parameters p (*edit);
        p.destFile = tmpFile;
        p.audioFormat = engine.getAudioFileFormatManager().getWavFormat();
        p.bitDepth = 32;
        p.sampleRateForAudio = sr;
        p.blockSizeForAudio = 128;
        p.canRenderInMono = false;
        p.mustRenderInMono = false;
        p.usePlugins = true;
        p.useMasterPlugins = true;
        p.checkNodesForAudio = false;
        p.realTimeRender = false;
        p.ditheringEnabled = false;
        p.tracksToDo = te::toBitSet (te::getAllTracks (*edit));
        p.time = te::TimeRange (te::TimePosition(), te::TimePosition::fromSeconds (endSeconds));
        auto result = te::Renderer::renderToFile ("cf-music", p);
        if (result == juce::File() || ! tmpFile.existsAsFile()) fail ("", "the render failed", "render_failed");
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatReader> reader (wav.createReaderFor (tmpFile.createInputStream().release(), true));
        if (reader == nullptr) fail ("", "could not read the render back", "render_failed");
        const auto n = std::min<int64_t> (reader->lengthInSamples, capSample);
        juce::AudioBuffer<float> buf (2, (int) n);
        reader->read (&buf, 0, (int) n, 0, true, true);
        L.assign (buf.getReadPointer (0), buf.getReadPointer (0) + n);
        R.assign (buf.getReadPointer (1), buf.getReadPointer (1) + n);
        L.resize ((size_t) capSample, 0.0f);
        R.resize ((size_t) capSample, 0.0f);
        reader.reset();
        tmpFile.deleteFile();
    }
    const double renderMs = msSince (t1);

    // Where the sound ends: the last sample over tail_db, between until and the cap.
    int64_t end = untilSample;
    bool capped = false;
    if (project.tailDb)
    {
        const double threshold = dbToGain (*project.tailDb);
        int64_t last = -1;
        for (int64_t k = capSample - 1; k >= untilSample; --k)
            if (std::abs (L[(size_t) k]) > threshold || std::abs (R[(size_t) k]) > threshold) { last = k; break; }
        end = std::max (untilSample, last + 1);
        capped = last == capSample - 1;
    }

    double peak = 0;
    for (int64_t k = fromSample; k < end; ++k)
        peak = std::max ({ peak, (double) std::abs (L[(size_t) k]), (double) std::abs (R[(size_t) k]) });

    WavWriter writer (outFile.getFullPathName().toStdString(), project.sampleRate);
    writer.write (L.data() + fromSample, R.data() + fromSample, (int) (end - fromSample));
    writer.close();

    std::ostringstream o;
    o.precision (10);
    o << "{\"ok\":true,\"file\":" << jsonString (outFile.getFullPathName().toStdString())
      << ",\"sample_rate\":" << project.sampleRate
      << ",\"frames\":" << (end - fromSample)
      << ",\"length_seconds\":" << (double) (end - fromSample) / sr
      << ",\"from_seconds\":" << (double) fromSample / sr;
    if (project.tailDb) o << ",\"ends_seconds\":" << (double) end / sr << ",\"tail_capped\":" << (capped ? "true" : "false");
    o << ",\"sample_peak_dbfs\":";
    if (peak > 0) o << gainToDb (peak); else o << "null";
    o << ",\"clipped_samples\":" << writer.clipped
      << ",\"load_ms\":" << loadMs << ",\"render_ms\":" << renderMs << "}";
    std::cout << o.str() << std::endl;
    return 0;
}
}

int main (int argc, char* argv[])
{
    juce::StringArray args;
    for (int i = 1; i < argc; ++i) args.add (juce::CharPointer_UTF8 (argv[i]));
    if (args.isEmpty()) { cf::printError ("bad_request", "usage: cf-music render|check|catalog|version ...", ""); return 2; }
    const auto command = args[0].toStdString();
    args.remove (0);
    if (command == "version")
    {
        std::cout << "{\"cf_music\":\"" CF_MUSIC_VERSION "\",\"tracktion_engine\":\"" CF_TE_COMMIT "\",\"juce\":\"" CF_JUCE_COMMIT
                     "\",\"signalsmith_stretch\":\"" CF_STRETCH_COMMIT "\"}" << std::endl;
        return 0;
    }
    if (command == "catalog")
    {
        juce::File dir (juce::SystemStats::getEnvironmentVariable ("CF_MUSIC_CONTENT", "/usr/share/cuttingfloor/music"));
        for (int i = 0; i + 1 < args.size(); ++i) if (args[i] == "--content") dir = juce::File (args[i + 1]);
        return cf::catalog (dir);
    }
    if (command != "render" && command != "check") { cf::printError ("bad_request", "unknown command " + command, ""); return 2; }

    // Makes this thread the JUCE message thread; no window or display is ever opened.
    juce::ScopedJuceInitialiser_GUI juceInit;
    cf::QuietLogger quiet;
    juce::Logger::setCurrentLogger (&quiet);
    int rc = 1;
    {
        te::Engine engine (std::make_unique<cf::MemoryStorage>(), std::make_unique<cf::HeadlessUIBehaviour>(), std::make_unique<cf::HeadlessEngineBehaviour>());
        engine.getPluginManager().createBuiltInType<cf::CfPlugin>();
        try
        {
            rc = cf::run (engine, command, args);
        }
        catch (const cf::ProjectError& e)
        {
            cf::printError (e.code, e.what(), e.path);
            rc = e.code == "bad_request" || e.code == "not_found" ? 2 : 1;
        }
        catch (const std::exception& e)
        {
            cf::printError ("engine_error", e.what(), "");
            rc = 1;
        }
        cf::processors.clear();
    }
    juce::Logger::setCurrentLogger (nullptr);
    return rc;
}
