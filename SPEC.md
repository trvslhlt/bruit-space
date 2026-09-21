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
| Playback | Loop only for now. Each loop starts at a random offset so loops don't line up |
| Listener | Position + heading; starts at the bottom edge facing up. Mouse: drag the body to move, drag a nose handle to rotate. Keyboard: WASD walks *relative to facing* (W forward, A/D strafe), Q/E rotate, all usable simultaneously |
| Spatialization | HRTF `PannerNode` (front/back EQ and head shadow come from the HRTF itself — no custom filter). Headphones assumed |
| Distance | One attenuation curve shared by all objects, reaching silence at a max distance. Per-object gain sets how loud each object is, so louder objects are audible from farther away |
| Reverb | One global reverb, listener-independent. Room size maps to decay/pre-delay/damping, not geometry. Each object's *wet fraction* (share of its sound that is reverb vs direct) is interpolated linearly from a "wet at object" setting (listener on top of it, default 0.2) to a "wet at range edge" setting (default 0.8). Direct = total × (1 − wet), send = total × wet, where total follows the shared distance curve, so both fade to silence together at the hearing range |
| Recording | Lossless PCM capture of the master output, written directly to `.wav`. Not `MediaRecorder` (see below) |
| Object state | Each object is open (the plain sound) or closed (muffled), and every object starts closed. Click it on the map to toggle; a drag moves it without toggling. Closed = a lowpass whose cutoff (default 200 Hz) and sweep time (default 700 ms) are global settings. The sweep is exponential in frequency, from Nyquist (an identity filter, so open is truly unfiltered) down to the cutoff, and can be reversed mid-sweep. The filter sits before both the dry path and the reverb send, so a closed object's reverb is muffled too |
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
sample (loop, random offset) ─► lowpass (open/closed) ─┬─► objectGain ─► PannerNode(HRTF) ─┐
                                                        │                                    ├─► master ─► speakers
                                                        └─► sendGain ─► shared Reverb ───────┘        └─► PCM recorder ─► .wav
```

- The panner does direction only. `distanceModel` is neutralised (large
  `refDistance`, `rolloffFactor: 0`) and distance gain is computed by our own
  pure function, because the built-in models can't reach silence and the same
  number has to split between the direct path and the reverb send.
- Room is X/Z with Y fixed at 0. Listener heading goes into the
  `AudioListener`'s forward vector.
- Gain changes on move use `setTargetAtTime`, not direct assignment, to avoid
  zipper noise.
- The panner downmixes each source to mono. Fine for point sources; stereo
  samples lose width.
- Random loop offset is `source.start(0, Math.random() * duration)`.
  `radio-tuner`'s clock-synced offset (`loopedElapsed`) isn't needed — that's for
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
listener render, confirm keyboard movement changes listener position, confirm every object starts
closed, confirm clicking an object toggles it while dragging doesn't, confirm a
closed tone records at <0.2x the level of the same tone opened, confirm the
closing sweep by sampling the filter's own frequency while it moves (continuous,
monotonic, ~the configured transition time; a step-size check catches a ramp
that snaps -- verified by deliberately removing the ramp's anchor, which drops
one step to 0.05x versus 0.93x normally), confirm a
short recording downloads a valid PCM `.wav` (RIFF header, non-silent). Audio
*quality* — whether front/back actually reads through headphones — can't be
verified by script and needs a manual listen.

## Open / deferred

- Loop-only (so no per-object loop toggle); other playback styles (one-shots, retriggering, granular
  via `bruit-kit` sources) come later.
- Rate drift on loops: optional, decide by ear.
- Closed cutoff/transition are global; per-object values would let a
  "trunk" muffle harder than a "box". Not built.
- Master level (default 0.9, then the shared limiter) is a first guess. Full-scale
  drone samples summed from many nearby objects can push the limiter; tune by
  ear.
- HRTF front/back quality: needs a listen over headphones.
