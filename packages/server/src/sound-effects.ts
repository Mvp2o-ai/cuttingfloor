// The sound effects pack: short meme and hype sounds (CC0 or made by us), served as files by the
// cuttingfloor site so any server, hosted or your own, can media.import them by url. Credits:
// apps/site/public/sounds/README.md. Listed in video://catalog/sound_effects.

export const SOUND_EFFECTS_URL = 'https://cuttingfloor.ai/sounds';

/** name: what it's for in an edit, and its length in seconds. */
export const SOUND_EFFECTS: Record<string, { use: string; seconds: number }> = {
  boom: { use: 'low "vine boom" style hit on a punchline, a stare or a reveal', seconds: 2.34 },
  'whoosh-fast': { use: 'very short swish for a quick cut or zoom', seconds: 0.43 },
  'whoosh-quick': { use: 'whoosh for transitions and text slides', seconds: 1.86 },
  'whoosh-swoosh': { use: 'longer swoosh for a scene change or camera swing', seconds: 2.21 },
  airhorn: { use: 'hype moment, clutch play, celebration', seconds: 1.51 },
  'record-scratch': { use: '"wait, what?" freeze-frame stop', seconds: 0.45 },
  'fail-buzzer': { use: 'game-show "wrong" buzzer for a whiff or misplay', seconds: 0.99 },
  'sad-trombone': { use: '"wah wah wah" after a death or blunder', seconds: 4.24 },
  ding: { use: 'notification, "correct", a point scored', seconds: 1.87 },
  pop: { use: 'text, emoji or sticker popping in', seconds: 0.18 },
  glitch: { use: 'glitch transition, lag joke, distorted freeze', seconds: 0.7 },
  'camera-shutter': { use: 'screenshot or "caught in 4K" moment', seconds: 3.05 },
  'crowd-cheer': { use: 'win, ace, victory screen', seconds: 3 },
  'audience-laugh': { use: 'sitcom laugh after a fail', seconds: 1.94 },
  'dramatic-sting': { use: 'suspense hit or "uh oh" reveal', seconds: 2.83 },
  riser: { use: 'build-up into a big play or a drop', seconds: 2.74 },
  'bass-drop': { use: 'drop on the hit after a riser', seconds: 3 },
  'cash-register': { use: '"cha-ching": loot, a win, a money joke', seconds: 3 },
  'keyboard-typing': { use: 'typing, chat, rage typing', seconds: 2.5 },
  'time-stop': { use: 'slow-motion or freeze-frame: a reverse swell into a thud', seconds: 2.48 },
  explosion: { use: 'short explosion for a big kill or a meme blast', seconds: 1.98 },
  'ear-ringing': { use: 'ringing after a flashbang or a big hit (quieter on purpose)', seconds: 3 },
};
