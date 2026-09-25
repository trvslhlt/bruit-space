import type { EffectSpec } from "bruit-kit/audio";

/** Three "the sound is falling apart out there" processing chains, each
 * two bruit-kit effects in series (wired up in spatialEngine.ts's
 * addObject via bruit-kit's own buildEffectsChain) -- grouped by
 * character rather than picked as six standalone effects, since e.g.
 * bitcrusher and sample-rate reduction (the two halves of a classic
 * bitcrusher -- see BitcrusherEffect's own doc comment) or comb filter
 * and ring modulation (both resonant/metallic) read as redundant next to
 * each other rather than as three genuinely distinct colors. Kept as pure
 * data + a pure random pick, separate from spatialEngine.ts's real node
 * wiring, so the pick itself is directly testable with no Web Audio
 * involved -- same split as passMath.ts/loudness.ts. */
export type DegradeType = "lofi" | "interference" | "breakup";

export const DEGRADE_TYPES: readonly DegradeType[] = [
  "lofi",
  "interference",
  "breakup",
];

export const DEGRADE_CHAIN_SPECS: Record<DegradeType, EffectSpec[]> = {
  // Digital lo-fi: bit-depth crunch feeding the aliased sample-rate half
  // BitcrusherEffect's own doc comment says its WaveShaperNode technique
  // can't reach alone.
  lofi: [
    { type: "bitcrusher", params: { bits: 5 } },
    { type: "sampleRateReducer", params: { holdSamples: 6 } },
  ],
  // Metallic interference: a resonant comb feeding a slow ring modulator,
  // for a wobbling, radio-static character.
  interference: [
    { type: "combFilter", params: { frequency: 400, feedback: 0.7 } },
    { type: "ringMod", params: { frequency: 60, waveform: "sine" } },
  ],
  // Breaking up: foldback distortion's increasingly dense reflections
  // into a rectifier's octave-up, DC-biased buzz -- a "broken speaker"
  // character, distinct from both chains above.
  breakup: [
    { type: "foldbackDistortion", params: { threshold: 0.25 } },
    { type: "rectifier", params: { mode: "full" } },
  ],
};

/** Injectable so a test can drive a specific outcome deterministically;
 * defaults to Math.random for real use. */
export function pickDegradeType(
  random: () => number = Math.random,
): DegradeType {
  const index = Math.min(
    Math.floor(random() * DEGRADE_TYPES.length),
    DEGRADE_TYPES.length - 1,
  );
  return DEGRADE_TYPES[index];
}
