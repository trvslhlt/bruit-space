import {
  type BuiltEffectsChain,
  PcmRecorder,
  ReverbEffect,
  type ReverbEffectParams,
  buildEffectsChain,
  distanceGain,
  preloadPcmRecorderWorklet,
  preloadSampleRateReducerWorklet,
} from "bruit-kit/audio";
import { connectToOutput, getSharedLimiter } from "./audioContext";
import { DEGRADE_CHAIN_SPECS, pickDegradeType } from "./degradeMath";
import { normalizationGainForBuffer } from "./loudness";
import type { StartMode } from "./passMath";
import { type PassConfig, PassPlayer } from "./passPlayer";
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
export const DEFAULT_WET_NEAR = 0.1;
export const DEFAULT_WET_FAR = 1;
// Deliberately more present than reverb's own near default: reverb is
// still clearly audible even barely engaged (a short, subtle tail), but a
// degrade chain barely engaged is nearly indistinguishable from dry --
// these need their own curve, not reverb's, to actually be heard without
// cranking a shared slider so high it also blows reverb's own balance out.
export const DEFAULT_DEGRADE_WET_NEAR = 0.3;
export const DEFAULT_DEGRADE_WET_FAR = 1;
export const DEFAULT_SAMPLE_WINDOW = 0.3;
export const DEFAULT_START_MODE: StartMode = "wander";
export const DEFAULT_WANDER_SPEED = 0.5;
export const DEFAULT_REST_PROBABILITY = 0.1;
export const DEFAULT_REST_MAX_MS = 650;

const SCHEDULE_INTERVAL_MS = 250;
// A slider drag fires many input events; each window or start-mode change
// re-rolls every object's passes, so wait for it to settle rather than
// restarting them at every intermediate value.
const PLAYBACK_DEBOUNCE_MS = 120;
export const DEFAULT_CLOSED_CUTOFF_HZ = 300;
export const DEFAULT_TRANSITION_MS = 1900;

// Retargeting an already-closed object's cutoff while its slider is being
// dragged: quick enough to track the slider, slow enough not to zipper.
const CUTOFF_RETARGET_SECONDS = 0.05;

interface Voice {
  player: PassPlayer;
  filter: BiquadFilterNode;
  closed: boolean;
  gain: GainNode;
  send: GainNode;
  panner: PannerNode;
  /** Per-file loudness correction -- see loudness.ts -- folded into
   * `total` alongside the object's own Loudness slider, so a quiet
   * recording and a loud one placed at the same distance come out at a
   * similar level. */
  normalizationGain: number;
  /** This object's randomly-assigned degradation chain (see
   * degradeMath.ts) and its own dry/wet pair -- an insert in series with
   * the direct path, not a send bus like reverb, since each object needs
   * its own instance processing only its own signal (a shared instance
   * would sum multiple objects' audio together before distorting them,
   * which isn't what "this object sounds worse far away" means). */
  degradeChain: BuiltEffectsChain;
  degradeDry: GainNode;
  degradeWet: GainNode;
}

export class SpatialEngine {
  readonly recorder: PcmRecorder;
  private voices = new Map<number, Voice>();
  private master: GainNode;
  private reverb: ReverbEffect;
  private reverbWetNear = DEFAULT_WET_NEAR;
  private reverbWetFar = DEFAULT_WET_FAR;
  // Same shape as reverbWetNear/Far, but its own independent curve -- see
  // setDegradeMix and update() below -- so reverb and the degrade chains
  // can be balanced separately instead of sharing one "wet" knob.
  private degradeWetNear = DEFAULT_DEGRADE_WET_NEAR;
  private degradeWetFar = DEFAULT_DEGRADE_WET_FAR;
  private closedCutoffHz = DEFAULT_CLOSED_CUTOFF_HZ;
  private transitionSeconds = DEFAULT_TRANSITION_MS / 1000;
  private playback: PassConfig = {
    windowFraction: DEFAULT_SAMPLE_WINDOW,
    startMode: DEFAULT_START_MODE,
    wanderSpeed: DEFAULT_WANDER_SPEED,
    restProbability: DEFAULT_REST_PROBABILITY,
    restMaxMs: DEFAULT_REST_MAX_MS,
  };
  private playbackTimer: number | undefined;

  static async create(audioContext: AudioContext): Promise<SpatialEngine> {
    await preloadPcmRecorderWorklet(
      audioContext,
      "/worklets/pcm-recorder-processor.js",
    );
    // Needed unconditionally, not just for the "lofi" degrade chain --
    // which chain a given object gets is random (see degradeMath.ts), so
    // any object placed from here on could need this the moment it's
    // added.
    await preloadSampleRateReducerWorklet(
      audioContext,
      "/worklets/sample-rate-reducer-processor.js",
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

    window.setInterval(() => {
      for (const voice of this.voices.values()) voice.player.schedule();
    }, SCHEDULE_INTERVAL_MS);
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
    if (mix.near !== undefined) this.reverbWetNear = mix.near;
    if (mix.far !== undefined) this.reverbWetFar = mix.far;
  }

  /** Same shape as setReverbMix, but for the degrade chains' own
   * near/far wet fraction -- independent so the two can be balanced
   * separately (reverb subtle and natural-sounding near the object,
   * degradation still clearly audible there, say). Takes effect on the
   * next update(). */
  setDegradeMix(mix: { near?: number; far?: number }): void {
    if (mix.near !== undefined) this.degradeWetNear = mix.near;
    if (mix.far !== undefined) this.degradeWetFar = mix.far;
  }

  /** Share of each sample played per pass (1 = the whole sample, looped),
   * how each pass picks its start, how fast a wander drifts, and how often
   * and how long the rests between passes are. Applied to every object
   * once the values stop changing. */
  setPlayback(change: Partial<PassConfig>): void {
    this.playback = { ...this.playback, ...change };
    window.clearTimeout(this.playbackTimer);
    this.playbackTimer = window.setTimeout(() => {
      for (const voice of this.voices.values()) {
        voice.player.configure(this.playback);
      }
    }, PLAYBACK_DEBOUNCE_MS);
  }

  addObject(id: number, buffer: AudioBuffer, closed: boolean): void {
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

    // A randomly-assigned degradation chain (see degradeMath.ts), crossfaded
    // in via this object's own degradeDry/degradeWet pair -- not the
    // chain's own internal effects' wet, which stay fully engaged once
    // built (see buildEffectsChain); only this outer pair is actually
    // distance-driven, in update() below. Each effect inside the chain is
    // its own instance (buildEffectsChain builds a fresh one per call), so
    // two objects sharing the same degrade type never share a node.
    const degradeChain = buildEffectsChain(
      this.audioContext,
      DEGRADE_CHAIN_SPECS[pickDegradeType()],
    );
    const degradeDry = this.audioContext.createGain();
    const degradeWet = this.audioContext.createGain();
    degradeDry.gain.value = 1;
    degradeWet.gain.value = 0;

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

    // filter -> [degradeDry, degradeChain] -> gain -> panner -> master:
    // the degrade chain sits before the direct/reverb split, in series,
    // not parallel to it -- degradeDry and degradeWet sum into the same
    // `gain` node the way two connections into one GainNode always do,
    // so `gain`'s own total*(1-wet) scaling below still applies to
    // whichever blend of clean/degraded signal that sum works out to.
    filter.connect(degradeDry).connect(gain);
    filter.connect(degradeChain.input);
    degradeChain.output.connect(degradeWet).connect(gain);
    gain.connect(panner).connect(this.master);
    // Reverb still taps the clean, pre-degradation signal -- keeping the
    // reverb tail itself unaffected by which chain a given object drew
    // keeps that established behavior/its own tests untouched.
    filter.connect(send).connect(this.reverb.input);

    // Starts playing straight away; silent until update() opens the gains.
    const player = new PassPlayer(
      this.audioContext,
      buffer,
      filter,
      this.playback,
    );
    const normalizationGain = normalizationGainForBuffer(buffer);
    this.voices.set(id, {
      player,
      filter,
      closed,
      gain,
      send,
      panner,
      normalizationGain,
      degradeChain,
      degradeDry,
      degradeWet,
    });
  }

  clearObjects(): void {
    for (const voice of this.voices.values()) {
      voice.player.stop();
      voice.filter.disconnect();
      voice.gain.disconnect();
      voice.send.disconnect();
      voice.panner.disconnect();
      voice.degradeDry.disconnect();
      voice.degradeWet.disconnect();
      voice.degradeChain.dispose();
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
        level *
        voice.normalizationGain *
        distanceGain(distance, room.hearingRange, ROLLOFF_EXPONENT);
      const reverbWet = reverbWetFraction(
        distance,
        room.hearingRange,
        this.reverbWetNear,
        this.reverbWetFar,
      );
      smooth(voice.gain.gain, total * (1 - reverbWet));
      smooth(voice.send.gain, total * reverbWet);
      // Its own independent near/far curve (see setDegradeMix) -- same
      // shape as reverb's own, "weak close, stronger far", just not tied
      // to the same wet value. Unlike gain/send, this pair isn't scaled by
      // `total`: it's a unity-power crossfade between clean and degraded
      // signal, not a loudness split, so the actual loudness scaling
      // stays entirely in voice.gain downstream of it.
      const degradeWet = reverbWetFraction(
        distance,
        room.hearingRange,
        this.degradeWetNear,
        this.degradeWetFar,
      );
      smooth(voice.degradeDry.gain, 1 - degradeWet);
      smooth(voice.degradeWet.gain, degradeWet);
      smooth(voice.panner.positionX, object.x);
      smooth(voice.panner.positionZ, object.y);
    }
  }
}
