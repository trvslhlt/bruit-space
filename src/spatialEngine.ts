import {
  PcmRecorder,
  ReverbEffect,
  type ReverbEffectParams,
  distanceGain,
  preloadPcmRecorderWorklet,
} from "bruit-kit/audio";
import { connectToOutput, getSharedLimiter } from "./audioContext";
import type { RoomState } from "./room";

// The reverb send falls off more gently than the direct signal (exponent 1
// vs 2 -- see spatialMath.ts), so as a source recedes its direct level
// drops faster than its reverb does. That shifting direct-to-reverberant
// ratio is the main cue for distance; no room geometry needed.
const DIRECT_ROLLOFF_EXPONENT = 2;
const REVERB_SEND_ROLLOFF_EXPONENT = 1;

// Applied to every position/gain change rather than assigning .value
// directly, which would step and click as the listener or a dragged object
// moves between animation frames.
const SMOOTHING_SECONDS = 0.03;

export const DEFAULT_MASTER_LEVEL = 0.4;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  send: GainNode;
  panner: PannerNode;
}

export class SpatialEngine {
  readonly recorder: PcmRecorder;
  private voices = new Map<number, Voice>();
  private master: GainNode;
  private reverb: ReverbEffect;
  private reverbReturn: GainNode;

  static async create(audioContext: AudioContext): Promise<SpatialEngine> {
    await preloadPcmRecorderWorklet(
      audioContext,
      "/worklets/pcm-recorder-processor.js",
    );
    return new SpatialEngine(audioContext);
  }

  private constructor(private audioContext: AudioContext) {
    // Headroom for many overlapping loops; the shared limiter after this is
    // a safety net, not the thing doing the level management. Full-scale
    // samples with several audible at once clip a recording at higher
    // settings -- see the "Master" slider for tuning by ear.
    this.master = audioContext.createGain();
    this.master.gain.value = DEFAULT_MASTER_LEVEL;
    connectToOutput(this.master, audioContext);

    this.reverb = new ReverbEffect(audioContext);
    // Fully wet: this is a send bus, the dry signal never goes through it.
    this.reverb.setParams({ wet: 1 });
    this.reverbReturn = audioContext.createGain();
    this.reverbReturn.gain.value = 0.5;
    this.reverb.output.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    // Tapped after the limiter so the recording is exactly what's heard.
    this.recorder = new PcmRecorder(
      audioContext,
      getSharedLimiter(audioContext).output,
    );
  }

  setReverb(params: Partial<Omit<ReverbEffectParams, "wet">>): void {
    this.reverb.setParams(params);
  }

  setMasterLevel(level: number): void {
    this.master.gain.setTargetAtTime(
      level,
      this.audioContext.currentTime,
      SMOOTHING_SECONDS,
    );
  }

  setReverbLevel(level: number): void {
    this.reverbReturn.gain.value = level;
  }

  addObject(id: number, buffer: AudioBuffer): void {
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

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

    source.connect(gain).connect(panner).connect(this.master);
    source.connect(send).connect(this.reverb.input);

    // Random start so loops of similar length don't begin phase-aligned.
    source.start(0, Math.random() * buffer.duration);
    this.voices.set(id, { source, gain, send, panner });
  }

  clearObjects(): void {
    for (const voice of this.voices.values()) {
      voice.source.stop();
      voice.source.disconnect();
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
      smooth(
        voice.gain.gain,
        level *
          distanceGain(distance, room.hearingRange, DIRECT_ROLLOFF_EXPONENT),
      );
      smooth(
        voice.send.gain,
        level *
          distanceGain(
            distance,
            room.hearingRange,
            REVERB_SEND_ROLLOFF_EXPONENT,
          ),
      );
      smooth(voice.panner.positionX, object.x);
      smooth(voice.panner.positionZ, object.y);
    }
  }
}
