---
'cuttingfloor': minor
---

media.analyze measures more of any sound, by signal math: onsets (every step where the level rises by your threshold_db over the step before, with the rise, the level and its share of low, mid and high), notes (the notes one voice or instrument plays or sings, with Hz, note name, cents and level, in beats with a tempo), key (a score for each of the 24 keys and the strength of each note name) and spectrum (third-octave bands from 20 Hz to 20 kHz). loudness with every_seconds also gives the level on steps; beats also gives tempo candidates, a fitted tempo and bar candidates; transcript also runs on a timeline's mix. Calls without the new arguments return what they did.
