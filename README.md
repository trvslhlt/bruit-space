# bruit-space

A virtual 2-D room you walk a listener through. Point it at a folder of
samples and each one becomes a looping sound object scattered around the
room; walk (or drag) the listener around and hear volume, left/right and
front/back change over headphones. Record what you hear as a lossless
`.wav`. Built on [bruit-kit](../bruit-kit), a sibling Web Audio component
library. Design notes and decisions live in [SPEC.md](SPEC.md).

Everything runs in Docker — no Node or other dependencies need to be
installed on your host machine.

## Prerequisites

This project consumes `bruit-kit` as a sibling directory via a `file:`
dependency (`"bruit-kit": "file:../bruit-kit"` in `package.json`), so it
expects the folder layout:

```
ai_coding_experiments/
├── bruit-kit/
└── bruit-space/   <- you are here
```

`bruit-kit` is not published to npm — this project's dev container
bind-mounts it (read-only) and imports its **built** `dist/`, not `src/`.
`make up` (below) always rebuilds it first via bruit-kit's own Makefile.

## Develop

```
make up
```

Then open **http://localhost:5178** (Chrome). Click "Click to enable
audio" (browser autoplay policy), then **Load folder** and choose a
directory of `.aif`/`.aiff`, `.wav` or `.mp3` files.

- **Max objects** (default 15) caps how many samples get placed; a bigger
  folder is randomly subsampled. Changing it, or **Reshuffle**, re-picks
  and re-places.
- **Walk:** `W`/`A`/`S`/`D` move relative to where you're facing;
  `Q`/`E` turn. They combine, so `W`+`E` walks in a curve.
- **Mouse:** drag the ▲ to move the listener, drag the dot in front of it
  to turn. Drag any sound object to move it. Each object has its own
  loudness slider and mute in the Objects list.
- **Open / closed:** every object starts closed. Click one on the map (or
  its open/closed button in the Objects list) to open it; click again to
  close it. Closed muffles it with a lowpass, reverb included, swept
  in/out over the transition time. Open is the plain, unfiltered sound. **Cutoff** and
  **Transition** under "Closed objects" apply to every object. Dragging an
  object moves it without toggling it.
- **Start mode** picks where each pass starts within the room the window
  leaves. **Random** (default) picks independently every pass. **Wander**
  keeps a slowly moving start position: each pass it glides toward a random
  target and picks a new target on arrival, so successive passes overlap
  and the loop evolves instead of jumping. **Wander speed** sets how far it
  glides per pass (0 holds the start still) and is only enabled in wander
  mode. Speed is counted in passes, not seconds, so samples with long
  passes evolve more slowly in real time. At window 1 there is no room to
  move, so neither mode has any effect.
- **Rests:** after each pass there's a chance (**Rest probability**, default
  0 = off) of a rest, which is real silence lasting a random time up to
  **Rest max (ms)**. With no rest the next pass crossfades in as before; with
  one, the pass fades out, the rest passes, and the next fades in. At window 1
  a plain loop has no end-of-loop to rest after, so turning rests on makes it
  a chain of full-length passes (turn them off and it's a native loop again).
- **Sample window** (Playback panel, default 1) is the share of each sample
  played per pass. At 0.9 each pass plays 90% of the sample from a random
  start between 0% and 10% of the way in, then the next pass begins,
  crossfaded; lower windows give shorter, more varied fragments. At 1 the
  sample simply loops. It's a pure proportion of each sample's own length,
  so the same setting gives a short fragment of a short sample and a long
  one of a long sample.
- **Hearing range** is the distance at which every object falls to
  silence (dashed ring on the map). One curve for all objects — a louder
  object is simply still audible from farther away.
- **Master** sets the overall level (default 0.9). Loud samples with
  several audible at once can push a recording to full scale; lower it if
  the shared limiter starts audibly pumping.
- **Record** captures exactly what you're hearing as 16-bit stereo PCM
  and offers it as a `.wav` download. No webm/opus anywhere.

AIFF files are decoded by a small parser in bruit-kit
(`bruit-kit/audio`'s `decodeAiff`), since Chrome's `decodeAudioData`
can't read AIFF. HRTF panning is tuned for headphones and is much less
convincing over speakers.

## Make targets

`make up` / `down` / `restart` / `logs` / `shell` / `typecheck` / `lint` /
`format` / `build-image` / `run-image` / `verify` — same vocabulary as
every sibling project. `make verify` runs `tests/verify.mjs` (headless
Playwright against the running dev stack): folder loading and the object
cap (including a hand-built 24-bit AIFF), keyboard and mouse control of
the listener, room resizing, and that a recording downloads as a valid,
non-silent stereo WAV. It can't tell you whether front/back sounds right;
that needs a listen.

No backend — nothing here persists, by design.
