// Things to say to it, in the words people use. Fixes first: rescuing footage is most of editing.
// Each one is within the tools: transcript cuts, gain and loudness, transforms, captions, qa.check.
const GROUPS = [
  {
    title: 'Fix the cut',
    items: [
      'Hide my jump cuts with punch-in zooms.',
      'There’s a black flash somewhere around 2:14. Find it and get rid of it.',
      'It rambles. Cut it to the point without losing the jokes.',
      'Take out every “um” and long pause, but keep it sounding like me.',
      'Speed through the setup at 4×, slow down for the result.',
    ],
  },
  {
    title: 'Fix the sound, captions and picture',
    items: [
      'Music is drowning out my voice. Fix the mix.',
      'The captions drifted after I sped it up. Redo them.',
      'Mute the swearing, don’t cut it.',
      'Make it loud enough for phones and check it before you send it.',
      'Add a lower third with my name the first time I appear.',
      'Put me in front of the product screenshot instead of my messy office.',
    ],
  },
  {
    title: 'Turn one video into many',
    items: [
      'Turn this webinar into five 30-second clips, one idea each.',
      'Make a vertical version for Reels: captions centred, logo at the end.',
      'Cut a 15-second trailer to the beat of this song.',
    ],
  },
  {
    title: 'Build from your library, or hand it off',
    items: [
      'Write and voice a 20-second intro, then animate the title.',
      'Export for YouTube and hand me an FCPXML so my editor can finish it.',
      'Take our footage library and cut a sixty-second product film.',
    ],
  },
] as const;

export function Prompts() {
  return (
    <ul className="prompts">
      {GROUPS.flatMap((group) => [
        <li key={group.title} className="label">
          {group.title}
        </li>,
        ...group.items.map((p) => (
          <li key={p}>
            <span className="who">You</span>
            {p}
          </li>
        )),
      ])}
    </ul>
  );
}
