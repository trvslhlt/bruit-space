/** Floor on a pass's length, in seconds. Not a creative clamp -- windows
 * stay pure proportions of each sample's own length -- just a guard: a tiny
 * window fraction on a very short sample would otherwise ask for a
 * zero-length (or click-sized) fragment. */
export const MIN_PASS_SECONDS = 0.05;

/** Which slice of a sample the next pass plays. `windowFraction` is the
 * share of the sample to play (1 = all of it); the start is uniformly
 * random over whatever room is left, so the pass never runs past the end:
 * a higher fraction means a longer pass and less randomness in where it
 * starts. `random` is injectable (0..1) for testing. */
export function planPass(
  bufferSeconds: number,
  windowFraction: number,
  random: number = Math.random(),
): { offset: number; length: number } {
  const length = Math.min(
    bufferSeconds,
    Math.max(windowFraction * bufferSeconds, MIN_PASS_SECONDS),
  );
  return { offset: random * (bufferSeconds - length), length };
}
