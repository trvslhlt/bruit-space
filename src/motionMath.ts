import { type DriftState, clamp } from "./room";

export type MotionMode = "none" | "drift" | "linear" | "vertical";
export type MotionBoundary = "bounce" | "wrap";

export interface MotionConfig {
  mode: MotionMode;
  boundary: MotionBoundary;
  minSpeed: number;
  maxSpeed: number;
}

export const DEFAULT_MOTION_MODE: MotionMode = "linear";
export const DEFAULT_MOTION_BOUNDARY: MotionBoundary = "bounce";
export const DEFAULT_MIN_SPEED = 0.3; // m/s -- gentle drift, tuned by ear
export const DEFAULT_MAX_SPEED = 1; // m/s

/** Heading drifts toward this before a fresh target is picked -- see
 * advanceDrift(). Radians. */
const DRIFT_ARRIVAL_RADIANS = 0.08;
/** How fast advanceDrift() can turn the heading, regardless of dt -- a
 * fixed rate rather than passMath.ts's WanderState's proportional glide:
 * an angle has no plain "remaining distance" to scale against without
 * separately handling wrap-around, and a constant turn rate already
 * reads as an organic drift once paired with re-picking the target on
 * arrival. */
const DRIFT_MAX_TURN_RADIANS_PER_SECOND = Math.PI / 4;

export function randomHeading(random: () => number = Math.random): number {
  return random() * Math.PI * 2;
}

/** A heading pointing straight up (0) or straight down (pi), picked with
 * even odds -- "vertical" mode's own restricted heading, since a plain
 * randomHeading() would give it a horizontal component. */
function randomVerticalHeading(random: () => number = Math.random): number {
  return random() < 0.5 ? 0 : Math.PI;
}

/** A fresh heading appropriate to `mode` (full-circle for drift/linear,
 * straight up or down for vertical), a speed inside [minSpeed, maxSpeed],
 * and a fresh drift target -- called once per object at creation time so
 * a room full of moving objects doesn't glide in lockstep even though
 * mode/boundary/speed-range are one shared config. */
export function randomMotionState(
  minSpeed: number,
  maxSpeed: number,
  mode: MotionMode,
  random: () => number = Math.random,
): { heading: number; speed: number; drift: DriftState } {
  return {
    heading:
      mode === "vertical"
        ? randomVerticalHeading(random)
        : randomHeading(random),
    speed: minSpeed + random() * Math.max(maxSpeed - minSpeed, 0),
    drift: { targetHeading: randomHeading(random) },
  };
}

/** Pulls an existing speed back inside a changed [minSpeed, maxSpeed]
 * range -- used when either speed slider moves, instead of re-rolling
 * every object's pace from scratch. */
export function clampSpeedToRange(
  speed: number,
  minSpeed: number,
  maxSpeed: number,
): number {
  return clamp(speed, minSpeed, maxSpeed);
}

/** Shortest signed angle from `from` to `to`, in (-pi, pi] -- so turning
 * "toward" a target never spins the long way around. */
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** One frame of drift: turns `heading` toward `drift.targetHeading` at a
 * fixed max rate, picking a fresh random target once the heading is
 * within DRIFT_ARRIVAL_RADIANS of it -- same "current value + a target it
 * drifts toward, re-picked on arrival" shape as passMath.ts's
 * WanderState, but a separate 2-D implementation: deliberately not named
 * (or typed) "wander" -- that name already means something unrelated
 * elsewhere in this app (playback sample-start-position drift). */
export function advanceDrift(
  heading: number,
  drift: DriftState,
  dt: number,
  random: () => number = Math.random,
): { heading: number; drift: DriftState } {
  const delta = angleDelta(heading, drift.targetHeading);
  const maxStep = DRIFT_MAX_TURN_RADIANS_PER_SECOND * dt;
  const nextHeading = heading + clamp(delta, -maxStep, maxStep);
  const arrived =
    Math.abs(angleDelta(nextHeading, drift.targetHeading)) <
    DRIFT_ARRIVAL_RADIANS;
  return {
    heading: nextHeading,
    drift: arrived ? { targetHeading: randomHeading(random) } : drift,
  };
}

export interface MotionStepResult {
  x: number;
  y: number;
  heading: number;
  drift: DriftState;
  /** True exactly when the boundary rule teleported the position this
   * frame (wrap only) -- spatialEngine.update() needs this to snap that
   * object's panner position instead of smoothing across the whole
   * room. */
  wrapped: boolean;
}

/** Reflects a position/heading pair off whichever walls it's crossed,
 * per axis independently -- exact for this app's dx=sin(h), dy=-cos(h)
 * convention: negating dx while holding dy is heading -> -heading;
 * negating dy while holding dx is heading -> pi - heading. Composes
 * correctly for a simultaneous corner hit since applying both in either
 * order yields the same heading mod 2*pi. */
function bounceStep(
  x0: number,
  y0: number,
  heading0: number,
  width: number,
  height: number,
): { x: number; y: number; heading: number } {
  let x = x0;
  let y = y0;
  let heading = heading0;
  if (x < 0) {
    x = -x;
    heading = -heading;
  } else if (x > width) {
    x = 2 * width - x;
    heading = -heading;
  }
  if (y < 0) {
    y = -y;
    heading = Math.PI - heading;
  } else if (y > height) {
    y = 2 * height - y;
    heading = Math.PI - heading;
  }
  return { x, y, heading };
}

/** Teleports a position past either edge to the opposite one. Heading is
 * untouched -- the object keeps travelling the same direction, it's the
 * room that's treated as looping. */
function wrapStep(
  x0: number,
  y0: number,
  width: number,
  height: number,
): { x: number; y: number; wrapped: boolean } {
  let x = x0;
  let y = y0;
  let wrapped = false;
  if (x < 0) {
    x += width;
    wrapped = true;
  } else if (x > width) {
    x -= width;
    wrapped = true;
  }
  if (y < 0) {
    y += height;
    wrapped = true;
  } else if (y > height) {
    y -= height;
    wrapped = true;
  }
  return { x, y, wrapped };
}

/** Snaps an arbitrary heading to straight up (0) or straight down (pi),
 * whichever it's closer to -- keeping "vertical" mode's own dx=sin(h)
 * exactly 0 (no horizontal drift, even from floating-point error) however
 * the object was heading before vertical mode took over (e.g. switched
 * over from linear or drift mid-flight). */
function toVerticalHeading(heading: number): number {
  return Math.cos(heading) >= 0 ? 0 : Math.PI;
}

/** One frame of self-motion for a single object: advances heading
 * (drift curves it; vertical snaps it to straight up/down; linear leaves
 * it untouched), integrates position at `speed` m/s along that heading
 * for `dt` seconds using the same sin(h)/-cos(h) convention main.ts's
 * frame() already uses for the listener, then applies the boundary rule.
 * Pure -- the caller writes the result back onto the real SoundObject. */
export function stepMotion(
  object: { x: number; y: number; heading: number; drift: DriftState },
  config: MotionConfig,
  speed: number,
  room: { width: number; height: number },
  dt: number,
  random: () => number = Math.random,
): MotionStepResult {
  const { heading, drift } =
    config.mode === "drift"
      ? advanceDrift(object.heading, object.drift, dt, random)
      : config.mode === "vertical"
        ? { heading: toVerticalHeading(object.heading), drift: object.drift }
        : { heading: object.heading, drift: object.drift };

  const x = object.x + Math.sin(heading) * speed * dt;
  const y = object.y - Math.cos(heading) * speed * dt;

  if (config.boundary === "wrap") {
    const wrapped = wrapStep(x, y, room.width, room.height);
    return {
      x: wrapped.x,
      y: wrapped.y,
      heading,
      drift,
      wrapped: wrapped.wrapped,
    };
  }
  const bounced = bounceStep(x, y, heading, room.width, room.height);
  return { ...bounced, drift, wrapped: false };
}
