# bruit-space — future ideas

Collected after the first version was built. Nothing here is committed to;
within each group the order is a rough suggested priority. Struck-through
items are done. See [SPEC.md](SPEC.md) for what exists and why.

## Playback variety

- ~~**Rests between passes.** A "gap" setting (0 = seamless, higher = silence
  between passes) so sounds come and go, like a cursory look around.~~ Done:
  the Rest probability and Rest max sliders.
- **Rest refinements.** Rests exist (a global probability per pass and a
  maximum duration, each rest uniformly random up to it). Possible additions:
  a minimum duration or a different distribution (mostly short with the
  occasional long one), per-object scatter, and rests scaled to the pass
  length so a 54 s sample and a 1 s one feel comparable. Also, at window 1
  with rests on, passes always start at the sample's beginning, where the
  plain loop starts at a random offset; objects of identical length could
  therefore begin in step until their random rests pull them apart.
- **Per-pass pitch/rate variation** (a few semitones either way) and a
  probability that a pass plays reversed.
- ~~**Other start modes.** Instead of a uniformly random start, slowly scan the
  start point through the sample, or hold it fixed.~~ Done: the `wander` start
  mode (wander speed 0 holds the start still).
- **More start modes.** `random` and `wander` exist. Possible additions: a
  wander with momentum (a drift that keeps its direction rather than gliding
  to a target and retargeting), or a steady scan that sweeps the start
  through the sample.
- **Wander speed per object, or in seconds.** It's global and measured in
  passes, so a sample with long passes evolves more slowly in real time than
  one with short passes. Per-object scatter, or a seconds-based speed, would
  even that out.
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

- ~~**Per-file loudness normalization** at load. The samples sit at very
  different levels and the random 0.3-0.8 object gain doesn't correct for
  it.~~ Done: each object's own RMS is corrected toward a target level (see
  `loudness.ts`), independent of the Loudness slider. A proper LUFS-style
  measurement, a user-facing target-level control, and per-object display of
  the correction applied are still open if the simple RMS approach isn't
  good enough by ear.
- **Per-object scatter** around the global values: closed cutoff (a trunk
  muffles harder than a box), sample window, reverb wet.
- ~~**Degradation beyond reverb.** Objects sound the same kind of "far
  away," just to varying degrees -- distance could color *how* an object
  degrades, not just how much.~~ Done: each object is randomly assigned
  one of 3 two-effect chains (`degradeMath.ts`) that fade in with distance
  the same way reverb does.
- ~~**Independent degrade intensity.** Reused reverb's own Near/Far wet
  sliders at first, which made the degrade chains hard to actually
  hear.~~ Done: a separate Degradation panel with its own Near/Far wet
  pair (`setDegradeMix`, default 0.3/1 -- near deliberately higher than
  reverb's own 0.1, since barely-engaged reverb still reads as a subtle
  tail but barely-engaged degradation is nearly inaudible). Still open: a
  way to reroll or manually pick an object's chain (from the context
  menu?), a 4th+ chain, and exposing which chain an object has anywhere in
  the UI (currently invisible except by ear -- it's engine-internal, not
  stored on `SoundObject`, so nothing else can read or react to it).
- **Filename-prefix roles.** The sample library's prefixes are semantic
  (`base_`, `texture_`, `gesture_`, `atom_`, `hint_`, `phrase_`, `sound_`,
  `exhibit_`, `damage_`, `effected_`, `original_`). Long quiet `base_` and
  `texture_` files could act as beds with a wide hearing range, and short
  `gesture_`/`atom_`/`hint_` files as events with a small range and a tight
  window.

## Selection and the object menu

- ~~**Rectangular multi-select and a right-click menu** for mute/loudness/
  open-closed, applying to a whole selection.~~ Done: drag a marquee over
  empty floor to select several objects; right-click (map or Objects-list
  row) for the menu.
- ~~**Drag a whole selection at once**, constrained so it can't be pushed
  out of the room.~~ Done: dragging any member of a >1-object selection
  moves the whole group together, clamped as one shape at the walls rather
  than per object.
- **Additive selection.** A marquee, or a plain click, always replaces the
  current selection -- no shift-click/shift-drag to add or remove
  individual objects. Would need a small change to `onSelect`'s callers in
  main.ts, not to RoomView's own marquee mechanics.
- **More menu fields.** The menu only covers Mute/Loudness/open-closed
  (what was asked for) -- position (drag remains the only way to move an
  object) and per-object sample-window/wander/rest overrides, once those
  exist per-object at all (see "Per-object scatter" above), would belong
  here too.
- **Delete/duplicate from the menu**, once there's a way to add a single
  object outside of loading a whole folder.

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
  to move into bruit-kit's `sources` once their shape settles. `loudness.ts`
  (RMS + normalizationGain) is equally generic -- no coupling to the room or
  spatial engine -- and could move too.
- **Stale doc comment in bruit-kit.** `distanceGain`'s comment describes using
  exponent 1 for a reverb send, which bruit-space no longer does (it splits a
  wet fraction instead).
- **Listening checks still owed:** HRTF front/back quality over headphones,
  the default master level (0.9) with loud samples, the closed-cutoff
  transition (300 Hz, 1900 ms), and now loudness normalization -- it can
  raise a quiet object's level up to 4x (+12 dB), which combined with the
  existing master-level concern is more headroom pressure to listen for.
