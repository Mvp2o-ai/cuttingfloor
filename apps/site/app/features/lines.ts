// One plain line per tool for the table on /features, and the group it sits in. The tool names
// themselves come from the server (content/tools.ts); packages/server/test/site-tools.test.ts
// fails when a tool has no line here or a line names a tool the server no longer lists.
// No imports: the server's test reads this file directly.

export type GroupId =
  | 'cut'
  | 'text'
  | 'audio'
  | 'look'
  | 'create'
  | 'analyze'
  | 'review'
  | 'export'
  | 'basics';

export type Line = { group: GroupId; say: string };

export const LINES: Record<string, Line> = {
  // Cut and arrange
  'clip.add': {
    group: 'cut',
    say: 'Put a video, sound, picture or a run of spoken words on the timeline.',
  },
  'clip.remove': { group: 'cut', say: 'Take a clip out, closing the gap or leaving it.' },
  'clip.move': { group: 'cut', say: 'Move a clip to another time or track.' },
  'clip.trim': {
    group: 'cut',
    say: 'Shorten or lengthen a clip from either end, or just its sound (J and L cuts).',
  },
  'clip.split': { group: 'cut', say: 'Cut a clip in two at a frame.' },
  'clip.link': {
    group: 'cut',
    say: 'Make clips move, trim and split together, like picture and its sound.',
  },
  'clip.unlink': { group: 'cut', say: 'Let linked clips move on their own again.' },
  'clip.set_enabled': { group: 'cut', say: 'Turn a clip off without removing it.' },
  'clip.set_speed': {
    group: 'cut',
    say: 'Speed up, slow down, ramp or reverse a clip, keeping the pitch.',
  },
  'clip.freeze': { group: 'cut', say: 'Hold one frame as a freeze frame.' },
  'clip.roll': { group: 'cut', say: 'Move the cut between two clips (a roll edit).' },
  'clip.slip': {
    group: 'cut',
    say: 'Show an earlier or later part of a clip in the same spot (a slip edit).',
  },
  'clip.slide': {
    group: 'cut',
    say: 'Move a clip between its neighbours, which give and take the time (a slide edit).',
  },
  'clip.replace': {
    group: 'cut',
    say: 'Swap the footage in a clip, keeping its place, length and look.',
  },
  'range.lift': { group: 'cut', say: 'Clear a stretch of time on every track, leaving a gap.' },
  'range.extract': {
    group: 'cut',
    say: 'Cut a stretch of time out of every track and close the gap.',
  },
  'track.add': { group: 'cut', say: 'Add a video or audio track.' },
  'track.remove': { group: 'cut', say: 'Remove a track and what is on it.' },
  'track.set': { group: 'cut', say: 'Rename, mute, hide or lock a track.' },
  'timeline.set_sequence': {
    group: 'cut',
    say: 'Change the size, frame rate or sound format, e.g. vertical for Shorts.',
  },
  'edit.batch': { group: 'cut', say: 'Make many edits as one change, all or nothing.' },
  // Captions and text
  'title.add': {
    group: 'text',
    say: 'Add a styled title, with a typewriter or word-by-word reveal.',
  },
  'caption.add': {
    group: 'text',
    say: 'Add captions from the transcript, an SRT or a VTT, with word highlights.',
  },
  'text.set': {
    group: 'text',
    say: 'Change the words or restyle many titles and captions at once.',
  },
  // Audio and voice
  'audio.set_gain': {
    group: 'audio',
    say: 'Set a clip’s volume, or ride it up and down with keyframes.',
  },
  'audio.set_pan': { group: 'audio', say: 'Place a sound left or right.' },
  'audio.fade': { group: 'audio', say: 'Fade a sound in or out.' },
  'audio.set_master': { group: 'audio', say: 'Set the gain and peak limiter on the whole mix.' },
  'create.voiceover': {
    group: 'audio',
    say: 'Turn English text into a natural voiceover, every word timed.',
  },
  'create.stems': {
    group: 'audio',
    say: 'Split sound into voice, drums, bass and everything else.',
  },
  'create.lipsync': {
    group: 'audio',
    say: 'Redraw a speaker’s mouth to match new words (your own sync. labs key).',
  },
  'media.listen': {
    group: 'audio',
    say: 'Find when a sound you describe can be heard: laughter, a cough, applause.',
  },
  'media.correlate': {
    group: 'audio',
    say: 'Find how far apart two recordings are, to line up a camera and a mic.',
  },
  // Look and effects
  'filter.add': {
    group: 'look',
    say: 'Add a picture or sound effect to a clip, a track or the whole video.',
  },
  'filter.set': { group: 'look', say: 'Change an effect’s settings, or switch it off and on.' },
  'filter.remove': { group: 'look', say: 'Take an effect off.' },
  'adjustment.add': {
    group: 'look',
    say: 'Grade or blur everything underneath for a stretch of the video.',
  },
  'transition.add': {
    group: 'look',
    say: 'Add a dissolve, dip, wipe, slide, push, zoom, iris or spin at a cut.',
  },
  'transition.set': { group: 'look', say: 'Change a transition’s kind or length.' },
  'transition.remove': { group: 'look', say: 'Turn a transition back into a hard cut.' },
  'clip.set_transform': {
    group: 'look',
    say: 'Position, scale, rotate, crop, flip or fade a clip, animated with keyframes.',
  },
  'clip.set_blend': {
    group: 'look',
    say: 'Blend a clip with what is below: multiply, screen, overlay and more.',
  },
  'clip.set_mask': {
    group: 'look',
    say: 'Show only part of a clip through a shape, soft-edged or inverted.',
  },
  'clip.set_animation': {
    group: 'look',
    say: 'Add an entrance, exit or looping animation such as pop or float.',
  },
  // Create from nothing
  'create.motion': {
    group: 'create',
    say: 'Turn animated HTML into a motion graphic with transparency.',
  },
  'create.still': {
    group: 'create',
    say: 'Turn an HTML page into a PNG: a title card, thumbnail or overlay.',
  },
  'create.matte': { group: 'create', say: 'Make a solid colour or gradient background.' },
  'create.cutout': {
    group: 'create',
    say: 'Remove the background from a person, product or object.',
  },
  'create.stabilized': { group: 'create', say: 'Steady shaky footage.' },
  'create.upscaled': {
    group: 'create',
    say: 'Enlarge low-resolution footage with detail drawn in.',
  },
  // Analyze and judge
  'media.analyze': {
    group: 'analyze',
    say: 'Read footage as data: transcript, beats, faces, tracking, silences, scenes, speech, loudness, sounds.',
  },
  'media.seek': {
    group: 'analyze',
    say: 'Find the moments that match what you describe in plain words.',
  },
  'judge.ask': {
    group: 'analyze',
    say: 'Get typed answers (yes/no, a choice, a score, a box) about frames and text.',
  },
  // Review
  'render.frames': {
    group: 'review',
    say: 'See frames of the edit or a file, as a contact sheet or full-size stills.',
  },
  'qa.check': {
    group: 'review',
    say: 'Measure the render: gaps, missing media, loudness, true peak, black and silent stretches, cuts mid-word.',
  },
  'timeline.diff': { group: 'review', say: 'Show what changed between two versions of the edit.' },
  'timeline.history': {
    group: 'review',
    say: 'List the edits that made this version, to step back to any of them.',
  },
  // Export
  'export.video': { group: 'export', say: 'Render the edit to MP4, MOV, GIF, WAV or MP3.' },
  'export.timeline': {
    group: 'export',
    say: 'Hand the edit to Final Cut Pro, Premiere or Resolve (FCPXML, OTIO, EDL), or the captions as SRT/VTT.',
  },
  // Media, timelines and jobs
  'timeline.create': { group: 'basics', say: 'Start an empty edit at a size and frame rate.' },
  'timeline.get': { group: 'basics', say: 'Read the whole edit: tracks, clips and media.' },
  'timeline.load': { group: 'basics', say: 'Bring back a saved edit.' },
  'media.import': {
    group: 'basics',
    say: 'Bring in your video, audio, image or font from a link, an upload or a path.',
  },
  'media.upload': { group: 'basics', say: 'Get a link to send a file from your computer.' },
  'media.list': { group: 'basics', say: 'List your media and uploads, with storage used.' },
  'media.get': {
    group: 'basics',
    say: 'A file’s details, a download link and a page to watch it.',
  },
  'media.delete': { group: 'basics', say: 'Delete a file for good.' },
  'job.get': { group: 'basics', say: 'Check on an import, render or other long job.' },
  'job.list': { group: 'basics', say: 'List recent jobs.' },
  'job.cancel': { group: 'basics', say: 'Stop a running job.' },
  'skills.search': { group: 'basics', say: 'Find step-by-step instructions for a common job.' },
  'skills.get': { group: 'basics', say: 'Read one skill in full.' },
  'account.get': { group: 'basics', say: 'See how many credits are left and where to top up.' },
};
