// Things to say to it, in the words people use. Fixes first: rescuing footage is most of editing.
// Each one is within the tools: transcript cuts, gain and loudness, transforms, captions, qa.check.
const PROMPTS = [
  'Music is drowning out my voice. Fix the mix.',
  'Hide my jump cuts with punch-in zooms.',
  'There’s a black flash somewhere around 2:14. Find it and get rid of it.',
  'It rambles. Cut it to the point without losing the jokes.',
  'The captions drifted after I sped it up. Redo them.',
  'Take out every “um” and long pause, but keep it sounding like me.',
  'Mute the swearing, don’t cut it.',
  'Turn this webinar into five 30-second clips, one idea each.',
  'Make a vertical version for Reels: captions centred, logo at the end.',
  'Cut a 15-second trailer to the beat of this song.',
  'Add a lower third with my name the first time I appear.',
  'Put me in front of the product screenshot instead of my messy office.',
  'Write and voice a 20-second intro, then animate the title.',
  'Speed through the setup at 4×, slow down for the result.',
  'Make it loud enough for phones and check it before you send it.',
  'Export for YouTube and hand me an FCPXML so my editor can finish it.',
] as const;

export function Prompts() {
  return (
    <ul className="prompts">
      {PROMPTS.map((p) => (
        <li key={p}>
          <span className="who">You</span>
          {p}
        </li>
      ))}
    </ul>
  );
}
