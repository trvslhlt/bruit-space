import {
  PcmRecorder,
  ReverbEffect,
  type ReverbEffectParams,
  distanceGain,
  preloadPcmRecorderWorklet,
} from "bruit-kit/audio";
import { connectToOutput, getSharedLimiter } from "./audioContext";
import { type RoomState, reverbWetFraction } from "./room";

// One distance curve (silent at the hearing range) sets an object's total
// level. How much of that total is reverb rather than direct sound is a
// separate, user-set mix -- a wet fraction that shifts from "near" (on top
// of the object) to "far" (at the edge of hearing range). That shifting
// direct-to-reverberant ratio is the main cue for distance; no room
// geometry needed. Direct and reverb fade out together, so nothing pops at
// the range boundary.
const ROLLOFF_EXPONENT = 2;

// Applied to every position/gain change rather than assigning .value
// directly, which would step and click as the listener or a dragged object
// moves between animation frames.
const SMOOTHING_SECONDS = 0.03;

export const DEFAULT_MASTER_LEVEL = 0.9;
export const DEFAULT_WET_NEAR = 0.2;
export const DEFAULT_WET_FAR = 0.8;
export const DEFAULT_CLOSED_CUTOFF_HZ = 200;
export const DEFAULT_TRANSITION_MS = 700;

// Retargeting an already-closed object's cutoff while its slider is being
// dragged: quick enough to track the slider, slow enough not to zipper.
const CUTOFF_RETARGET_SECONDS = 0.05;

interface Voice {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  closed: boolean;
  gain: GainNode;
  send: GainNode;
  panner: PannerNode;
}

export class SpatialEngine {
  readonly recorder: PcmRecorder;
  private voices = new Map<number, Voice>();
  private master: GainNode;
  private reverb: ReverbEffect;
  private wetNear = DEFAULT_WET_NEAR;
  private wetFar = DEFAULT_WET_FAR;
  private closedCutoffHz = DEFAULT_CLOSED_CUTOFF_HZ;
  private transitionSeconds = DEFAULT_TRANSITION_MS / 1000;

  static async create(audioContext: AudioContext): Promise<SpatialEngine> {
    await preloadPcmRecorderWorklet(
      audioContext,
      "/worklets/pcm-recorder-processor.js",
    );
    return new SpatialEngine(audioContext);
  }

  private constructor(private audioContext: AudioContext) {
    // Level for the summed loops; the shared limiter after this only
    // catches peaks. Loud full-scale samples with several audible at once
    // can push it (or a recording) to full scale at high settings -- the
    // "Master" slider is the fix, by ear.
    this.master = audioContext.createGain();
    this.master.gain.value = DEFAULT_MASTER_LEVEL;
    connectToOutput(this.master, audioContext);

    this.reverb = new ReverbEffect(audioContext);
    // Fully wet: this is a send bus, the dry signal never goes through it.
    this.reverb.setParams({ wet: 1 });
    this.reverb.output.connect(this.master);

    // Tapped after the limiter so the recording is exactly what's heard.
    this.recorder = new PcmRecorder(
      audioContext,
      getSharedLimiter(audioContext).output,
    );
  }

  setReverb(params: Partial<Omit<ReverbEffectParams, "wet">>): void {
    this.reverb.setParams(params);
  }

  /** Nyquist: Chromium treats a lowpass at exactly this frequency as an
   * identity filter, so an open object is genuinely unfiltered rather than
   * just very bright. */
  private get openFrequency(): number {
    return this.audioContext.sampleRate / 2;
  }

  setClosedCutoff(hz: number): void {
    this.closedCutoffHz = hz;
    for (const voice of this.voices.values()) {
      if (voice.closed) this.rampFilter(voice, hz, CUTOFF_RETARGET_SECONDS);
    }
  }

  setTransitionMs(ms: number): void {
    this.transitionSeconds = ms / 1000;
  }

  /** Sweeps the object's lowpass between fully open and the closed cutoff
   * over the configured transition time. */
  setObjectClosed(id: number, closed: boolean): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.closed = closed;
    this.rampFilter(
      voice,
      closed ? this.closedCutoffHz : this.openFrequency,
      this.transitionSeconds,
    );
  }

  private rampFilter(voice: Voice, targetHz: number, seconds: number): void {
    const param = voice.filter.frequency;
    const now = this.audioContext.currentTime;
    // Hold, then re-anchor, so the ramp starts from wherever the filter is
    // right now -- including partway through an earlier sweep when the
    // object is toggled again mid-transition. The explicit setValueAtTime
    // matters: a ramp interpolates from the *previous scheduled event*, and
    // after a finished sweep that event is long past, so without an anchor
    // at `now` the ramp would already be almost complete the instant it
    // begins (an audible snap instead of a sweep).
    const current = param.value;
    param.cancelAndHoldAtTime(now);
    param.setValueAtTime(current, now);
    param.exponentialRampToValueAtTime(
      targetHz,
      now + Math.max(seconds, 0.005),
    );
  }

  setMasterLevel(level: number): void {
    this.master.gain.setTargetAtTime(
      level,
      this.audioContext.currentTime,
      SMOOTHING_SECONDS,
    );
  }

  /** Takes effect on the next update(). */
  setReverbMix(mix: { near?: number; far?: number }): void {
    if (mix.near !== undefined) this.wetNear = mix.near;
    if (mix.far !== undefined) this.wetFar = mix.far;
  }

  addObject(id: number, buffer: AudioBuffer, closed: boolean): void {
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    // Before both the dry path and the reverb send, so a closed object's
    // reverb is muffled too. Q of -3.01 dB is Butterworth (no resonant
    // bump at the cutoff); BiquadFilterNode's default Q would add a peak
    // that reads as a whistle when the cutoff sweeps.
    const filter = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      // Created already at its resting frequency, not swept there: a new
      // object shouldn't audibly ramp in from open when it's placed.
      frequency: closed ? this.closedCutoffHz : this.openFrequency,
      Q: -3.0103,
    });

    const gain = this.audioContext.createGain();
    gain.gain.value = 0;
    const send = this.audioContext.createGain();
    send.gain.value = 0;

    // The panner does direction only (HRTF: left/right, and the front/back
    // spectral cues). Its own distance attenuation is neutralised
    // (rolloffFactor 0) because distanceGain() -- which, unlike the
    // built-in models, reaches true silence -- drives level instead, and
    // the same function has to feed the reverb send too.
    const panner = new PannerNode(this.audioContext, {
      panningModel: "HRTF",
      distanceModel: "linear",
      refDistance: 1,
      maxDistance: 10000,
      rolloffFactor: 0,
    });

    source.connect(filter);
    filter.connect(gain).connect(panner).connect(this.master);
    filter.connect(send).connect(this.reverb.input);

    // Random start so loops of similar length don't begin phase-aligned.
    source.start(0, Math.random() * buffer.duration);
    this.voices.set(id, { source, filter, closed, gain, send, panner });
  }

  clearObjects(): void {
    for (const voice of this.voices.values()) {
      voice.source.stop();
      voice.source.disconnect();
      voice.filter.disconnect();
      voice.gain.disconnect();
      voice.send.disconnect();
      voice.panner.disconnect();
    }
    this.voices.clear();
  }

  /** Pushes the current listener/object state into the audio graph. Cheap
   * enough to call every frame something moved. */
  update(room: RoomState): void {
    const now = this.audioContext.currentTime;
    const smooth = (param: AudioParam, value: number): void => {
      param.setTargetAtTime(value, now, SMOOTHING_SECONDS);
    };

    // Map (x, y-down) -> Web Audio (x, z): "up" on the map is -z, which is
    // the AudioListener's default forward, so heading 0 needs no rotation.
    const { listener } = room;
    const audioListener = this.audioContext.listener;
    smooth(audioListener.positionX, listener.x);
    smooth(audioListener.positionZ, listener.y);
    smooth(audioListener.forwardX, Math.sin(listener.heading));
    smooth(audioListener.forwardZ, -Math.cos(listener.heading));

    for (const object of room.objects) {
      const voice = this.voices.get(object.id);
      if (!voice) continue;
      const distance = Math.hypot(object.x - listener.x, object.y - listener.y);
      const level = object.muted ? 0 : object.gain;
      const total =
        level * distanceGain(distance, room.hearingRange, ROLLOFF_EXPONENT);
      const wet = reverbWetFraction(
        distance,
        room.hearingRange,
        this.wetNear,
        this.wetFar,
      );
      smooth(voice.gain.gain, total * (1 - wet));
      smooth(voice.send.gain, total * wet);
      smooth(voice.panner.positionX, object.x);
      smooth(voice.panner.positionZ, object.y);
    }
  }
}
