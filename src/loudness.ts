/** Root-mean-square level across every channel and sample -- one pure
 * number for "how loud is this buffer," on average, as opposed to its
 * peak. A plain two-pass loudness stand-in, not a full LUFS
 * implementation (see FUTURE.md): good enough to correct for wildly
 * different recording levels across a sample folder, not meant as a
 * mastering-grade measurement. */
export function rmsOf(channels: Float32Array[]): number {
  let sumSquares = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      sumSquares += channel[i] * channel[i];
    }
    count += channel.length;
  }
  return count === 0 ? 0 : Math.sqrt(sumSquares / count);
}

/** Linear RMS every sample is normalized toward -- roughly -20 dBFS: quiet
 * enough that a boosted near-silent recording doesn't dominate the room,
 * loud enough that a normally-recorded sample needs little correction. */
export const TARGET_RMS = 0.1;

/** How far normalizationGain can push a sample's level, in either
 * direction. The boost side matters: a near-silent buffer's raw ratio
 * (target / a tiny RMS) would be enormous, boosting noise into something
 * audible -- capped at +12 dB. The cut side is effectively unreachable for
 * real audio at the default target (a full-scale signal's RMS never
 * exceeds 1, so target / rms never drops below target itself) but stays
 * as a guard in case the target ever changes. */
export const MAX_NORMALIZATION_GAIN = 4; // +12 dB
export const MIN_NORMALIZATION_GAIN = 0.1; // -20 dB

// Floors the divisor rather than special-casing rms === 0: a genuinely
// silent buffer then just lands on the same MAX clamp as a very quiet one,
// one code path for both.
const RMS_EPSILON = 1e-6;

/** The gain that would bring `rms` to `targetRms`, clamped to
 * [MIN_NORMALIZATION_GAIN, MAX_NORMALIZATION_GAIN]. */
export function normalizationGain(
  rms: number,
  targetRms: number = TARGET_RMS,
): number {
  const raw = targetRms / Math.max(rms, RMS_EPSILON);
  return Math.min(
    MAX_NORMALIZATION_GAIN,
    Math.max(MIN_NORMALIZATION_GAIN, raw),
  );
}

/** Convenience wrapper reading an AudioBuffer's own channel data. */
export function normalizationGainForBuffer(buffer: AudioBuffer): number {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel));
  }
  return normalizationGain(rmsOf(channels));
}
