cmake_minimum_required(VERSION 3.22)
project(cf_music VERSION 1.0.0)

# TE_ROOT: a tracktion_engine checkout with modules/juce populated and
# tracktion-offline-render.patch applied. STRETCH_ROOT and LINEAR_ROOT: Signalsmith Stretch and
# Signalsmith Linear checkouts. The Dockerfile's music-engine stage fetches all three at pinned
# commits; CF_TE_COMMIT, CF_JUCE_COMMIT and CF_STRETCH_COMMIT are what `cf-music version` prints.
set(CF_TE_COMMIT "unknown" CACHE STRING "")
set(CF_JUCE_COMMIT "unknown" CACHE STRING "")
set(CF_STRETCH_COMMIT "unknown" CACHE STRING "")

add_subdirectory(${TE_ROOT}/modules/juce ./juce)
add_subdirectory(${TE_ROOT}/modules ./tracktion)

juce_add_console_app(cf-music
    PRODUCT_NAME cf-music
    NEEDS_CURL FALSE
    NEEDS_WEB_BROWSER FALSE)

juce_generate_juce_header(cf-music)
target_compile_features(cf-music PRIVATE cxx_std_20)
target_sources(cf-music PRIVATE src/main.cpp)
target_include_directories(cf-music PRIVATE src ${STRETCH_ROOT}/include ${LINEAR_ROOT}/include)

target_compile_definitions(cf-music PRIVATE
    CF_MUSIC_VERSION="${PROJECT_VERSION}"
    CF_TE_COMMIT="${CF_TE_COMMIT}"
    CF_JUCE_COMMIT="${CF_JUCE_COMMIT}"
    CF_STRETCH_COMMIT="${CF_STRETCH_COMMIT}"
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_STRICT_REFCOUNTEDPOINTER=1
    JUCE_DISPLAY_SPLASH_SCREEN=0
    # No window is ever made: the optional X11 extensions are off, so only libx11-dev is needed.
    JUCE_USE_XINERAMA=0
    JUCE_USE_XSHM=0
    JUCE_USE_XRENDER=0
    JUCE_USE_XCURSOR=0
    JUCE_USE_XINPUT=0
    JUCE_USE_XRANDR=0
    JUCE_ALSA=0
    JUCE_JACK=0
    JUCE_USE_FLAC=1
    JUCE_USE_OGGVORBIS=1
    JUCE_PLUGINHOST_VST3=0
    JUCE_PLUGINHOST_LV2=0
    JUCE_PLUGINHOST_LADSPA=0
    TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH=0
    TRACKTION_LOG_DEVICES=0)

target_link_libraries(cf-music PRIVATE
    tracktion::tracktion_core
    tracktion::tracktion_engine
    tracktion::tracktion_graph
    juce::juce_audio_devices
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_recommended_config_flags)

target_link_libraries(cf-music PRIVATE "-latomic")
