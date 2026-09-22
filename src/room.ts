/** Room coordinates are metres, x rightward and y downward (screen
 * convention) with (0, 0) at the top-left corner. `heading` is radians
 * clockwise from "up" on the map, so 0 faces the top wall. */
export interface Listener {
  x: number;
  y: number;
  heading: number;
}

export interface SoundObject {
  id: number;
  name: string;
  x: number;
  y: number;
  /** Loudness, 0..1 -- the same distance curve applies to every object, so
   * a louder one is simply still audible from farther away. */
  gain: number;
  muted: boolean;
  /** Closed muffles the object with a lowpass; open is the unfiltered
   * sound. See SpatialEngine.setObjectClosed. */
  closed: boolean;
}

export interface RoomState {
  width: number;
  height: number;
  /** Distance at which every object falls to silence. */
  hearingRange: number;
  listener: Listener;
  objects: SoundObject[];
  selectedIds: Set<number>;
}

/** Every object whose position falls within the room-space rectangle
 * spanned by the two given corners (order doesn't matter) -- the marquee
 * select in roomView.ts's only real job, split out as pure math since it
 * doesn't need a canvas to test. */
export function objectsInRect(
  objects: SoundObject[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SoundObject[] {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return objects.filter(
    (o) => o.x >= minX && o.x <= maxX && o.y >= minY && o.y <= maxY,
  );
}

// Defaults for the Listener panel's Walk speed / Turn speed sliders --
// actual movement in main.ts's frame loop uses whatever those sliders are
// currently set to, not these directly.
export const DEFAULT_LISTENER_SPEED = 2; // metres/second
export const DEFAULT_LISTENER_TURN_RATE = Math.PI / 2; // radians/second

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampToRoom(
  room: RoomState,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: clamp(x, 0, room.width), y: clamp(y, 0, room.height) };
}

export function distanceToListener(
  room: RoomState,
  object: SoundObject,
): number {
  return Math.hypot(object.x - room.listener.x, object.y - room.listener.y);
}

/** How much of an object's sound is reverb rather than direct signal, from
 * 0 (all direct) to 1 (all reverb): `nearWet` when the listener is on top
 * of the object, `farWet` at the edge of hearing range, interpolated
 * linearly between (and held at `farWet` beyond it). */
export function reverbWetFraction(
  distance: number,
  hearingRange: number,
  nearWet: number,
  farWet: number,
): number {
  const t = hearingRange > 0 ? clamp(distance / hearingRange, 0, 1) : 1;
  return nearWet + (farWet - nearWet) * t;
}

/** A random spot at least `minDistanceFromListener` from the listener, so
 * nothing spawns right on top of them -- falls back to whatever the last
 * try was rather than looping forever in a room too small to satisfy it. */
export function randomObjectPosition(
  room: RoomState,
  minDistanceFromListener: number,
): { x: number; y: number } {
  const margin = 0.5;
  let x = 0;
  let y = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    x = margin + Math.random() * Math.max(room.width - 2 * margin, 0);
    y = margin + Math.random() * Math.max(room.height - 2 * margin, 0);
    if (
      Math.hypot(x - room.listener.x, y - room.listener.y) >=
      minDistanceFromListener
    ) {
      break;
    }
  }
  return { x, y };
}
