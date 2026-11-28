---
name: nat-pops
description: Nat pops (sound bites) in a music-driven edit with cuttingfloor - the best spoken lines and sounds from the footage break through the music, which ducks under each one and comes back up between them, while the filler talk is cut out. Use when a reel, sizzle, montage, recap or promo has music and the footage has a voice (a commentator, MC, coach, speech, interview, a crowd) or a moment with its own sound worth hearing, or when someone says "let the calls come through", "keep the best lines", "duck the music" or "mix the voice over the music".
version: 1
type: playbook
source: system
author: Ken Wiltshire
related: scoring-to-picture:related, make-a-highlight-reel:related
---

# Nat pops

In a music-driven edit the music carries the piece and the footage's own sound is heard only in short pops: the line or sound that is the moment. Everything else from the footage is off, so the pops land.

## When to use
- Music under footage that has a voice or a sound worth hearing, in a reel, sizzle, montage, recap or promo.

## Prerequisites
- The cuttingfloor MCP server is connected.
- A transcript of the footage with word times (`media.analyze`), and the cut planned or made.

## Steps
1. The assistant should sort what is said into pops and filler. A pop is a short line that is the moment, said with energy: the call as it happens, a reaction, a punchline, the line that names who or what. Filler is setup, scores, small talk and housekeeping. A pop is a phrase of 1 to 3 seconds; a long line is trimmed to its peak words. The footage's own sound can be a pop too: the swish, the crowd erupting, a laugh.
2. The assistant should place each pop on the shot it belongs to, starting on or just before its action. A pop may run under the next shot rather than be clipped, and no cut goes through a word.
3. The assistant should take everything else out of the footage's sound: filler lines cut from the audio, and the room between pops off or very low, never left as murmur under the music.
4. The assistant should duck the music under each pop, about 10 to 12 dB, with ramps of 3 to 4 frames, and bring it back up between pops. A pop that is quiet in the source gets its own gain raised rather than the music dropped further.
5. The assistant should keep the music's biggest moment (the drop, the final hit) clear of every pop: the pop ends just before it, with a beat of near-silence, or the hit moves.
6. The assistant should check the finished export, not the plan: a transcript of the export reads back every pop (one it misses gets more room), and the biggest hit is still the strongest onset in the file.

## Decision table
| Situation | Do |
|---|---|
| A commentator or MC calling the action | The pops are the calls as they happen; the play-by-play between them goes |
| Interviews or testimonials (sizzle, company recap) | The one or two strongest sentences per person, each over its own shot or b-roll; the music thinner under them |
| Speeches (wedding, event) | The line the room reacts to, with the reaction kept as its own pop |
| No voice, strong natural sound | Pop the sound itself for a beat with the music ducked |
| The user wants music only | No pops; the footage's sound off |
| A pop and the music's peak collide | The pop ends first and the peak lands on clear air |

## Required behavior
- Filler is cut, never left as murmur under the music.
- Every pop is confirmed in a transcript of the export.
- The music's biggest moment is never under a voice.
