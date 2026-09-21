/** Floor on a pass's length, in seconds. Not a creative clamp -- windows
 * stay pure proportions of each sample's own length -- just a guard: a tiny
 * window fraction on a very short sample would otherwise ask for a
 * zero-length (or click-sized) fragment. */
export const MIN_PASS_SECONDS = 0.05;

/** Which slice of a sample the next pass plays. `windowFraction` is the
 * share of the sample to play (1 = all of it). `startFraction` (0..1) is
 * where in the room left over the pass starts -- so it never runs past the
 * end, and a higher window fraction means a longer pass and less room for
 * the start to vary. Random by default; the wander mode passes a
 * slowly-moving value instead. */
export function planPass(
  bufferSeconds: number,
  windowFraction: number,
  startFraction: number = Math.random(),
): { offset: number; length: number } {
  const length = Math.min(
    bufferSeconds,
    Math.max(windowFraction * bufferSeconds, MIN_PASS_SECONDS),
  );
  return { offset: startFraction * (bufferSeconds - length), length };
}

/** How long to rest (stay silent) after a pass, in seconds: with chance
 * `probability` (0..1) a rest happens, lasting a uniformly random time up
 * to `maxSeconds`; otherwise 0. `chance` and `amount` are the two random
 * draws (0..1), injectable for testing. */
export function planRest(
  probability: number,
  maxSeconds: number,
  chance: number = Math.random(),
  amount: number = Math.random(),
): number {
  return chance < probability ? amount * maxSeconds : 0;
}

/** How each pass picks where to start: `random` anywhere in the room left
 * over, independently every pass; `wander` drifts from wherever the last
 * pass started, so successive passes overlap and the loop evolves instead
 * of jumping. */
export type StartMode = "random" | "wander";

/** Both are fractions (0..1) of the start range planPass is given, not
 * seconds, so a wander means the same thing at any window size. */
export interface WanderState {
  position: number;
  target: number;
}

/** The wander is finished once the position is within this of its target,
 * as a fraction of the start range. */
const WANDER_ARRIVAL = 0.05;

/** Share of the remaining distance to the target covered per pass, at full
 * speed. */
const WANDER_MAX_GLIDE = 0.4;

export function initialWanderState(
  random1: number = Math.random(),
  random2: number = Math.random(),
): WanderState {
  return { position: random1, target: random2 };
}

/** One pass of drift. `speed` (0..1) sets how much of the remaining
 * distance to the target is covered each pass -- squared, so the slow end
 * of the control has fine resolution -- and 0 holds the start where it is.
 * Measured in passes rather than seconds, so a sample with long passes
 * evolves more slowly in real time than one with short passes. On arriving
 * at the target a fresh random one is picked (`random`, injectable for
 * testing). Position and target both stay in 0..1. */
export function advanceWander(
  state: WanderState,
  speed: number,
  random: number = Math.random(),
): WanderState {
  const glide = WANDER_MAX_GLIDE * speed * speed;
  const position = state.position + (state.target - state.position) * glide;
  const arrived = Math.abs(state.target - position) < WANDER_ARRIVAL;
  return { position, target: arrived ? random : state.target };
}
