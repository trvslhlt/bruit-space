import {
  type StartMode,
  type WanderState,
  advanceWander,
  initialWanderState,
  planPass,
  planRest,
} from "./passMath";

// Scheduled this far ahead, because timers in a background tab can be
// throttled to about once a second -- a recording must keep going when the
// tab isn't focused.
const LOOKAHEAD_SECONDS = 1.5;
const START_LEAD_SECONDS = 0.02;

// Each pass fades in and out over this long, overlapping the next pass by
// the same amount so there's no gap between fragments.
const FADE_SECONDS = 0.03;

// A replaced generation of passes fades out on this time constant, then
// its sources are stopped a little after it's inaudible.
const RETIRE_TIME_CONSTANT = 0.01;
const RETIRE_SECONDS = 0.08;

const CURVE_POINTS = 32;
// Equal-power: for unrelated material, sin^2 + cos^2 = 1 keeps the level
// steady through the overlap, where linear fades would dip ~3 dB.
const FADE_IN = Float32Array.from({ length: CURVE_POINTS }, (_, i) =>
  Math.sin((i / (CURVE_POINTS - 1)) * (Math.PI / 2)),
);
const FADE_OUT = Float32Array.from({ length: CURVE_POINTS }, (_, i) =>
  Math.cos((i / (CURVE_POINTS - 1)) * (Math.PI / 2)),
);

export interface PassConfig {
  /** Share of the sample each pass plays; 1 is a plain native loop. */
  windowFraction: number;
  startMode: StartMode;
  /** How fast `wander` mode drifts, 0..1 (0 holds the start still). */
  wanderSpeed: number;
  /** Chance (0..1) of a rest after each pass. */
  restProbability: number;
  /** Longest rest, in milliseconds; each one is random up to this. */
  restMaxMs: number;
}

/** Window 1 with no rests is a plain native loop. Anything else is a chain
 * of passes -- including window 1 once rests are on, as full-length passes,
 * because a native loop has no end-of-loop to rest after. */
function playsNativeLoop(config: PassConfig): boolean {
  const resting = config.restProbability > 0 && config.restMaxMs > 0;
  return config.windowFraction >= 1 && !resting;
}

/** Plays one sample into `destination`. At window 1 that's a plain native
 * loop from a random start (each loop starts at a different spot so loops
 * don't line up). Below 1 it's a chain of passes: each plays `window x
 * length` of the sample from a start chosen by the start mode, crossfaded
 * into the next -- see planPass. */
export class PassPlayer {
  private bus: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  // Kept for the player's whole life, not reset when the window changes,
  // so a wander carries on from where it was rather than starting over.
  private wander: WanderState = initialWanderState();

  constructor(
    private audioContext: AudioContext,
    private buffer: AudioBuffer,
    private destination: AudioNode,
    private config: PassConfig,
  ) {
    this.begin();
  }

  /** A changed window or start mode re-rolls immediately: whatever's
   * playing fades out and a fresh set of passes starts. Waiting for the
   * current pass to finish would mean up to a whole sample's length of
   * lag. So does turning rests on or off at window 1, which switches
   * between a native loop and passes. A changed wander speed or rest
   * setting otherwise just applies from the next pass. */
  configure(next: PassConfig): void {
    const reroll =
      next.windowFraction !== this.config.windowFraction ||
      next.startMode !== this.config.startMode ||
      playsNativeLoop(next) !== playsNativeLoop(this.config);
    this.config = { ...next };
    if (!reroll) return;
    this.retire();
    this.begin();
  }

  /** Queues passes up to the lookahead horizon; call this on a timer. */
  schedule(): void {
    if (!this.bus || playsNativeLoop(this.config)) return;
    const horizon = this.audioContext.currentTime + LOOKAHEAD_SECONDS;
    while (this.nextStartTime < horizon) this.queuePass(this.nextStartTime);
  }

  stop(): void {
    this.retire();
  }

  private track(source: AudioBufferSourceNode): void {
    this.sources.add(source);
    source.addEventListener("ended", () => this.sources.delete(source));
  }

  private begin(): void {
    const { audioContext, buffer } = this;
    this.bus = audioContext.createGain();
    this.bus.connect(this.destination);
    const now = audioContext.currentTime;

    if (playsNativeLoop(this.config)) {
      this.bus.gain.value = 0;
      this.bus.gain.setTargetAtTime(1, now, RETIRE_TIME_CONSTANT);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.bus);
      source.start(now, Math.random() * buffer.duration);
      this.track(source);
      return;
    }

    this.nextStartTime = now + START_LEAD_SECONDS;
    this.schedule();
  }

  private queuePass(startTime: number): void {
    const { audioContext, buffer } = this;
    // Wander uses the current position for this pass, then drifts for the
    // next; random leaves it to planPass.
    let startFraction: number | undefined;
    if (this.config.startMode === "wander") {
      startFraction = this.wander.position;
      this.wander = advanceWander(this.wander, this.config.wanderSpeed);
    }
    const { offset, length } = planPass(
      buffer.duration,
      this.config.windowFraction,
      startFraction,
    );
    // Under half the pass each, so the two curves never touch (adjacent
    // value-curve events on one param aren't allowed to overlap).
    const fade = Math.min(FADE_SECONDS, length * 0.45);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    gain.gain.setValueCurveAtTime(FADE_IN, startTime, fade);
    gain.gain.setValueCurveAtTime(FADE_OUT, startTime + length - fade, fade);
    source.connect(gain).connect(this.bus!);
    source.start(startTime, offset, length);
    this.track(source);

    // A rest is real silence, so no crossfade overlap into the next pass:
    // this one fades out completely first (its own fade-out curve), then
    // the next fades in after the rest. Without one, the next starts as
    // this one begins fading, so there's no gap.
    const rest = planRest(
      this.config.restProbability,
      this.config.restMaxMs / 1000,
    );
    this.nextStartTime =
      rest > 0 ? startTime + length + rest : startTime + length - fade;
  }

  private retire(): void {
    if (!this.bus) return;
    const now = this.audioContext.currentTime;
    const bus = this.bus;
    // The bus carries no automation but this fade, so unlike a ramp
    // (which interpolates from the previous scheduled event) a setTarget
    // starts from wherever the gain is right now.
    bus.gain.setTargetAtTime(0, now, RETIRE_TIME_CONSTANT);
    // Stopping a source that hasn't started yet cancels it, so passes
    // queued for later never sound.
    for (const source of this.sources) source.stop(now + RETIRE_SECONDS);
    window.setTimeout(() => bus.disconnect(), (RETIRE_SECONDS + 0.1) * 1000);
    this.bus = null;
    this.sources.clear();
  }
}
