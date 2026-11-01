// The editing jobs creators hate most and the ways AI editors fail, ranked from creator forums,
// Reddit and creator surveys (research of 2026-11-01), each with what a connected agent does about
// it and the tools it does it with. The home page and llms.txt read this list.

export type Pain = { pain: string; answer: string; tools: string[] };

/** The ten editing jobs that take creators longest, most hated first. */
export const EDITING_PAINS: Pain[] = [
  {
    pain: 'Cutting ums, dead air and false starts',
    answer:
      'Cuts on word timings and measured speech edges, never mid-word, then smooths every cut so nothing jumps.',
    tools: ['media.analyze', 'judge.ask', 'range.extract', 'transition.add'],
  },
  {
    pain: 'Captions that are timed and styled by hand',
    answer:
      'Captions straight from the transcript’s word times, each word highlighted as it is said, restyled all at once.',
    tools: ['caption.add', 'text.set'],
  },
  {
    pain: 'Finding B-roll that matches what is said',
    answer:
      'Finds shots from a plain description, lays them over the words that ask for them, or makes the screenshot or graphic it needs.',
    tools: ['media.seek', 'clip.add', 'create.still', 'create.motion'],
  },
  {
    pain: 'Picking the best take',
    answer:
      'Reads every take’s transcript, compares the tries of each line and keeps the clean one.',
    tools: ['media.analyze', 'judge.ask'],
  },
  {
    pain: 'Turning horizontal video vertical',
    answer:
      'Follows faces through the shot and keeps them in frame at 9:16, with a blurred background when there is no face.',
    tools: ['media.analyze', 'timeline.set_sequence', 'clip.set_transform', 'filter.add'],
  },
  {
    pain: 'Finding the moments worth clipping',
    answer:
      'Reads the transcript, searches the video for what you describe and cuts each moment on whole sentences.',
    tools: ['media.analyze', 'media.seek', 'judge.ask'],
  },
  {
    pain: 'Music, sound effects and levels',
    answer:
      'Lowers the music under speech, splits a voice from its music, rides levels with keyframes and masters to a measured loudness.',
    tools: ['audio.set_gain', 'create.stems', 'audio.set_master', 'qa.check'],
  },
  {
    pain: 'Zooms, punch-ins and motion graphics',
    answer:
      'Keyframed pushes, pans and punch-ins on any clip, and animated graphics drawn from HTML with transparency.',
    tools: ['clip.set_animation', 'clip.set_transform', 'create.motion', 'transition.add'],
  },
  {
    pain: 'Stitching AI-generated clips into a film',
    answer:
      'Orders the shots, matches their colour, covers the seams, adds a voiceover, lip-sync and a score.',
    tools: ['filter.add', 'transition.add', 'create.voiceover', 'create.lipsync'],
  },
  {
    pain: 'Every size for every platform',
    answer: 'One edit, re-framed for 9:16, 1:1 and 16:9, each exported with the right preset.',
    tools: ['timeline.set_sequence', 'clip.add', 'export.video'],
  },
];

/** Where AI editors and agents go wrong today, and what is different here. */
export const AGENT_PAINS: Pain[] = [
  {
    pain: 'The agent can’t see or hear what it made',
    answer:
      'Every edit returns a preview. Frames, a review render, exact checks and a plain-words search of the result come back before it ships.',
    tools: ['render.frames', 'qa.check', 'media.seek', 'media.listen'],
  },
  {
    pain: 'Cuts land mid-word and audio clicks',
    answer: 'Cuts go on measured word and speech edges, with short sound crossfades at each one.',
    tools: ['media.analyze', 'transition.add'],
  },
  {
    pain: 'Made-up timecodes and durations',
    answer:
      'Every edit says exactly where each changed clip now sits, so the agent reads positions instead of guessing them.',
    tools: ['timeline.get', 'timeline.diff'],
  },
  {
    pain: 'A black box you can’t adjust',
    answer:
      'Every edit is a timeline you can go back to, take apart or open in your own editor (FCPXML, OTIO, EDL).',
    tools: ['timeline.history', 'export.timeline'],
  },
  {
    pain: 'Credits that burn on every retry',
    answer:
      'Planning and editing are free; only rendering counts, and nothing is billed past the plan. Or run it yourself for free.',
    tools: [],
  },
  {
    pain: 'Broken files: sync drift, frozen frames, gaps',
    answer:
      'Checks for gaps, black frames, clipping and sync before export, and says what it found.',
    tools: ['qa.check'],
  },
  {
    pain: 'FFmpeg setup and plumbing',
    answer: 'Nothing to install: connect the hosted server, or run one Docker image.',
    tools: [],
  },
  {
    pain: 'An AI editor’s taste instead of yours',
    answer:
      'The judgment is your own agent’s, following what you ask for. cuttingfloor makes the cuts and reports the facts.',
    tools: ['judge.ask', 'skills.search'],
  },
];
