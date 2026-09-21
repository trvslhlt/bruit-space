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
- **Hearing range** is the distance at which every object falls to
  silence (dashed ring on the map). One curve for all objects — a louder
  object is simply still audible from farther away.
- **Master** sets the overall level (default 0.4). Loud samples with
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
