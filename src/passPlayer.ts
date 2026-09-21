import { planPass } from "./passMath";

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

/** Plays one sample into `destination`. At window 1 that's a plain native
 * loop from a random start (each loop starts at a different spot so loops
 * don't line up). Below 1 it's a chain of passes: each plays `window x
 * length` of the sample from a fresh random start, crossfaded into the
 * next -- see planPass. */
export class PassPlayer {
  private bus: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;

  constructor(
    private audioContext: AudioContext,
    private buffer: AudioBuffer,
    private destination: AudioNode,
    private windowFraction: number,
  ) {
    this.begin();
  }

  /** Re-rolls immediately: whatever's playing fades out and a fresh set of
   * passes starts under the new window. Waiting for the current pass to
   * finish would mean up to a whole sample's length of lag. */
  setWindow(fraction: number): void {
    if (fraction === this.windowFraction) return;
    this.windowFraction = fraction;
    this.retire();
    this.begin();
  }

  /** Queues passes up to the lookahead horizon; call this on a timer. */
  schedule(): void {
    if (!this.bus || this.windowFraction >= 1) return;
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

    if (this.windowFraction >= 1) {
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
    const { offset, length } = planPass(buffer.duration, this.windowFraction);
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

    this.nextStartTime = startTime + length - fade;
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
