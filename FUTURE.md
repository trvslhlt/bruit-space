# bruit-space — future ideas

Collected after the first version was built. Nothing here is committed to;
within each group the order is a rough suggested priority. See
[SPEC.md](SPEC.md) for what exists and why.

## Playback variety

- **Rests between passes.** A "gap" setting (0 = seamless, higher = silence
  between passes) so sounds come and go, like a cursory look around. It's a
  small extension of `PassPlayer`'s scheduler.
- **Per-pass pitch/rate variation** (a few semitones either way) and a
  probability that a pass plays reversed.
- **Other start modes.** Instead of a uniformly random start, slowly scan the
  start point through the sample, or hold it fixed.
- **Slow playback-rate drift**, as in radio-tuner (`MAX_DRIFT_RATE_OFFSET`,
  about ±1.5%), paced with bruit-kit's `driftMath`, so long passes of similar
  length don't settle into a repeating pattern. Costs a slight detune.
- **One-shot mode at random intervals** per object ("a creak every 20-60 s")
  rather than continuous playback.
- **Granular texture** for some objects via bruit-kit's `GranularSynth`
  (heavier on CPU).

## The room changing over time

- **Pool rotation.** With 57 files and 15 slots, objects could swap out over
  time so the room evolves without pressing Reshuffle.
- **Swell and fade.** Slow modulation of each object's loudness.
- **Dwell to open.** An object opens by itself after the listener stays near
  it for a few seconds, like opening a box (builds on open/closed).
- **Global slow modulation of the closed cutoff**, like wind.

## Making objects differ from each other

- **Per-file loudness normalization** at load. The samples sit at very
  different levels and the random 0.3-0.8 object gain doesn't correct for it.
  Probably the biggest practical win on this list.
- **Per-object scatter** around the global values: closed cutoff (a trunk
  muffles harder than a box), sample window, reverb wet.
- **Filename-prefix roles.** The sample library's prefixes are semantic
  (`base_`, `texture_`, `gesture_`, `atom_`, `hint_`, `phrase_`, `sound_`,
  `exhibit_`, `damage_`, `effected_`, `original_`). Long quiet `base_` and
  `texture_` files could act as beds with a wide hearing range, and short
  `gesture_`/`atom_`/`hint_` files as events with a small range and a tight
  window.

## Recording

- **Auto-walk.** The listener follows a slow wander path so a take doesn't
  depend on steering by hand.
- **Random seed** for layouts, so a layout that worked can be regenerated.
- **Record and replay the listener's path** over a different layout.

## Decisions and technical notes

- **The sample window is a pure proportion, with no min/max seconds clamp.**
  With this library that means a window of 0.2 gives about 0.25 s on a 1.25 s
  sample and about 10.8 s on the 54 s one. A seconds clamp was considered and
  rejected because it breaks "higher window = longer pass, less randomness"
  for whichever files it clamps. Revisit if the fragments sound wrong by ear.
  The only limit is a 50 ms floor (`MIN_PASS_SECONDS`) so a tiny window can't
  ask for a zero-length fragment.
- **Crossfade level.** An equal-power crossfade keeps unrelated material
  steady, but two fragments of the same pure tone can partly cancel: the test
  measured the quietest 100 ms window at about 0.83x the median. Real samples
  should behave better than a sine, but that hasn't been listened to.
- **Hidden-tab scheduling** is untested (see SPEC.md). If it matters,
  scheduling from a Worker timer would avoid main-thread timer throttling.
- **Promote to bruit-kit?** `PassPlayer` and `planPass` are generic enough
  to move into bruit-kit's `sources` once their shape settles.
- **Stale doc comment in bruit-kit.** `distanceGain`'s comment describes using
  exponent 1 for a reverb send, which bruit-space no longer does (it splits a
  wet fraction instead).
- **Listening checks still owed:** HRTF front/back quality over headphones,
  the default master level (0.9) with loud samples, and the closed-cutoff
  transition (200 Hz, 700 ms).
