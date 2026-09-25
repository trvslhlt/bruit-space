# bruit-space — spec

Status: first version built and verified (`make verify`). Source
conversation: `notes/vscode_chat.txt` plus follow-up answers. Sections below
reflect what was built; where that differs from the original plan it says so.

## What it is

A single-user browser app. A folder of samples becomes looping sound objects
scattered in a 2-D room. A listener with a position and a heading moves through
the room, heard over headphones. Volume falls with distance; direction
(left/right/front/back) is rendered with HRTF. The listener's experience can be
recorded and downloaded as `.wav`.

Immediate purpose: record a loose "exploring an attic" pass. No rummaging
sounds — just the sense of wandering and taking a cursory look. Reusable spatial
components are a bonus, and should land in `bruit-kit`.

## Settled decisions

| Area | Decision |
|---|---|
| Platform | Browser (Chrome), Docker-only, frontend-only (no backend — `relpmas` is the template) |
| Persistence | None. Every session starts fresh |
| Input | `<input webkitdirectory>`; `.wav` / `.mp3` via `decodeAudioData`; `.aif`/`.aiff` via a hand-written parser (`decodeAiff` in bruit-kit), so no conversion step. The real sample folder is 57 files of 24-bit big-endian AIFF |
| Object cap | Configurable, default 15. A larger folder is randomly subsampled; a "reshuffle" re-picks and re-places |
| Placement | Random on load, then drag to adjust |
| Playback | One global **sample window** (0.05–1, default 0.3) sets what share of each sample plays per pass. A pass plays `window × the sample's length` from a start chosen uniformly at random in `[0, 1 − window]` of the sample, so it never runs past the end (higher window = longer pass, less randomness); the next pass then starts, equal-power crossfaded (30 ms). It's a pure proportion: no min/max seconds clamp (considered and rejected, see FUTURE.md) beyond a 50 ms floor so a tiny window on a very short sample can't ask for a zero-length fragment. Window 1 is a plain native loop from a random start offset, exactly the earlier behaviour. **Start mode** (default `wander`) chooses where in `[0, 1 − window]` each pass starts: `random` (independent every pass) or `wander` (each object keeps a start position and a random target, both as fractions of that range; every pass the position glides toward the target by `0.4 × speed²` of the remaining distance, and a new random target is picked once it is within 0.05 of it). Wander speed (default 0.5; 0 holds the start still). Speed is per pass, not per second, and the wander state persists when the window changes. **Rests**: after each pass, with a global probability (default 0.1), the player stays silent for a uniformly random time up to a global maximum (default 650 ms) before the next pass; a rest means no crossfade overlap (the pass fades out completely, the next fades in after). Window 1 with rests on becomes a chain of full-length passes, since a native loop has no end-of-loop to rest after |
| Listener | Position + heading; starts at the bottom edge facing up. Mouse: drag the body to move, drag a nose handle to rotate — a direct 1:1 pointer move, no speed concept. Keyboard: WASD walks *relative to facing* (W forward, A/D strafe), Q/E rotate, all usable simultaneously. **Walk speed** (m/s, default 2) and **turn speed** (deg/s, default 90) are Listener-panel sliders scaling that keyboard movement; both, and **hearing range** (below), live there rather than on the Room panel since they describe the listener's own perception and movement, not the room's geometry |
| Spatialization | HRTF `PannerNode` (front/back EQ and head shadow come from the HRTF itself — no custom filter). Headphones assumed |
| Distance | One attenuation curve shared by all objects, reaching silence at the listener's hearing range (m, default 8, Listener panel). Per-object gain sets how loud each object is, so louder objects are audible from farther away |
| Loudness | Each object's raw RMS level is corrected toward a target (`loudness.ts`, `TARGET_RMS` linear 0.1, roughly −20 dBFS) before anything else is applied, so a quietly-recorded file and a loud one placed at the same distance come out similar. Automatic, not user-facing; independent of and multiplied together with the per-object Loudness slider. Clamped to ±12 dB / −20 dB (`MAX_NORMALIZATION_GAIN` 4, `MIN_NORMALIZATION_GAIN` 0.1) so a near-silent recording isn't boosted into audible noise — the cut side is effectively unreachable for real audio at this target, since a full-scale signal's RMS never exceeds 1 |
| Reverb | One global reverb, listener-independent. Room size maps to decay/pre-delay/damping, not geometry. Each object's *wet fraction* (share of its sound that is reverb vs direct) is interpolated linearly from a "wet at object" setting (listener on top of it, default 0.1) to a "wet at range edge" setting (default 1). Direct = total × (1 − wet), send = total × wet, where total follows the shared distance curve, so both fade to silence together at the hearing range |
| Degradation | Beyond reverb, each object is randomly assigned (once, at placement — `pickDegradeType` in `degradeMath.ts`) one of 3 two-effect bruit-kit chains, grouped by character rather than picked as 6 standalone effects: `lofi` (Bitcrusher → SampleRateReducer, the two halves of a classic bitcrusher), `interference` (CombFilter → RingModulation, both resonant/metallic), `breakup` (FoldbackDistortion → Rectifier, an increasingly dense reflection into an octave-up DC-biased buzz). Built per-object via bruit-kit's `buildEffectsChain` (an insert, not a send bus like reverb — each object needs its own instance processing only its own signal). Wired in series before the direct/reverb-send split (`filter → [degradeDry, chain] → gain → panner`), crossfaded by its own `degradeDry`/`degradeWet` gain pair using the same `reverbWetFraction` shape as reverb above (weak close, stronger far) but its own independent near/far setting (`setDegradeMix`, Degradation panel, default 0.3/1 — near deliberately higher than reverb's own 0.1 default, since a reverb barely engaged is still audibly a short, subtle tail, but a degrade chain barely engaged is nearly indistinguishable from dry). The chain's own internal effects stay fully wet once built; only the outer pair is distance-driven. Reverb's own send still taps the pre-degradation signal, unaffected by which chain an object drew |
| Recording | Lossless PCM capture of the master output, written directly to `.wav`. Not `MediaRecorder` (see below) |
| Object state | Each object is open (the plain sound) or closed (muffled), and every object starts closed. Click it on the map to toggle; a drag moves it without toggling. Closed = a lowpass whose cutoff (default 300 Hz) and sweep time (default 1900 ms) are global settings. The sweep is exponential in frequency, from Nyquist (an identity filter, so open is truly unfiltered) down to the cutoff, and can be reversed mid-sweep. The filter sits before both the dry path and the reverb send, so a closed object's reverb is muffled too |
| Selection | A single click selects one object (existing behaviour). Left-click-dragging from empty room floor draws a marquee; on release, every object whose position falls inside it becomes the selection (`objectsInRect` in room.ts), replacing whatever was selected. A drag on empty floor that never leaves the click slop is just a plain click and clears the selection, same as before. `RoomState.selectedIds` is a `Set<number>`, not a single id |
| Group drag | Dragging any object that's already part of a >1-object selection (`RoomView`'s `Drag` union's `"group"` case) moves the whole selection as a rigid shape instead of collapsing to just that one object: every selected object's room-space position is snapshotted when the drag starts, and each pointermove derives a single shared delta from the pointer's own movement, clamped once (not per-object) so the group's own extremes stay inside the room -- clamping per-object instead would let the group bunch up against a wall and distort relative to itself. A plain (undragged) click on a selected object still just toggles that one object's open/closed state, same as any other object, without collapsing the selection |
| Object context menu | Right-click an object (map or Objects-list row) for a small menu (Mute, Loudness, open/closed) — `objectContextMenu.ts`, styled like but not built on bruit-kit's `rangeMenu.ts` (anchored at the click point, bundles several unrelated fields, rather than that module's centered single-value dialog). If the clicked object is already part of a >1-object selection, every change applies to the whole selection; otherwise the click first reselects to just that object (matching a plain left-click), then applies to it alone |
| Visuals | Minimal technical map. The sound is what matters. Closed objects draw as hollow rings |

Non-goals: wall/occlusion modelling, listener-position-dependent reverb,
footsteps or walking sounds, persistence, per-object range, non-loop playback
modes (later).

## UI

```
+----------------------------------------------------------------------+
| bruit space   [Load folder]  objects: 15 (max [15])  [Reshuffle]     |
|                                          [● Rec 00:00]  [Download]   |
+---------------------+------------------------------------------------+
| ROOM                |                                                |
|  width   [ 20 m ]   |      ◉ box.aif                                 |
|  height  [ 20 m ]   |                         ◉ crate.wav            |
|                     |                 ╲ │ ╱                          |
| REVERB              |                  ▲   listener + heading        |
|  decay   [ 2.0 s ]  |            ◉ trunk.mp3                         |
|  predelay[ 20 ms ]  |                                  ◉ frame.wav   |
|  damping [ 6 kHz ]  |     ◉ = sound object (drag)                    |
|  level   [ 0.5   ]  |     dashed ring = hearing range around listener|
|                     |                                                |
| OBJECTS             |                                                |
|  ◉ box.aif    ▂▄▆ M |                                                |
|  ◉ crate.wav  ▂▄  M |                                                |
|  ...                |                                                |
+---------------------+------------------------------------------------+
| listener x 6.0 m · y 7.0 m · heading 0°   crate.wav · 4.2 m · heard 18% |
| W/A/S/D walk    Q/E turn    drag ▲ to move, drag the dot to turn      |
+----------------------------------------------------------------------+
```

Bigger room = larger scale for distance, so the same attenuation curve reaches
farther in metres. The curve's cutoff is expressed in room units, not pixels.

## Audio graph

```
sample (window passes, or loop) ─► lowpass (open/closed) ─┬─► objectGain ─► PannerNode(HRTF) ─┐
                                                        │                                    ├─► master ─► speakers
                                                        └─► sendGain ─► shared Reverb ───────┘        └─► PCM recorder ─► .wav
```

- The panner does direction only. `distanceModel` is neutralised (large
  `refDistance`, `rolloffFactor: 0`) and distance gain is computed by our own
  pure function, because the built-in models can't reach silence and the same
  number has to split between the direct path and the reverb send.
- Loudness normalization isn't a separate node in this diagram: it's a
  per-object multiplier (computed once at `addObject`, from the buffer) folded
  into `objectGain`/`sendGain`'s target value alongside distance and the
  Loudness slider.
- Room is X/Z with Y fixed at 0. Listener heading goes into the
  `AudioListener`'s forward vector.
- Gain changes on move use `setTargetAtTime`, not direct assignment, to avoid
  zipper noise.
- The panner downmixes each source to mono. Fine for point sources; stereo
  samples lose width.
- At window 1 the loop starts at `Math.random() * duration` so loops don't line
  up. Below 1, `PassPlayer` queues passes about 1.5 s ahead on a 250 ms timer
  (lookahead, because a hidden tab's timers can be throttled); changing the
  window re-rolls every object immediately -- the old passes fade out and new
  ones start -- debounced by 120 ms so a slider drag doesn't restart them at
  every step. `radio-tuner`'s clock-synced offset (`loopedElapsed`) isn't needed — that's for
  a shared wall clock. Its slow playback-rate drift (±1.5%,
  `audioEngine.ts` `MAX_DRIFT_RATE_OFFSET`) is worth trying later so loops of
  similar length don't settle into a repeating pattern, at the cost of slight
  detune.

## Why not the existing `Recorder`

`bruit-kit/src/audio/recorder.ts` goes through `MediaRecorder` to webm/opus, and
`wavEncoder.ts` then decodes that back to PCM. The `.wav` is a lossy round trip.
A PCM capture (an `AudioWorklet` posting Float32 blocks, converted to 16-bit as
they arrive to keep memory to roughly 11 MB/min stereo) skips the codec entirely.

## Where code lives

Two repos are touched, so this is a cross-repo change.

**`bruit-kit` (MINOR bump, new exports, demos where there's UI or audio):**
- `audio/spatialMath.ts` — `distanceGain(distance, maxDistance, exponent)`,
  one pure function (bruit-space uses exponent 2 for an object's total level; the reverb balance is a separate wet-fraction mix). No
  nodes, no DOM. (A listener-relative-angle helper was planned and dropped: the
  HRTF panner does direction natively, so nothing needed it.)
- `audio/aiffDecoder.ts` — pure PCM AIFF parser (8/16/24/32-bit, AIFF or AIFC
  "NONE"), added because Chrome can't decode AIFF. Checked bit-exact against
  macOS `afconvert` output on mono, stereo and the largest real sample.
- `audio/pcmRecorder.ts` (+ `pcm-recorder-processor.js`) — lossless
  master-output capture that builds a 16-bit stereo WAV `Blob` directly from the
  captured chunks (no full-length buffer, and it doesn't go through
  `wavEncoder.ts`, which wants an `AudioBuffer`). Ships with `demo/audio-pcmrecorder.html/.ts` using a
  synthesized tone.

**`bruit-space` (app-local first, promote to bruit-kit once settled):**
(built: `spatialEngine.ts`, `room.ts`, `roomView.ts`, `sampleLoader.ts`,
`keyboard.ts`, `main.ts`)
- Listener + sound-object wiring (panner/gain/send per object).
- Room canvas, drag/keyboard controls, folder loading, object cap and reshuffle.
- Reuses `ReverbEffect` and the shared limiter pattern as-is.

**Scaffolding (done):** `relpmas`' `Dockerfile`/`docker-compose.yml`/`Makefile`
shape, plus `radio-tuner`'s `verify` Compose service; frontend port **5178**
claimed in the root `CLAUDE.md` ledger.

## Verification

`make verify` (Playwright, headless Chromium) on the golden path: load a
synthesized folder of test samples, confirm the cap applies, confirm objects and
listener render, confirm keyboard movement changes listener position, confirm the
walk-speed and turn-speed sliders actually scale that movement (with the
listener's position/heading undone afterward before the fixed-speed checks
below rely on it), confirm every object starts
closed, confirm clicking an object toggles it while dragging doesn't, confirm a
closed tone records at <0.2x the level of the same tone opened, confirm the
closing sweep by sampling the filter's own frequency while it moves (continuous,
monotonic, ~the configured transition time; a step-size check catches a ramp
that snaps -- verified by deliberately removing the ramp's anchor, which drops
one step to 0.05x versus 0.93x normally), confirm the sample window's planning
math and the passes actually scheduled (random and wander start modes, rests),
confirm loudness normalization's pure math and, loading a quiet and a loud tone
each alone, confirm the real per-object gain node matches the expected
normalization gain exactly (including the +12 dB clamp) and that both tones'
corrected level converges toward the same target, confirm a marquee drag
encloses exactly the objects inside it (and that a marquee over empty
padding clears the selection instead), confirm the right-click menu shows
one object's own name or "N objects" correctly, that a change applies to
every object in a multi-selection (not just the one actually clicked, with
a mutation check confirming this fails if that's ever broken), that
right-clicking outside the current selection reselects to just the clicked
object, and that the menu closes on Escape or an outside click, confirm
dragging one member of a multi-selection shifts every selected object by
the same amount (mutation-checked: moving only the grabbed object, or
collapsing the selection to it, both fail the same test), that a drag hard
enough to push the group into a wall clamps the whole group together there
without distorting their relative positions (mutation-checked against a
version that clamps per-object instead), and that a plain click on a
selected object still just toggles it rather than moving or collapsing the
selection, confirm the reverb send's own wet fraction matches
`reverbWetFraction` exactly at several near/far settings by reading the
real direct/send gain nodes off one placed object, confirm a randomly-
assigned degrade chain's own dry/wet gain pair tracks that same curve
shape at its *own*, deliberately different, near/far setting each time
(always summing to 1; mutation-checked both against a version that
ignores distance and one that accidentally couples `setDegradeMix` back
onto reverb's own state, which the mismatched values in each iteration
catch immediately), confirm `pickDegradeType` covers all 3 types evenly
over a fixed sweep and that real `Math.random()` draws hit all 3 within 60
tries (mutation-checked against a version that always returns the same
type),
confirm a short recording downloads a valid PCM `.wav` (RIFF header,
non-silent). Audio
*quality* — whether front/back actually reads through headphones — can't be
verified by script and needs a manual listen.

## Open / deferred

- Other playback styles (rests between passes, pitch variation, one-shots,
  granular), plus the wider list of ideas for making the room more varied, are
  collected in [FUTURE.md](FUTURE.md).
- Rate drift on loops: optional, decide by ear.
- Hidden-tab scheduling is untested: passes are queued 1.5 s ahead, which
  survives ordinary ~1 s timer throttling, but Chrome throttles a long-hidden
  tab much harder and a recording could run dry of passes.
- Closed cutoff/transition are global; per-object values would let a
  "trunk" muffle harder than a "box". Not built.
- Master level (default 0.9, then the shared limiter) is a first guess. Full-scale
  drone samples summed from many nearby objects can push the limiter; tune by
  ear.
- HRTF front/back quality: needs a listen over headphones.
