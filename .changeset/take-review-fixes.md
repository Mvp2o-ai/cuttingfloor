---
'cuttingfloor': patch
---

Play-along, from the phone app's review of the take boundary:

- A recording redone after a failed send is the one that is placed. Sent to the same upload, the second recording was answered "already complete" and the first was placed where the second was played. `record.session` now answers the `upload` the next recording goes to, a new one once the last holds anything, and `record.take` takes only that upload.
- A recording that cannot be a take is refused while the session is still open: one that ends before the loop starts, and one that runs past the last pass. The passes a recording spans are counted from the recording.
- The loop is found in a take from a microphone that stops at 8 kHz, where it was not found at all.
- A take whose placing could not begin is started by the repeat of its send, where it was answered ok and never placed.
- Over 2,000 taps is refused as a limit, like the others; a WAV header cut short is a refused file, not a server error.
- In the view: a take ends when the sound starts going out another way.
